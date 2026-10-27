import { create } from "zustand";
import type { CardMode, Protocol, Session, TabStatus } from "../types/ipc";
import {
  type ReconnectPolicy,
  nextBackoffDelay,
  policyFromSession,
} from "../lib/backoff";
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
  /** 已进行的自动重连次数 */
  reconnectAttempt: number;
  /** 下一次自动重连的时间戳（毫秒），用于界面倒计时 */
  nextRetryAt?: number;
  /** 重连策略，由会话配置派生 */
  reconnect: ReconnectPolicy;
  baudRate?: number;
}

/** 自动重连定时器：按 tabId 存放，关闭标签时必须清理，否则会给已关闭的标签重连 */
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearReconnectTimer(tabId: string) {
  const timer = reconnectTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    reconnectTimers.delete(tabId);
  }
}

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

  openSession: (session: Session, overrides?: ConnectOverrides) => Promise<string>;
  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  switchMode: (tabId: string, mode: CardMode) => Promise<void>;
  toggleMode: (tabId: string) => Promise<void>;
  reconnectTab: (tabId: string, overrides?: ConnectOverrides) => Promise<void>;
  /**
   * 标记标签已断开（远端退出 / 链路中断 / 保活失联），并按会话策略安排自动重连。
   */
  markDisconnected: (tabId: string, reason?: string, exitCode?: number | null) => void;
  /** 取消该标签的自动重连（用户点「取消」或手动重连时调用） */
  cancelAutoReconnect: (tabId: string) => void;
  updateTabStatus: (tabId: string, status: TabStatus, error?: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  // 连接成功后默认全终端视图（SFTP 按需从顶栏切换），避免一上来就是分屏
  layoutMode: "terminal",

  setLayoutMode: (layoutMode) => set({ layoutMode }),

  openSession: async (session: Session, overrides?: ConnectOverrides) => {
    const tabId = generateId();
    const protocol: Protocol = session.protocol || "ssh";

    let cardId: string | undefined;
    try {
      const card = await createCard(session.id);
      cardId = card.card_id;
    } catch (e) {
      console.warn("createCard fallback to local tab", e);
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
      reconnectAttempt: 0,
      reconnect: policyFromSession(session.auto_reconnect, session.reconnect_max),
      baudRate: session.protocol_options_json?.baud_rate || 115200,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }));

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
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error",
                  connectionId: null,
                  error: formatFriendlyError(err),
                }
              : t
          ),
        }));
        throw err;
      }
    } else {
      // SSH 模式
      try {
        const requestId = "req_" + generateId();
        const res = await connectSession(requestId, session.id, overrides);

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
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? {
                  ...t,
                  status: "error",
                  connectionId: null,
                  error: formatFriendlyError(err),
                }
              : t
          ),
        }));
        throw err;
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

    // 先取消已排队的定时器，避免「手动重连 + 自动重连」同时触发两次建连
    clearReconnectTimer(tabId);
    const attemptInLoop = tab.reconnectAttempt ?? 0;

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connecting",
              connectionId: null,
              error: undefined,
              nextRetryAt: undefined,
            }
          : t
      ),
    }));

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
                  reconnectAttempt: 0,
                  nextRetryAt: undefined,
                }
              : t
          ),
        }));
      } catch (err: any) {
        const message = formatFriendlyError(err);
        if (attemptInLoop > 0 && tab.reconnect.enabled) {
          get().markDisconnected(tabId, message);
        } else {
          set((state) => ({
            tabs: state.tabs.map((t) =>
              t.tabId === tabId
                ? { ...t, status: "disconnected", connectionId: null, error: message }
                : t
            ),
          }));
        }
      }
      return;
    }

    try {
      const requestId = "req_" + generateId();
      const res = await connectSession(requestId, tab.sessionId, overrides);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                connectionId: res.connection_id,
                status: "connected",
                error: undefined,
                exitCode: null,
                reconnectAttempt: 0,
                nextRetryAt: undefined,
              }
            : t
        ),
      }));
      // 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则
      await startAutoForwardRules(tab.sessionId, res.connection_id);
    } catch (err: any) {
      const message = formatFriendlyError(err);
      // 自动重连过程中的失败：继续按退避策略重试
      // 手动重连失败：停在错误态，等用户处理凭据/网络
      if (attemptInLoop > 0 && tab.reconnect.enabled) {
        get().markDisconnected(tabId, message);
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, status: "error", connectionId: null, error: message }
              : t
          ),
        }));
      }
    }
  },

  markDisconnected: (tabId, reason, exitCode) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    clearReconnectTimer(tabId);

    const policy = tab.reconnect;
    const nextAttempt = (tab.reconnectAttempt ?? 0) + 1;
    const canRetry = policy.enabled && nextAttempt <= policy.maxAttempts;

    if (!canRetry) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                status: "disconnected",
                error: policy.enabled
                  ? `${reason ?? "连接已断开"}（自动重连 ${policy.maxAttempts} 次未成功，请手动重连）`
                  : reason,
                exitCode: exitCode ?? t.exitCode ?? null,
                nextRetryAt: undefined,
              }
            : t
        ),
      }));
      return;
    }

    const delay = nextBackoffDelay(nextAttempt, policy);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "reconnecting",
              error: reason,
              exitCode: exitCode ?? t.exitCode ?? null,
              reconnectAttempt: nextAttempt,
              nextRetryAt: Date.now() + delay,
            }
          : t
      ),
    }));

    const timer = setTimeout(() => {
      reconnectTimers.delete(tabId);
      // 标签可能在倒计时期间被用户关闭
      if (!get().tabs.some((t) => t.tabId === tabId)) return;
      void get().reconnectTab(tabId);
    }, delay);
    reconnectTimers.set(tabId, timer);
  },

  cancelAutoReconnect: (tabId) => {
    clearReconnectTimer(tabId);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "disconnected",
              reconnectAttempt: 0,
              nextRetryAt: undefined,
            }
          : t
      ),
    }));
  },

  closeTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    // 关闭标签时必须取消待执行的自动重连，否则倒计时结束后会给已关闭的标签重建连接
    clearReconnectTimer(tabId);

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

    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.tabId !== tabId);
      let nextActiveId = state.activeTabId;

      if (state.activeTabId === tabId) {
        nextActiveId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].tabId : null;
      }

      return {
        tabs: nextTabs,
        activeTabId: nextActiveId,
      };
    });
  },

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTabStatus: (tabId, status, error) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId ? { ...t, status, error } : t
      ),
    }));
  },
}));
