import { create } from "zustand";
import type {
  CardMode,
  LocalShellKind,
  Protocol,
  RdpLaunchResult,
  RdpRuntimeStatus,
  SerialProfileConfig,
  Session,
  TabStatus,
} from "../types/ipc";
import {
  closeConnection,
  closeTerminal,
  closeSerial,
  connectSession,
  createCard,
  closeCard,
  setCardMode,
  openSerial,
  forwardList,
  forwardStart,
  launchRdp,
  rdpGetStatus,
  rdpClose,
  writeTerminal,
  sendSerial,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { encodeTextForSession } from "../lib/terminal-actions";
import { expireSerialSendEpoch } from "./serialStore";

export interface ConnectOverrides {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  passphrase?: string;
}

export interface TerminalTab {
  tabId: string;
  sessionId: string;
  sessionName: string;
  protocol: Protocol;
  connectionId: string | null;
  cardId?: string;
  currentMode: CardMode;
  status: TabStatus;
  error?: string;
  /** 远端上报的进程退出码；未知时为 null（不再伪造 0） */
  exitCode?: number | null;
  baudRate?: number;
  /** Windows 远程桌面会话：最近一次 rdp_launch 的结果（进程 PID、临时 .rdp 路径等） */
  rdpInfo?: RdpLaunchResult | null;
  /**
   * 远程桌面阶段。mstsc 启动成功不代表远程桌面已经连上，
   * 在 gpt 提供真实连接状态（rdp_get_status）之前，绝不把启动当成 connected。
   */
  rdpPhase?: "starting" | "launched" | "failed" | null;
  /** 仅记录本地客户端唤起时间，不代表远端在线时长 */
  rdpLaunchedAt?: number | null;
  /** 串口会话首次打开时的完整配置，重连时必须原样复用 */
  serialConfig?: SerialProfileConfig;
  /** 本地终端会话：使用的 shell 类型（powershell / cmd / wsl ...） */
  shellKind?: LocalShellKind | null;
  /** 连接就绪时间戳（毫秒），供连接详情面板计算实时在线时长 */
  connectedAt?: number | null;
  /** 当前自动重连尝试次数 */
  reconnectAttempt?: number;
}

/** FinalShell 风格命令历史：最多保留最近 50 条，持久化在 localStorage */
const COMMAND_HISTORY_KEY = "openshell:cmd_history";
const COMMAND_HISTORY_LIMIT = 50;

function readCommandHistory(): string[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(COMMAND_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, COMMAND_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeCommandHistory(list: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用（隐私模式 / 配额已满）时仅保留内存态历史
  }
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 支持「命令输入栏」直接写入的终端类协议 */
const COMMAND_TARGET_PROTOCOLS: Protocol[] = ["ssh", "sftp", "local_shell", "telnet", "serial"];

// 后端以 26 位 ULID 校验终端标签 ID，这里生成同格式 ID，
// 否则打开终端时会被判定为“格式有误”。
const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateId(): string {
  let id = "";
  let time = Date.now();
  for (let i = 9; i >= 0; i--) {
    id = ULID_CHARS[time % 32] + id;
    time = Math.floor(time / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  for (let i = 0; i < 16; i++) {
    id += ULID_CHARS[random[i] % 32];
  }
  return id;
}

/**
 * 断线清理是异步的：用户可能在上一条连接还没释放完时就按回车重连。
 * 用按 tabId 记录的清理 Promise 串行化，避免「旧 PTY/旧连接释放」与「新连接建立」并发，
 * 导致刚建好的 PTY 被旧清理逻辑关掉，留下僵尸会话。
 */
const pendingTeardown = new Map<string, Promise<void>>();

/**
 * 连接代次：按标签记录当前连接身份。关闭、重连开始、断开都会递增，
 * 异步操作在写入前必须复核自己捕获的代次，避免迟到结果/旧发送落到新连接。
 * 放在模块级 Map（与 pendingTeardown、rdpPollers 同层），不进 store state、
 * 不进共享 DTO；未经任何 action 的静态测试 fixture 缺省按 0 处理，无需复位点。
 * 串口与 RDP 的 connectionId 恒为 null，同 cardId 重开只能靠这里区分。
 */
const connectionEpochs = new Map<string, number>();

function currentConnectionEpoch(tabId: string): number {
  return connectionEpochs.get(tabId) ?? 0;
}

function bumpConnectionEpoch(tabId: string): number {
  const next = currentConnectionEpoch(tabId) + 1;
  connectionEpochs.set(tabId, next);
  return next;
}

function isCurrentConnectionEpoch(tabId: string, epoch: number): boolean {
  return currentConnectionEpoch(tabId) === epoch;
}

/** 编码/异步等待期间目标连接已变化：本次发送主动取消，不写入新连接 */
class StaleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleTargetError";
  }
}

/** 清理失败但仍需释放的 RDP 实例：保留 launch_id 所有权，供界面显式重试 */
export interface RdpCleanupFailure {
  tabId: string;
  launchId: string;
  error: string;
}

/**
 * rdpClose 失败时不能 .catch 吞掉 launch_id，也不能只靠应用退出兜底。
 * 记录所有权与可见错误（不写回 tab.error，避免旧失败污染已接管的新连接界面），
 * 由 retryRdpCleanups 对同一 launch_id 重新发起真实关闭。
 */
function recordRdpCleanupFailure(tabId: string, launchId: string, error: unknown): void {
  const message = formatFriendlyError(error);
  useTerminalStore.setState((state) => ({
    rdpCleanupFailures: [
      ...state.rdpCleanupFailures.filter((item) => item.launchId !== launchId),
      { tabId, launchId, error: message },
    ],
  }));
}

/** 断线自动重连定时器：按标签 ID 记录，手动重连/关闭标签/连接成功时统一清理 */
const autoReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAutoReconnectTimer(tabId: string): void {
  const timer = autoReconnectTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoReconnectTimers.delete(tabId);
  }
}

/** 支持断线自动重连的协议（RDP 由 mstsc 承载，本地终端无远端连接） */
const AUTO_RECONNECT_PROTOCOLS: Protocol[] = ["ssh", "sftp", "telnet", "serial"];

/**
 * 串口配置必须显式指定端口，缺失时绝不能回退到 COM1 或 Mock，
 * 否则会悄悄连上用户没有选择的设备。
 */
function readSerialProfileConfig(raw: unknown): SerialProfileConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const config = raw as Partial<SerialProfileConfig>;
  const portName = typeof config.port_name === "string" ? config.port_name.trim() : "";
  if (!portName) return null;
  const baudRate =
    typeof config.baud_rate === "number" && config.baud_rate > 0 ? config.baud_rate : 115200;
  return { ...(config as SerialProfileConfig), port_name: portName, baud_rate: baudRate };
}

function releaseTab(tabId: string, connectionId?: string | null): Promise<void> {
  const task = (async () => {
    await closeTerminal(tabId).catch(() => {});
    if (connectionId) await closeConnection(connectionId).catch(() => {});
  })();
  pendingTeardown.set(tabId, task);
  void task.finally(() => {
    if (pendingTeardown.get(tabId) === task) pendingTeardown.delete(tabId);
  });
  return task;
}

/**
 * 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则。
 * 单条规则失败（如本地端口被占用）不影响 SSH 会话本身。
 */
async function startAutoForwardRules(sessionId: string, connectionId: string) {
  try {
    const rules = await forwardList(sessionId);
    for (const rule of rules) {
      if (!rule.auto_start) continue;
      await forwardStart(rule.id, connectionId).catch((e) => {
        console.warn(`auto start forward rule failed: ${rule.id}`, e);
      });
    }
  } catch {
    // 没有规则或后端不可用时忽略
  }
}

/** 会话工作区布局：全终端 / 上下分屏 / 全 SFTP（唯一的一套 SFTP 视图入口） */
export type SessionViewMode = "terminal" | "split" | "sftp";

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** 布局模式放在 store 里，才能被顶栏、标签栏、会话树等多处入口共享 */
  layoutMode: SessionViewMode;
  setLayoutMode: (mode: SessionViewMode) => void;
  /** 上下分屏中终端区占比（0–1），默认 0.58 */
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
  /** 终端全屏沉浸模式 */
  isFullscreen: boolean;
  setFullscreen: (fullscreen: boolean) => void;
  toggleFullscreen: () => void;

  /** 按协议分发打开会话（ssh / sftp / rdp / local_shell / telnet / serial） */
  openSessionTab: (session: Session, overrides?: ConnectOverrides) => Promise<string>;
  /** 兼容旧调用点：等价于 openSessionTab */
  openSession: (session: Session, overrides?: ConnectOverrides) => Promise<string>;
  /** 秒开临时本地终端（不落库），供标签栏 + 菜单使用 */
  openQuickLocalShell: (shellKind?: LocalShellKind) => Promise<void>;

  /** FinalShell 命令输入栏历史命令（localStorage 持久化） */
  commandHistory: string[];
  addCommandHistory: (cmd: string) => void;
  clearCommandHistory: () => void;
  /** 把命令写入当前会话或全部已连接会话 */
  sendCommandToTabs: (
    command: string,
    options?: { allTabs?: boolean; appendCr?: boolean }
  ) => Promise<void>;
  /**
   * 向单个目标标签发送文本：按该会话的编码转换，串口走 sendSerial，其余走 writeTerminal。
   * 不增删换行、不写命令历史、不改变 activeTabId；目标不可用或发送失败必须 reject。
   */
  sendTextToTab: (tabId: string, text: string) => Promise<void>;

  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  switchMode: (tabId: string, mode: CardMode) => Promise<void>;
  toggleMode: (tabId: string) => Promise<void>;
  reconnectTab: (tabId: string, overrides?: ConnectOverrides) => Promise<void>;
  /**
   * 标记标签已断开；若会话启用了 auto_reconnect，则按指数退避安排自动重连。
   */
  markDisconnected: (tabId: string, reason?: string, exitCode?: number | null) => void;
  /** 取消该标签的自动重连定时器，并把 reconnecting 状态退回 disconnected */
  cancelAutoReconnect: (tabId: string) => void;
  updateTabStatus: (tabId: string, status: TabStatus, error?: string) => void;
  renameTab: (tabId: string, newName: string) => void;
  duplicateTab: (tabId: string) => Promise<string | null>;
  reorderTabs: (sourceIndex: number, destinationIndex: number) => void;
  /** 清理失败但仍持有 launch_id 的 RDP 实例，供界面展示错误并显式重试 */
  rdpCleanupFailures: RdpCleanupFailure[];
  retryRdpCleanups: () => Promise<void>;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  // FinalShell 经典布局：SSH 会话默认「上终端 + 中命令栏 + 下 SFTP」上下分屏
  layoutMode: "split",
  splitRatio: 0.58,
  isFullscreen: false,
  commandHistory: readCommandHistory(),
  rdpCleanupFailures: [],

  setLayoutMode: (layoutMode) => set({ layoutMode }),
  setSplitRatio: (splitRatio) => set({ splitRatio: Math.min(0.85, Math.max(0.15, splitRatio)) }),
  setFullscreen: (isFullscreen) => set({ isFullscreen }),
  toggleFullscreen: () => set((state) => ({ isFullscreen: !state.isFullscreen })),

  openSessionTab: async (session: Session, overrides?: ConnectOverrides) => {
    const tabId = generateId();
    const protocol: Protocol = session.protocol || "ssh";

    const shellKind: LocalShellKind | null =
      protocol === "local_shell"
        ? ((session.protocol_options_json as { shell_kind?: LocalShellKind } | null)?.shell_kind ??
          "powershell")
        : null;

    let cardId: string | undefined;
    // 资源卡只对 SSH / SFTP / 串口这类有后端资源视图的会话有意义；
    // RDP 与临时本地终端不做建卡，避免无谓的后端失败日志。
    if (protocol === "ssh" || protocol === "sftp" || protocol === "serial") {
      try {
        const card = await createCard(session.id);
        cardId = card.card_id;
      } catch (e) {
        console.warn("createCard fallback to local tab", e);
      }
    }

    const newTab: TerminalTab = {
      tabId,
      sessionId: session.id,
      sessionName: session.name,
      protocol,
      connectionId: null,
      cardId,
      currentMode: "command",
      status: "connecting",
      baudRate: session.protocol_options_json?.baud_rate || 115200,
      rdpInfo: null,
      rdpPhase: protocol === "rdp" ? "starting" : null,
      rdpLaunchedAt: null,
      serialConfig:
        protocol === "serial" ? readSerialProfileConfig(session.protocol_options_json) ?? undefined : undefined,
      shellKind,
      connectedAt: null,
      reconnectAttempt: 0,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }));

    // 本地终端：没有握手过程，直接标记已连接，由 XtermView 挂载后建立流
    if (protocol === "local_shell") {
      const connectionId = "local-" + generateUuid();
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                connectionId,
                status: "connected" as TabStatus,
                connectedAt: Date.now(),
                reconnectAttempt: 0,
              }
            : t
        ),
      }));
      return tabId;
    }

    // Telnet：同样由 XtermView 挂载后通过 telnet_open 建立流
    if (protocol === "telnet") {
      const connectionId = "telnet-" + generateUuid();
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                connectionId,
                status: "connected" as TabStatus,
                connectedAt: Date.now(),
                reconnectAttempt: 0,
              }
            : t
        ),
      }));
      return tabId;
    }

    // Windows 远程桌面：生成 .rdp 并唤起 mstsc.exe。mstsc 启动成功不代表远端已连上，
    // 在拿到真实连接状态前只标记 launched，绝不写 connected / connectedAt。
    if (protocol === "rdp") {
      try {
        const rdpInfo = await launchRdp(session.id);
        if (!get().tabs.some((item) => item.tabId === tabId)) {
          // 启动请求迟到且标签已被关闭：释放刚刚创建的实例，避免遗留自有进程。
          // 关闭失败时保留 launch_id 所有权与可见错误，供显式重试，不靠应用退出兜底。
          try {
            await rdpClose(rdpInfo.launch_id);
          } catch (e) {
            recordRdpCleanupFailure(tabId, rdpInfo.launch_id, e);
          }
          return tabId;
        }
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  rdpInfo,
                  rdpPhase: "launched" as const,
                  rdpLaunchedAt: Date.now(),
                  status: "connecting" as TabStatus,
                  error: undefined,
                  connectedAt: null,
                  reconnectAttempt: 0,
                }
              : t
          ),
        }));
        // 只有 rdp_get_status 回传 connected（native OnLoginComplete）才算真正连上
        startRdpPolling(tabId, rdpInfo.launch_id);
      } catch (err: any) {
        const errMsg = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error" as TabStatus,
                  rdpInfo: null,
                  rdpPhase: "failed" as const,
                  rdpLaunchedAt: null,
                  connectedAt: null,
                  error: errMsg,
                }
              : t
          ),
        }));
      }
      return tabId;
    }

    if (protocol === "serial") {
      const serialConfig = readSerialProfileConfig(session.protocol_options_json);
      if (!serialConfig) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error" as TabStatus,
                  connectionId: null,
                  error: "串口会话未配置端口号，请先编辑会话并选择端口",
                  serialConfig: undefined,
                }
              : t
          ),
        }));
        return tabId;
      }

      const activeCardId = cardId || tabId;
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? { ...t, serialConfig, baudRate: serialConfig.baud_rate }
            : t
        ),
      }));

      try {
        // 只尝试一次真实串口，绝不回退 Mock；失败必须让用户看到并自行重试。
        await openSerial(activeCardId, serialConfig, false);
        if (!get().tabs.some((item) => item.tabId === tabId)) {
          await closeSerial(activeCardId).catch(() => {});
          return tabId;
        }

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "connected",
                  error: undefined,
                  connectedAt: Date.now(),
                  reconnectAttempt: 0,
                }
              : t
          ),
        }));

        // 串口视图（ASCII/HEX）在断开时保留订阅，重连成功后原地恢复 RX 轮询
        const { resumeSerialRead } = await import("./serialStore");
        resumeSerialRead(activeCardId);

        return tabId;
      } catch (err: any) {
        const errMsg = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error",
                  connectionId: null,
                  error: errMsg,
                }
              : t
          ),
        }));
        return tabId;
      }
    } else {
      // SSH 模式
      try {
        const requestId = "req_" + generateId();
        const res = await connectSession(requestId, session.id, overrides);
        if (!get().tabs.some((item) => item.tabId === tabId)) {
          await closeConnection(res.connection_id).catch(() => {});
          return tabId;
        }

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  connectionId: res.connection_id,
                  status: "connected",
                  error: undefined,
                  connectedAt: Date.now(),
                  reconnectAttempt: 0,
                }
              : t
          ),
        }));

        // 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则
        await startAutoForwardRules(session.id, res.connection_id);

        return tabId;
      } catch (err: any) {
        const errMsg = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error",
                  connectionId: null,
                  error: errMsg,
                }
              : t
          ),
        }));
        get().markDisconnected(tabId, errMsg);
        return tabId;
      }
    }
  },

  openSession: async (session: Session, overrides?: ConnectOverrides) =>
    get().openSessionTab(session, overrides),

  openQuickLocalShell: async (shellKind: LocalShellKind = "powershell") => {
    const tabId = generateId();
    const label =
      shellKind === "cmd"
        ? "本地终端 (CMD)"
        : shellKind === "pwsh"
          ? "本地终端 (PowerShell 7)"
          : "本地终端 (PowerShell)";

    const tab: TerminalTab = {
      tabId,
      // 临时终端不落库，sessionId 用固定前缀标记，XtermView 据此不传 session_id
      sessionId: "quick-local-" + Date.now(),
      sessionName: label,
      protocol: "local_shell",
      connectionId: "local-" + generateUuid(),
      currentMode: "command",
      status: "connected",
      rdpInfo: null,
      shellKind,
      connectedAt: Date.now(),
      reconnectAttempt: 0,
    };

    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tabId }));
  },

  addCommandHistory: (cmd: string) => {
    const value = cmd.trim();
    if (!value) return;
    set((state) => {
      const next = [value, ...state.commandHistory.filter((item) => item !== value)].slice(
        0,
        COMMAND_HISTORY_LIMIT
      );
      writeCommandHistory(next);
      return { commandHistory: next };
    });
  },

  clearCommandHistory: () => {
    writeCommandHistory([]);
    set({ commandHistory: [] });
  },

  retryRdpCleanups: async () => {
    // 只重试记录中的 launch_id；成功后移除所有权，失败则保留并更新可见错误。
    for (const item of [...get().rdpCleanupFailures]) {
      try {
        await rdpClose(item.launchId);
        set((state) => ({
          rdpCleanupFailures: state.rdpCleanupFailures.filter(
            (failure) => failure.launchId !== item.launchId
          ),
        }));
      } catch (e) {
        const message = formatFriendlyError(e);
        set((state) => ({
          rdpCleanupFailures: state.rdpCleanupFailures.map((failure) =>
            failure.launchId === item.launchId ? { ...failure, error: message } : failure
          ),
        }));
      }
    }
  },

  sendTextToTab: async (tabId, text) => {
    const tab = get().tabs.find((item) => item.tabId === tabId);
    if (!tab) throw new Error("目标标签不存在或已关闭");
    if (tab.status !== "connected" || !COMMAND_TARGET_PROTOCOLS.includes(tab.protocol)) {
      throw new Error(`目标标签当前不可发送：${tab.sessionName}`);
    }

    // 入口冻结连接代次与身份；串口用 cardId，其余用 connectionId。
    const epoch = currentConnectionEpoch(tabId);
    const capturedProtocol = tab.protocol;
    const capturedConnectionId = tab.connectionId;
    const capturedCardId = tab.cardId || tab.tabId;

    const identityUnchanged = (live: TerminalTab): boolean =>
      live.protocol === capturedProtocol &&
      isCurrentConnectionEpoch(tabId, epoch) &&
      (capturedProtocol !== "serial" || (live.cardId || live.tabId) === capturedCardId) &&
      (capturedProtocol === "serial" || live.connectionId === capturedConnectionId);
    const stale = () => new StaleTargetError("目标标签连接已变更，本次发送已取消");
    const assertCurrent = (): TerminalTab => {
      const live = get().tabs.find((item) => item.tabId === tabId);
      if (!live || !identityUnchanged(live) || live.status !== "connected") throw stale();
      return live;
    };

    try {
      // import / 编码 / 写入的每个 await 的 resolve 与 reject 都按所属代次校验。
      const { useSessionStore } = await import("./sessionStore");
      assertCurrent();
      const encoding = useSessionStore
        .getState()
        .sessions.find((item) => item.id === tab.sessionId)?.encoding;
      const bytes = await encodeTextForSession(text, encoding);
      const live = assertCurrent();
      if (live.protocol === "serial") {
        await sendSerial(live.cardId || live.tabId, Array.from(bytes));
      } else {
        await writeTerminal(live.tabId, bytes);
      }
      assertCurrent();
    } catch (err) {
      if (err instanceof StaleTargetError) throw err;
      // 代次/身份已变的旧 import、编码或写入拒绝归一为主动取消，调用者才不会
      // 把新连接标记成断开；当前代次的真实失败照常上报，不吞错。
      const live = get().tabs.find((item) => item.tabId === tabId);
      if (!live || !identityUnchanged(live)) throw stale();
      throw err;
    }
  },

  sendCommandToTabs: async (command, options) => {
    const appendCr = options?.appendCr !== false;
    const payload = appendCr ? `${command}\r` : command;

    const state = get();
    const eligible = options?.allTabs
      ? state.tabs.filter(
          (tab) => tab.status === "connected" && COMMAND_TARGET_PROTOCOLS.includes(tab.protocol)
        )
      : state.tabs.filter(
          (tab) =>
            tab.tabId === state.activeTabId &&
            tab.status === "connected" &&
            COMMAND_TARGET_PROTOCOLS.includes(tab.protocol)
        );
    // 进入时冻结完整目标集合及各自身份/代次。顺序 await 期间才捕获 epoch 会让
    // 在 A 等待时重连的 B 领到旧广播；冻结后既不扩大目标集，也不接收新身份。
    const targets = eligible.map((tab) => ({
      tabId: tab.tabId,
      protocol: tab.protocol,
      connectionId: tab.connectionId,
      cardId: tab.cardId || tab.tabId,
      epoch: currentConnectionEpoch(tab.tabId),
    }));
    const matches = (target: (typeof targets)[number]): boolean => {
      const live = get().tabs.find((item) => item.tabId === target.tabId);
      return (
        !!live &&
        live.status === "connected" &&
        live.protocol === target.protocol &&
        isCurrentConnectionEpoch(target.tabId, target.epoch) &&
        (target.protocol !== "serial" || (live.cardId || live.tabId) === target.cardId) &&
        (target.protocol === "serial" || live.connectionId === target.connectionId)
      );
    };

    for (const target of targets) {
      if (!matches(target)) continue;
      try {
        // 统一走按会话编码的单目标发送入口，不再各调用点直接 UTF-8 写 PTY
        await get().sendTextToTab(target.tabId, payload);
      } catch (e) {
        // 目标在发送期间已关闭/重连：旧失败不能打到新连接或新界面上
        if (!matches(target)) continue;
        console.warn(`sendCommandToTabs: 写入 ${target.tabId} 失败`, e);
        const message = formatFriendlyError(e);
        set((current) => ({
          tabs: current.tabs.map((t) => (t.tabId === target.tabId ? { ...t, error: message } : t)),
        }));
      }
    }
  },

  switchMode: async (tabId, mode) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    if (tab.protocol === "serial" && mode === "view") {
      // 串口视图卡禁止切到视图模式（spec/session-card.md）
      return;
    }

    if (tab.cardId) {
      try {
        await setCardMode(tab.cardId, mode);
      } catch (e) {
        console.warn("setCardMode error", e);
      }
    }

    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, currentMode: mode } : t)),
    }));
  },

  toggleMode: async (tabId) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab || tab.protocol === "serial") return;
    const nextMode: CardMode = tab.currentMode === "command" ? "view" : "command";
    await get().switchMode(tabId, nextMode);
  },

  reconnectTab: async (tabId: string, overrides?: ConnectOverrides) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    const isRdp = tab.protocol === "rdp";
    // RDP 的 launched/已连接状态也允许重启（mstsc 已唤起但连接状态仍是 connecting）
    const rdpRestartable =
      isRdp &&
      (tab.rdpPhase === "launched" ||
        tab.status === "connected" ||
        tab.status === "disconnected" ||
        tab.status === "error");
    if (!rdpRestartable && tab.status === "connecting") return;
    if (!isRdp && tab.status === "connected") return;

    // 第一个 await 之前同步领取代次：在途的旧发送与上一轮重连结果立即失效，
    // 后续每个 await 都要复核「代次仍是本轮且标签仍存在」。
    const generation = bumpConnectionEpoch(tabId);
    const isCurrent = () =>
      isCurrentConnectionEpoch(tabId, generation) &&
      get().tabs.some((item) => item.tabId === tabId);

    // 手动/自动重连启动时取消尚未触发的下一次退避定时器
    clearAutoReconnectTimer(tabId);

    // RDP：先停掉状态轮询并关闭本标签自有的 mstsc 实例，再启动新实例。
    // 只关闭 tab.rdpInfo 记录的 launch_id，不能按 session 误杀其他标签的实例。
    if (isRdp) {
      stopRdpPolling(tabId);
      // 同步标记重启中：旧 launch_id 未更换前就不再显示 launched，
      // RdpSessionView 的 busy 随之生效，同 tab 的第二次点击被上面的早退挡住。
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                rdpPhase: "starting" as const,
                status: "connecting" as TabStatus,
                connectedAt: null,
                error: undefined,
              }
            : t
        ),
      }));
      const previousLaunchId = tab.rdpInfo?.launch_id;
      if (previousLaunchId) {
        try {
          await rdpClose(previousLaunchId);
        } catch (e) {
          // 关闭失败必须可见且可重试：不启动新实例，保留旧 launch_id，
          // 让重试和 closeTab 都还能释放它，避免静默遗留孤立实例。
          if (isCurrent()) {
            const message = formatFriendlyError(e);
            set((state) => ({
              tabs: state.tabs.map((t) =>
                t.tabId === tabId
                  ? {
                      ...t,
                      status: "error" as TabStatus,
                      rdpPhase: "failed" as const,
                      rdpLaunchedAt: null,
                      connectedAt: null,
                      error: `关闭旧远程桌面实例失败：${message}；可点击重新唤起重试`,
                    }
                  : t
              ),
            }));
          }
          return;
        }
      }
    }

    // 串口：重连前停止旧定时发送与 RX 轮询，避免旧任务在新连接上继续发送；
    // 订阅关系保留，重连成功后由 resumeSerialRead 原地恢复。
    if (tab.protocol === "serial") {
      const { pauseSerialRead, stopSerialSendTimer } = await import("./serialStore");
      if (!isCurrent()) return;
      stopSerialSendTimer();
      pauseSerialRead(tab.cardId || tab.tabId);
    }

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connecting",
              connectionId: null,
              error: undefined,
              connectedAt: null,
            }
          : t
      ),
    }));

    // 先等断线清理落盘，再释放旧 PTY，避免与新连接复用同一标签 ID 时互相踩踏。
    await pendingTeardown.get(tabId);
    await releaseTab(tabId, tab.connectionId);
    if (!isCurrent()) return;

    // Windows 远程桌面：重新生成 .rdp 并唤起 mstsc.exe；启动成功仍不等于远端已连接。
    if (tab.protocol === "rdp") {
      try {
        const rdpInfo = await launchRdp(tab.sessionId);
        if (!isCurrent()) {
          // 迟到或被替代的实例必须释放，不能写进标签状态。
          // 清理失败保留 launch_id 所有权与可见错误，不覆盖新代次状态。
          try {
            await rdpClose(rdpInfo.launch_id);
          } catch (e) {
            recordRdpCleanupFailure(tabId, rdpInfo.launch_id, e);
          }
          return;
        }
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  rdpInfo,
                  rdpPhase: "launched" as const,
                  rdpLaunchedAt: Date.now(),
                  status: "connecting" as TabStatus,
                  error: undefined,
                  connectedAt: null,
                  reconnectAttempt: 0,
                }
              : t
          ),
        }));
        startRdpPolling(tabId, rdpInfo.launch_id);
      } catch (err: any) {
        // 旧代次的失败不能覆盖新代次已经写入的状态
        if (!isCurrent()) return;
        const message = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error" as TabStatus,
                  rdpInfo: null,
                  rdpPhase: "failed" as const,
                  rdpLaunchedAt: null,
                  connectedAt: null,
                  error: message,
                }
              : t
          ),
        }));
      }
      return;
    }

    // 本地终端 / Telnet：刷新下行通道标识即可让 XtermView 重新建立流
    if (tab.protocol === "local_shell" || tab.protocol === "telnet") {
      const connectionId =
        (tab.protocol === "local_shell" ? "local-" : "telnet-") + generateUuid();
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                connectionId,
                status: "connected" as TabStatus,
                error: undefined,
                exitCode: null,
                connectedAt: Date.now(),
                reconnectAttempt: 0,
              }
            : t
        ),
      }));
      return;
    }

    if (tab.protocol === "serial") {
      let serialConfig = tab.serialConfig ?? null;
      if (!serialConfig) {
        const { useSessionStore } = await import("./sessionStore");
        const session = useSessionStore
          .getState()
          .sessions.find((item) => item.id === tab.sessionId);
        serialConfig = readSerialProfileConfig(session?.protocol_options_json);
      }

      // 配置缺失时不能猜端口，更不能回退 COM1/Mock；停止本轮重连并明确报错。
      if (!serialConfig) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error" as TabStatus,
                  connectionId: null,
                  error: "串口配置缺失：未指定端口，已停止重连",
                  connectedAt: null,
                }
              : t
          ),
        }));
        return;
      }

      const activeCardId = tab.cardId || tab.tabId;
      try {
        // 设备异常时旧句柄可能仍处于打开状态；先释放再按原配置重开。
        await closeSerial(activeCardId).catch(() => {});
        await openSerial(activeCardId, serialConfig, false);
        if (!isCurrent()) {
          await closeSerial(activeCardId).catch(() => {});
          return;
        }
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "connected",
                  error: undefined,
                  serialConfig,
                  baudRate: serialConfig.baud_rate,
                  connectedAt: Date.now(),
                  reconnectAttempt: 0,
                }
              : t
          ),
        }));
        const { resumeSerialRead } = await import("./serialStore");
        if (!isCurrent()) return;
        resumeSerialRead(activeCardId);
      } catch (err: any) {
        if (!isCurrent()) return;
        const message = formatFriendlyError(err);
        get().markDisconnected(tabId, message);
      }
      return;
    }

    try {
      const requestId = "req_" + generateId();
      const res = await connectSession(requestId, tab.sessionId, overrides);
      if (!isCurrent()) {
        await closeConnection(res.connection_id).catch(() => {});
        return;
      }
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                connectionId: res.connection_id,
                status: "connected",
                error: undefined,
                exitCode: null,
                connectedAt: Date.now(),
                reconnectAttempt: 0,
              }
            : t
        ),
      }));
      // 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则
      await startAutoForwardRules(tab.sessionId, res.connection_id);
    } catch (err: any) {
      if (!isCurrent()) return;
      const message = formatFriendlyError(err);
      get().markDisconnected(tabId, message);
    }
  },

  markDisconnected: (tabId, reason, exitCode) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    // 旧连接身份终止：在途发送/重连结果立即失效
    bumpConnectionEpoch(tabId);
    clearAutoReconnectTimer(tabId);

    // 远程桌面被动断开/退出时停止状态轮询，避免迟到的 connected 结果复活会话
    if (tab.protocol === "rdp") stopRdpPolling(tabId);

    // 串口被动断开：停止定时发送并暂停 RX 轮询；订阅保留，重连成功后恢复。
    if (tab.protocol === "serial") {
      void import("./serialStore").then(({ pauseSerialRead, stopSerialSendTimer }) => {
        stopSerialSendTimer();
        pauseSerialRead(tab.cardId || tab.tabId);
      });
    }

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "disconnected",
              connectionId: null,
              error: reason,
              exitCode: exitCode ?? t.exitCode ?? null,
              connectedAt: null,
            }
          : t
      ),
    }));

    void releaseTab(tabId, tab.connectionId);

    // 被动断开且会话启用 auto_reconnect 时，按退避间隔安排一次自动重连。
    // sessionStore 动态引入，避免与 sessionStore -> terminalStore 的静态依赖成环。
    void (async () => {
      try {
        const { useSessionStore } = await import("./sessionStore");
        const session = useSessionStore
          .getState()
          .sessions.find((item) => item.id === tab.sessionId);
        const live = get().tabs.find((t) => t.tabId === tabId);
        // 等待会话查询期间用户可能已手动重连、取消或关闭标签
        if (!live || live.status !== "disconnected") return;
        if (!AUTO_RECONNECT_PROTOCOLS.includes(tab.protocol)) return;
        if (!session?.auto_reconnect) return;

        const maxAttempts = Math.max(1, session.reconnect_max ?? 5);
        const attempt = live.reconnectAttempt ?? 0;
        if (attempt >= maxAttempts) {
          // 已达到上限：彻底失败，清零计数等待用户手动处理
          set((state) => ({
            tabs: state.tabs.map((t) =>
              t.tabId === tabId ? { ...t, status: "error", reconnectAttempt: 0 } : t
            ),
          }));
          return;
        }

        const nextAttempt = attempt + 1;
        const delayMs = Math.min(10000, nextAttempt * 2000);

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "reconnecting",
                  reconnectAttempt: nextAttempt,
                  error: reason,
                  connectedAt: null,
                }
              : t
          ),
        }));

        clearAutoReconnectTimer(tabId);
        const timer = setTimeout(() => {
          autoReconnectTimers.delete(tabId);
          const current = get().tabs.find((t) => t.tabId === tabId);
          if (current && current.status === "reconnecting") {
            void get().reconnectTab(tabId);
          }
        }, delayMs);
        autoReconnectTimers.set(tabId, timer);
      } catch (e) {
        console.warn("markDisconnected: schedule auto reconnect failed", e);
      }
    })();
  },

  cancelAutoReconnect: (tabId) => {
    clearAutoReconnectTimer(tabId);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId && t.status === "reconnecting"
          ? { ...t, status: "disconnected" }
          : t
      ),
    }));
  },

  closeTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    // 标签身份消失：在途发送与尚未完成的重连结果立即失效
    bumpConnectionEpoch(tabId);
    clearAutoReconnectTimer(tabId);
    // 关闭标签先停掉该标签的状态轮询，防止标签移除后仍被迟到结果复活
    stopRdpPolling(tabId);

    // 串口必须在第一个 await 之前同步作废在途发送：closeCard 可能长时间 pending，
    // 等 teardownSerialSession 再失效会让旧编码结果写进旧句柄或重开的同 cardId 句柄。
    if (tab.protocol === "serial") {
      expireSerialSendEpoch(tab.cardId || tab.tabId);
    }

    // 先移除标签，让仍在连接中的响应立即失效，再异步释放资源。
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.tabId !== tabId);
      return {
        tabs: nextTabs,
        activeTabId: state.activeTabId === tabId
          ? nextTabs[nextTabs.length - 1]?.tabId ?? null : state.activeTabId,
      };
    });

    // 等待断线清理完成后，再做最终释放，避免迟到的 closeTerminal 作用到同 ID 的新会话
    await pendingTeardown.get(tabId);

    // 逐项清理：任何一步失败都不能阻断后续释放。
    // 历史上这里用单个 try 包住全部步骤，closeCard 一失败就会跳过 closeTerminal /
    // closeConnection，UI 上标签消失了但后端 PTY、SSH 连接、串口句柄全部泄漏。
    const steps: Array<[string, () => Promise<void>]> = [
      [
        "closeCard",
        async () => {
          if (tab.cardId) await closeCard(tab.cardId);
        },
      ],
      [
        // 串口主动关闭：停止定时发送、RX 轮询与订阅，再释放设备句柄
        "teardownSerial",
        async () => {
          if (tab.protocol === "serial") {
            const { teardownSerialSession } = await import("./serialStore");
            teardownSerialSession(tab.cardId || tab.tabId);
          }
        },
      ],
      [
        // 只关闭本标签自己的 RDP 实例，不能影响同 session 的其他标签
        "closeRdp",
        async () => {
          if (tab.protocol === "rdp" && tab.rdpInfo?.launch_id) {
            const launchId = tab.rdpInfo.launch_id;
            try {
              await rdpClose(launchId);
            } catch (e) {
              // 标签已移除，失败若只 console.warn 就再无所有者可重试
              recordRdpCleanupFailure(tabId, launchId, e);
            }
          }
        },
      ],
      [
        // 串口标签以前完全没有关闭设备，导致下次打开报「端口被占用」
        "closeSerial",
        async () => {
          if (tab.protocol === "serial") await closeSerial(tab.cardId || tab.tabId);
        },
      ],
      ["closeTerminal", async () => await closeTerminal(tabId)],
      [
        "closeConnection",
        async () => {
          if (tab.connectionId) await closeConnection(tab.connectionId);
        },
      ],
    ];

    for (const [label, run] of steps) {
      try {
        await run();
      } catch (e) {
        console.warn(`closeTab: ${label} failed`, e);
      }
    }

  },

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTabStatus: (tabId, status, error) => {
    if (status === "connected") clearAutoReconnectTimer(tabId);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status,
              error,
              connectedAt:
                status === "connected"
                  ? t.connectedAt ?? Date.now()
                  : status === "connecting" || status === "disconnected" || status === "error"
                    ? null
                    : t.connectedAt,
              reconnectAttempt: status === "connected" ? 0 : t.reconnectAttempt,
            }
          : t
      ),
    }));
  },

  renameTab: (tabId, newName) => {
    if (!newName.trim()) return;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId ? { ...t, sessionName: newName.trim() } : t
      ),
    }));
  },

  duplicateTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return null;
    try {
      const sessionModules = await import("./sessionStore");
      const sessions = sessionModules.useSessionStore.getState().sessions;
      const targetSession = sessions.find((s) => s.id === tab.sessionId);
      if (targetSession) {
        return await get().openSession(targetSession);
      }
      // 回退：若没有保存的会话模板，根据标签名/协议构造一个同名会话新开
      const fallbackSession: Session = {
        id: tab.sessionId || generateId(),
        group_id: null,
        name: `${tab.sessionName} (副本)`,
        protocol: tab.protocol,
        host: "127.0.0.1",
        port: tab.protocol === "ssh" ? 22 : null,
        username: "root",
        auth_method: "password",
        credential_id: null,
        ssh_key_id: null,
        host_key_policy: "strict",
        proxy_jump_json: null,
        proxy_id: null,
        terminal_profile_id: null,
        encoding: "utf-8",
        startup_command: null,
        working_dir: null,
        keepalive_sec: 30,
        keepalive_max_miss: 3,
        auto_reconnect: false,
        reconnect_max: 3,
        compression: false,
        agent_forwarding: false,
        x11_forwarding: false,
        tags_json: null,
        favorite: false,
        color: null,
        icon_key: null,
        notes: null,
        protocol_options_json: null,
        last_used_at: null,
        last_result: null,
        use_count: 0,
        sort_order: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        deleted_at: null,
      };
      return await get().openSession(fallbackSession);
    } catch (e) {
      console.warn("duplicateTab failed:", e);
      return null;
    }
  },

  reorderTabs: (sourceIndex, destinationIndex) => {
    set((state) => {
      if (
        sourceIndex < 0 ||
        sourceIndex >= state.tabs.length ||
        destinationIndex < 0 ||
        destinationIndex >= state.tabs.length
      ) {
        return state;
      }
      const newTabs = [...state.tabs];
      const [removed] = newTabs.splice(sourceIndex, 1);
      newTabs.splice(destinationIndex, 0, removed);
      return { tabs: newTabs };
    });
  },
}));

