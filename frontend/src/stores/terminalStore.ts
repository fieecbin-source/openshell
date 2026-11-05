import { create } from "zustand";
import type {
  CardMode,
  LocalShellKind,
  Protocol,
  RdpLaunchResult,
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
  writeTerminal,
  sendSerial,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

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

  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  switchMode: (tabId: string, mode: CardMode) => Promise<void>;
  toggleMode: (tabId: string) => Promise<void>;
  reconnectTab: (tabId: string, overrides?: ConnectOverrides) => Promise<void>;
  /**
   * 标记标签已断开；等待用户按回车，不安排自动重连。
   */
  markDisconnected: (tabId: string, reason?: string, exitCode?: number | null) => void;
  updateTabStatus: (tabId: string, status: TabStatus, error?: string) => void;
  renameTab: (tabId: string, newName: string) => void;
  duplicateTab: (tabId: string) => Promise<string | null>;
  reorderTabs: (sourceIndex: number, destinationIndex: number) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  // FinalShell 经典布局：SSH 会话默认「上终端 + 中命令栏 + 下 SFTP」上下分屏
  layoutMode: "split",
  splitRatio: 0.58,
  isFullscreen: false,
  commandHistory: readCommandHistory(),

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
      shellKind,
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
          t.tabId === tabId ? { ...t, connectionId, status: "connected" as TabStatus } : t
        ),
      }));
      return tabId;
    }

    // Telnet：同样由 XtermView 挂载后通过 telnet_open 建立流
    if (protocol === "telnet") {
      const connectionId = "telnet-" + generateUuid();
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId ? { ...t, connectionId, status: "connected" as TabStatus } : t
        ),
      }));
      return tabId;
    }

    // Windows 远程桌面：生成 .rdp 并唤起 mstsc.exe，结果落进 rdpInfo
    if (protocol === "rdp") {
      try {
        const rdpInfo = await launchRdp(session.id);
        if (!get().tabs.some((item) => item.tabId === tabId)) return tabId;
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, rdpInfo, status: "connected" as TabStatus, error: undefined }
              : t
          ),
        }));
      } catch (err: any) {
        const errMsg = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, status: "error" as TabStatus, rdpInfo: null, error: errMsg }
              : t
          ),
        }));
      }
      return tabId;
    }

    if (protocol === "serial") {
      try {
        const serialOpts = session.protocol_options_json || {
          port_name: "COM1",
          baud_rate: 115200,
        };

        const activeCardId = cardId || tabId;
        await openSerial(activeCardId, serialOpts, false).catch(async () => {
          // 若真实串口不存在，自动切换到 Mock 后端保证可测试与可交互
          await openSerial(activeCardId, serialOpts, true);
        });

        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId ? { ...t, status: "connected" } : t
          ),
        }));

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
              ? { ...t, connectionId: res.connection_id, status: "connected", error: undefined }
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

  sendCommandToTabs: async (command, options) => {
    const appendCr = options?.appendCr !== false;
    const payload = appendCr ? `${command}\r` : command;
    const bytes = new TextEncoder().encode(payload);

    const state = get();
    const targets = options?.allTabs
      ? state.tabs.filter(
          (tab) => tab.status === "connected" && COMMAND_TARGET_PROTOCOLS.includes(tab.protocol)
        )
      : state.tabs.filter(
          (tab) =>
            tab.tabId === state.activeTabId &&
            tab.status === "connected" &&
            COMMAND_TARGET_PROTOCOLS.includes(tab.protocol)
        );

    for (const tab of targets) {
      try {
        if (tab.protocol === "serial") {
          await sendSerial(tab.cardId || tab.tabId, Array.from(bytes));
        } else {
          await writeTerminal(tab.tabId, bytes);
        }
      } catch (e) {
        console.warn(`sendCommandToTabs: 写入 ${tab.tabId} 失败`, e);
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
    if (!tab || tab.status === "connecting") return;
    // RDP 允许在「已连接」状态下再次唤起 mstsc；其余协议必须先断开才能重连
    const isRdp = tab.protocol === "rdp";
    if (!isRdp && tab.status === "connected") return;

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connecting",
              connectionId: null,
              error: undefined,
            }
          : t
      ),
    }));

    // 先等断线清理落盘，再释放旧 PTY，避免与新连接复用同一标签 ID 时互相踩踏。
    await pendingTeardown.get(tabId);
    await releaseTab(tabId, tab.connectionId);
    if (!get().tabs.some((item) => item.tabId === tabId)) return;

    // Windows 远程桌面：重新生成 .rdp 并唤起 mstsc.exe
    if (tab.protocol === "rdp") {
      try {
        const rdpInfo = await launchRdp(tab.sessionId);
        if (!get().tabs.some((item) => item.tabId === tabId)) return;
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, rdpInfo, status: "connected" as TabStatus, error: undefined }
              : t
          ),
        }));
      } catch (err: any) {
        const message = formatFriendlyError(err);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, status: "error" as TabStatus, rdpInfo: null, error: message }
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
              }
            : t
        ),
      }));
      return;
    }

    if (tab.protocol === "serial") {
      try {
        const activeCardId = tab.cardId || tab.tabId;
        const serialOpts = {
          port_name: "COM1",
          baud_rate: tab.baudRate || 115200,
        };
        await openSerial(activeCardId, serialOpts, false).catch(async () => {
          await openSerial(activeCardId, serialOpts, true);
        });
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "connected",
                  error: undefined,
                }
              : t
          ),
        }));
      } catch (err: any) {
        const message = formatFriendlyError(err);
        get().markDisconnected(tabId, message);
      }
      return;
    }

    try {
      const requestId = "req_" + generateId();
      const res = await connectSession(requestId, tab.sessionId, overrides);
      if (!get().tabs.some((item) => item.tabId === tabId)) {
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
              }
            : t
        ),
      }));
      // 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则
      await startAutoForwardRules(tab.sessionId, res.connection_id);
    } catch (err: any) {
      const message = formatFriendlyError(err);
      get().markDisconnected(tabId, message);
    }
  },

  markDisconnected: (tabId, reason, exitCode) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "disconnected",
              connectionId: null,
              error: reason,
              exitCode: exitCode ?? t.exitCode ?? null,
            }
          : t
      ),
    }));

    void releaseTab(tabId, tab.connectionId);
  },

  closeTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

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
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId ? { ...t, status, error } : t
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
