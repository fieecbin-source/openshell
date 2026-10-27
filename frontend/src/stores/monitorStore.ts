import { create } from "zustand";
import type { HostMetrics } from "../types/ipc";
import {
  monitorGetHistory,
  monitorGetLatest,
  monitorKillProcess,
  monitorStart,
  monitorStop,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

interface MonitorState {
  activeSessionId: string | null;
  activeConnId: string | null;
  isMonitoring: boolean;
  /** start/stop 引用计数：侧栏与大屏可能同时订阅同一会话 */
  refCount: number;
  latest: HostMetrics | null;
  history: HostMetrics[];
  filterProcess: string;
  autoRefreshInterval: number | null;
  error: string | null;

  start: (sessionId: string, connId: string) => Promise<void>;
  stop: () => Promise<void>;
  poll: () => Promise<void>;
  kill: (pid: number, signal?: number) => Promise<void>;
  setFilterProcess: (filter: string) => void;
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  activeSessionId: null,
  activeConnId: null,
  isMonitoring: false,
  refCount: 0,
  latest: null,
  history: [],
  filterProcess: "",
  autoRefreshInterval: null,
  error: null,

  start: async (sessionId: string, connId: string) => {
    set((s) => ({ refCount: s.refCount + 1 }));

    // 同一会话已采集时直接复用，避免重复注册轮询定时器。
    // 但仍要确保前端轮询定时器活着：另一个视图（如大屏）关闭时可能把它清掉。
    if (get().isMonitoring && get().activeSessionId === sessionId) {
      if (!get().autoRefreshInterval) {
        const interval = window.setInterval(() => {
          void get().poll();
        }, 3000);
        set({ autoRefreshInterval: interval });
      }
      return;
    }
    // 如果之前有其它会话在采集中，先清掉旧任务与旧数据
    const prev = get();
    if (prev.activeSessionId && prev.activeSessionId !== sessionId) {
      if (prev.autoRefreshInterval) {
        clearInterval(prev.autoRefreshInterval);
      }
      void monitorStop(prev.activeSessionId).catch(() => {
        // 会话可能已断开，忽略停止失败
      });
      set({
        activeSessionId: null,
        activeConnId: null,
        isMonitoring: false,
        autoRefreshInterval: null,
        latest: null,
        history: [],
      });
    }

    try {
      await monitorStart(sessionId, connId, 3);
      set({
        activeSessionId: sessionId,
        activeConnId: connId,
        isMonitoring: true,
        error: null,
      });

      await get().poll();

      // 首个采样快照可能还没生成（远端 ps 较慢），补拉几次，
      // 避免「必须手动点一次重新采集才会出现进程」的观感。
      for (const delay of [600, 1200, 2000, 3000]) {
        window.setTimeout(() => {
          const cur = get().latest;
          if (!cur || (cur.top_processes?.length ?? 0) === 0) void get().poll();
        }, delay);
      }

      // 定期拉取前端图表
      const interval = window.setInterval(() => {
        get().poll();
      }, 3000);

      set({ autoRefreshInterval: interval });
    } catch (e) {
      set({ isMonitoring: false, error: formatFriendlyError(e) });
    }
  },

  stop: async () => {
    // 引用计数：侧栏与大屏同时看着同一会话时，
    // 任一方卸载都不能把采样任务停掉（否则另一方的进程/指标会冻结）。
    const remaining = Math.max(0, get().refCount - 1);
    set({ refCount: remaining });
    if (remaining > 0) return;

    const sid = get().activeSessionId;
    const interval = get().autoRefreshInterval;
    if (interval) {
      clearInterval(interval);
    }
    if (sid) {
      await monitorStop(sid).catch(() => {
        // 会话可能已断开，忽略停止失败
      });
    }
    set({
      activeSessionId: null,
      activeConnId: null,
      isMonitoring: false,
      autoRefreshInterval: null,
      error: null,
    });
  },

  poll: async () => {
    const sid = get().activeSessionId;
    if (!sid) return;

    // 两次请求必须分开容错。
    // 旧写法用 Promise.all：只要「历史曲线」查询失败（数据量大、写锁竞争时很常见），
    // 整个 poll 就 reject，最新快照也不会 setState —— 表现就是进程/CPU 面板一直空着，
    // 用户手动点一次「重新采集」碰巧成功才突然出现数据。
    try {
      const latest = await monitorGetLatest(sid);
      if (latest) set({ latest });
    } catch (e) {
      console.warn("poll monitor latest error", e);
    }

    try {
      const hist = await monitorGetHistory(sid, 300);
      set({ history: hist });
    } catch (e) {
      console.warn("poll monitor history error", e);
    }
  },

  kill: async (pid: number, signal = 15) => {
    const cid = get().activeConnId;
    if (!cid) return;
    await monitorKillProcess(cid, pid, signal);
    await get().poll();
  },

  setFilterProcess: (filterProcess: string) => set({ filterProcess }),
}));