/** RDP 运行状态轮询间隔；mstsc 启动后由后端 native 事件回传真实状态 */
const RDP_POLL_INTERVAL_MS = 2000;

interface RdpPollEntry {
  launchId: string;
  timer: ReturnType<typeof setInterval>;
}

/** 按标签隔离的 RDP 轮询；同一 session 打开多个标签时互不干扰 */
const rdpPollers = new Map<string, RdpPollEntry>();

/** 停止指定标签的 RDP 状态轮询（关闭/重连/到达终态时调用） */
function stopRdpPolling(tabId: string): void {
  const entry = rdpPollers.get(tabId);
  if (!entry) return;
  clearInterval(entry.timer);
  rdpPollers.delete(tabId);
}

/** 把后端运行状态映射到标签；仅 connected 才表示 native OnLoginComplete */
function applyRdpRuntimeStatus(tabId: string, status: RdpRuntimeStatus): void {
  const tab = useTerminalStore.getState().tabs.find((item) => item.tabId === tabId);
  // 标签已关闭或 launch_id 已被新实例替换：丢弃迟到结果，绝不复活
  if (!tab || tab.rdpInfo?.launch_id !== status.launch_id) {
    stopRdpPolling(tabId);
    return;
  }

  if (status.state === "connected") {
    // 已是 connected 时保持首次登录完成时间，不重复记成功时间
    if (tab.status === "connected" && tab.connectedAt != null) return;
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connected" as TabStatus,
              rdpPhase: "launched" as const,
              error: undefined,
              exitCode: null,
              connectedAt: Date.now(),
            }
          : t
      ),
    }));
    return;
  }

  if (status.state === "starting" || status.state === "launched") {
    // 已完成登录后，后端仍可能报 launched；不能把已连接会话降级回 connecting
    if (tab.status === "connected") return;
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connecting" as TabStatus,
              rdpPhase: status.state === "launched" ? ("launched" as const) : ("starting" as const),
              error: undefined,
              connectedAt: null,
            }
          : t
      ),
    }));
    return;
  }

  // failed / disconnected / closed 是终态：停止轮询，如实映射，不写成功时间
  stopRdpPolling(tabId);
  const terminalState = status.state === "failed";
  const message =
    status.error ||
    (status.state === "closed"
      ? "远程桌面会话已关闭"
      : status.state === "disconnected"
        ? "远程桌面连接已断开"
        : "远程桌面启动失败");
  useTerminalStore.setState((state) => ({
    tabs: state.tabs.map((t) =>
      t.tabId === tabId
        ? {
            ...t,
            status: terminalState ? ("error" as TabStatus) : ("disconnected" as TabStatus),
            rdpPhase: terminalState ? ("failed" as const) : null,
            rdpLaunchedAt: null,
            connectedAt: null,
            error: message,
            exitCode: status.exit_code ?? null,
          }
        : t
    ),
  }));
}

