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
  latest: null,
  history: [],
  filterProcess: "",
  autoRefreshInterval: null,
  error: null,

  start: async (sessionId: string, connId: string) => {
    // 同一会话已采集时直接复用，避免重复注册轮询定时器
    if (get().isMonitoring && get().activeSessionId === sessionId) {
      return;
    }
    // 如果之前有采集中，先停止
    if (get().activeSessionId && get().activeSessionId !== sessionId) {
      await get().stop();
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
    try {
      const [latest, hist] = await Promise.all([
        monitorGetLatest(sid),
        monitorGetHistory(sid, 300),
      ]);
      set({ latest, history: hist });
    } catch (e) {
      console.warn("poll monitor error", e);
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
