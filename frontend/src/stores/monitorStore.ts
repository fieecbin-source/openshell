import { create } from "zustand";
import type { HostMetrics } from "../types/ipc";
import {
  monitorGetHistory,
  monitorGetLatest,
  monitorKillProcess,
  monitorStart,
  monitorStop,
} from "../lib/ipc";

interface MonitorState {
  activeSessionId: string | null;
  activeConnId: string | null;
  isMonitoring: boolean;
  latest: HostMetrics | null;
  history: HostMetrics[];
  filterProcess: string;
  autoRefreshInterval: number | null;

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

  start: async (sessionId: string, connId: string) => {
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
      });

      await get().poll();

      // 定期拉取前端图表
      const interval = window.setInterval(() => {
        get().poll();
      }, 3000);

      set({ autoRefreshInterval: interval });
    } catch (e) {
      console.warn("failed to start monitor", e);
    }
  },

  stop: async () => {
    const sid = get().activeSessionId;
    const interval = get().autoRefreshInterval;
    if (interval) {
      clearInterval(interval);
    }
    if (sid) {
      await monitorStop(sid);
    }
    set({
      activeSessionId: null,
      activeConnId: null,
      isMonitoring: false,
      autoRefreshInterval: null,
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