async function pollRdpStatus(tabId: string, launchId: string): Promise<void> {
  const entry = rdpPollers.get(tabId);
  if (!entry || entry.launchId !== launchId) return;
  const tab = useTerminalStore.getState().tabs.find((item) => item.tabId === tabId);
  if (!tab || tab.rdpInfo?.launch_id !== launchId) {
    stopRdpPolling(tabId);
    return;
  }

  try {
    const status = await rdpGetStatus(launchId);
    // 等待响应期间标签可能已关闭或已换新实例
    if (rdpPollers.get(tabId)?.launchId !== launchId) return;
    applyRdpRuntimeStatus(tabId, status);
  } catch (e) {
    if (rdpPollers.get(tabId)?.launchId !== launchId) return;
    // 无法查询状态时不能继续假装启动中；停止轮询并显示真实错误
    stopRdpPolling(tabId);
    const message = formatFriendlyError(e);
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "error" as TabStatus,
              rdpPhase: "failed" as const,
              rdpLaunchedAt: null,
              connectedAt: null,
              error: message,
            }
          : t
      ),
    }));
  }
}

/** 启动指定标签 / launch_id 的 RDP 状态轮询；重复启动会先清理旧轮询 */
function startRdpPolling(tabId: string, launchId: string): void {
  stopRdpPolling(tabId);
  const timer = setInterval(() => {
    void pollRdpStatus(tabId, launchId);
  }, RDP_POLL_INTERVAL_MS);
  rdpPollers.set(tabId, { launchId, timer });
}
