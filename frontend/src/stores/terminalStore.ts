import { create } from "zustand";
import type { CardMode, Protocol, Session } from "../types/ipc";
import {
  closeConnection,
  closeTerminal,
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
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
  baudRate?: number;
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

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  openSession: (session: Session, overrides?: ConnectOverrides) => Promise<string>;
  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  switchMode: (tabId: string, mode: CardMode) => Promise<void>;
  toggleMode: (tabId: string) => Promise<void>;
  reconnectTab: (tabId: string, overrides?: ConnectOverrides) => Promise<void>;
  updateTabStatus: (
    tabId: string,
    status: TerminalTab["status"],
    error?: string
  ) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,

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
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.tabId === tabId
          ? { ...t, status: "connecting", connectionId: null, error: undefined }
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
            t.tabId === tabId ? { ...t, status: "connected" } : t
          ),
        }));
      } catch (err: any) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, status: "disconnected", connectionId: null, error: formatFriendlyError(err) }
              : t
          ),
        }));
      }
    } else {
      try {
        const requestId = "req_" + generateId();
        const res = await connectSession(requestId, tab.sessionId, overrides);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, connectionId: res.connection_id, status: "connected", error: undefined }
              : t
          ),
        }));
        // 连接成功后自动启动该会话中标记为“自动启动”的端口转发规则
        await startAutoForwardRules(tab.sessionId, res.connection_id);
      } catch (err: any) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.tabId === tabId
              ? { ...t, status: "error", connectionId: null, error: formatFriendlyError(err) }
              : t
          ),
        }));
      }
    }
  },

  closeTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    try {
      if (tab.cardId) {
        await closeCard(tab.cardId);
      }
      await closeTerminal(tabId);
      if (tab.connectionId) {
        await closeConnection(tab.connectionId);
      }
    } catch (e) {
      console.warn("error closing terminal/connection", e);
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
