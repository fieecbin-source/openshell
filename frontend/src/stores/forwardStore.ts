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

/** 单调递增，确保过期的读结果不会覆盖新的连接/界面状态 */
let loadGeneration = 0;

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "读取端口转发规则失败";
}

interface ForwardState {
  rules: PortForwardRule[];
  statuses: Record<string, ForwardStatus>;
  loading: boolean;
  /** 当前会话筛选条件；增删改后刷新时沿用，避免把其它会话的规则混入列表 */
  activeSessionId: string | null;
  loadError: string | null;
  /** 提交已成功但随后刷新失败：与 mutation 成功分离，可仅重读重试 */
  refreshError: string | null;

  loadRules: (sessionId?: string) => Promise<void>;
  loadStatuses: () => Promise<void>;
  retryRefresh: () => Promise<void>;
  createRule: (input: PortForwardRuleInput) => Promise<PortForwardRule>;
  updateRule: (id: string, input: PortForwardRuleInput) => Promise<PortForwardRule>;
  deleteRule: (id: string) => Promise<void>;
  toggleRule: (rule: PortForwardRule, connId?: string) => Promise<void>;
}

export const useForwardStore = create<ForwardState>((set, get) => {
  /** mutation 成功后只做重读；刷新失败可见但不把已成功的提交误报为失败 */
  const refreshAfterMutation = async () => {
    try {
      await get().loadRules(get().activeSessionId ?? undefined);
      set({ refreshError: null });
    } catch (e) {
      set({ refreshError: readErrorMessage(e) });
    }
  };

  return {
    rules: [],
    statuses: {},
    loading: false,
    activeSessionId: null,
    loadError: null,
    refreshError: null,

    loadRules: async (sessionId?: string) => {
      const filterId = sessionId;
      const generation = ++loadGeneration;
      set({ loading: true, activeSessionId: filterId ?? null });
      try {
        const [rules, statuses] = await Promise.all([
          forwardList(filterId),
          forwardListStatuses(),
        ]);
        if (generation !== loadGeneration) return;
        set({ rules, statuses, loading: false, loadError: null });
      } catch (e) {
        if (generation !== loadGeneration) return;
        set({ loading: false, loadError: readErrorMessage(e) });
        throw e;
      }
    },

    loadStatuses: async () => {
      const statuses = await forwardListStatuses();
      set({ statuses });
    },

    retryRefresh: async () => {
      // 只重新读，绝不重复提交/启动/停止。
      try {
        await get().loadRules(get().activeSessionId ?? undefined);
        set({ refreshError: null });
      } catch (e) {
        set({ refreshError: readErrorMessage(e) });
      }
    },

    createRule: async (input: PortForwardRuleInput) => {
      const rule = await forwardCreate(input);
      await refreshAfterMutation();
      return rule;
    },

    updateRule: async (id: string, input: PortForwardRuleInput) => {
      const rule = await forwardUpdate(id, input);
      await refreshAfterMutation();
      return rule;
    },

    deleteRule: async (id: string) => {
      await forwardDelete(id);
      await refreshAfterMutation();
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
      try {
        await get().loadStatuses();
      } catch (e) {
        set({ refreshError: readErrorMessage(e) });
      }
    },
  };
});
