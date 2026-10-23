import { create } from "zustand";
import type { ForwardStatus, PortForwardRule, PortForwardRuleInput } from "../types/ipc";
import {
  forwardCreate,
  forwardDelete,
  forwardList,
  forwardListStatuses,
  forwardStart,
  forwardStop,
  forwardUpdate,
} from "../lib/ipc";

interface ForwardState {
  rules: PortForwardRule[];
  statuses: Record<string, ForwardStatus>;
  loading: boolean;
  /** 当前会话筛选条件；增删改后刷新时沿用，避免把其它会话的规则混入列表 */
  activeSessionId: string | null;

  loadRules: (sessionId?: string) => Promise<void>;
  loadStatuses: () => Promise<void>;
  createRule: (input: PortForwardRuleInput) => Promise<PortForwardRule>;
  updateRule: (id: string, input: PortForwardRuleInput) => Promise<PortForwardRule>;
  deleteRule: (id: string) => Promise<void>;
  toggleRule: (rule: PortForwardRule, connId?: string) => Promise<void>;
}

export const useForwardStore = create<ForwardState>((set, get) => ({
  rules: [],
  statuses: {},
  loading: false,
  activeSessionId: null,

  loadRules: async (sessionId?: string) => {
    const filterId = sessionId ?? get().activeSessionId ?? undefined;
    set({ loading: true, activeSessionId: filterId ?? null });
    try {
      const [rules, statuses] = await Promise.all([
        forwardList(filterId),
        forwardListStatuses(),
      ]);
      set({ rules, statuses, loading: false });
    } catch (e) {
      console.warn("load forward rules error", e);
      set({ loading: false });
    }
  },

  loadStatuses: async () => {
    try {
      const statuses = await forwardListStatuses();
      set({ statuses });
    } catch (e) {
      console.warn("load forward statuses error", e);
    }
  },

  createRule: async (input: PortForwardRuleInput) => {
    const rule = await forwardCreate(input);
    await get().loadRules();
    return rule;
  },

  updateRule: async (id: string, input: PortForwardRuleInput) => {
    const rule = await forwardUpdate(id, input);
    await get().loadRules();
    return rule;
  },

  deleteRule: async (id: string) => {
    await forwardDelete(id);
    await get().loadRules();
  },

  toggleRule: async (rule: PortForwardRule, connId?: string) => {
    const status = get().statuses[rule.id];
    const isRunning = status && status.state === "Listening";
    if (isRunning) {
      await forwardStop(rule.id);
    } else {
      if (!connId) throw new Error("需要已连接的 SSH 会话才能启动端口转发");
      await forwardStart(rule.id, connId);
    }
    await get().loadStatuses();
  },
}));
