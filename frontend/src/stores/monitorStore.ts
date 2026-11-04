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
  stop: (sessionId?: string, connId?: string) => Promise<void>;
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
    const prev = get();
    if (prev.activeSessionId === sessionId && prev.activeConnId === connId) {
      set({ refCount: prev.refCount + 1 });
      return;
    }
    if (prev.autoRefreshInterval) clearInterval(prev.autoRefreshInterval);
    set({ activeSessionId: sessionId, activeConnId: connId, refCount: 1,
      isMonitoring: false, autoRefreshInterval: null, latest: null, history: [], error: null });
    const isCurrent = () => get().activeSessionId === sessionId && get().activeConnId === connId;

    try {
      if (prev.activeSessionId) await monitorStop(prev.activeSessionId).catch(() => {});
      if (!isCurrent()) return;
      await monitorStart(sessionId, connId, 3);
      if (!isCurrent()) return;
      set({
        activeSessionId: sessionId,
        activeConnId: connId,
        isMonitoring: true,
        error: null,
      });

      await get().poll();
      if (!isCurrent()) return;

      // 首个采样快照可能还没生成（远端 ps 较慢），补拉几次，
      // 避免「必须手动点一次重新采集才会出现进程」的观感。
      for (const delay of [600, 1200, 2000, 3000]) {
        window.setTimeout(() => {
          if (!isCurrent() || !get().isMonitoring) return;
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
      if (isCurrent()) set({ activeSessionId: null, activeConnId: null, refCount: 0, isMonitoring: false, error: formatFriendlyError(e) });
    }
  },

  stop: async (sessionId, connId) => {
    if ((sessionId && get().activeSessionId !== sessionId) || (connId && get().activeConnId !== connId)) return;
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
    set({
      activeSessionId: null,
      activeConnId: null,
      isMonitoring: false,
      autoRefreshInterval: null,
      error: null,
      latest: null,
      history: [],
    });
    if (sid) await monitorStop(sid).catch(() => {});
  },

  poll: async () => {
    const sid = get().activeSessionId;
    const cid = get().activeConnId;
    if (!sid || !get().isMonitoring) return;
    const isCurrent = () => get().activeSessionId === sid && get().activeConnId === cid && get().isMonitoring;

    // 两次请求必须分开容错。
    // 旧写法用 Promise.all：只要「历史曲线」查询失败（数据量大、写锁竞争时很常见），
    // 整个 poll 就 reject，最新快照也不会 setState —— 表现就是进程/CPU 面板一直空着，
    // 用户手动点一次「重新采集」碰巧成功才突然出现数据。
    try {
      const latest = await monitorGetLatest(sid);
      if (isCurrent()) set({ latest });
    } catch (e) {
      console.warn("poll monitor latest error", e);
    }

    try {
      if (!isCurrent()) return;
      const hist = await monitorGetHistory(sid, 300);
      if (isCurrent()) set({ history: hist });
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
