import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMonitorStore } from "./monitorStore";
import { monitorGetHistory, monitorGetLatest, monitorStart, monitorStop } from "../lib/ipc";
import type { HostMetrics } from "../types/ipc";

vi.mock("../lib/ipc", () => ({ monitorGetHistory: vi.fn(), monitorGetLatest: vi.fn(), monitorStart: vi.fn(), monitorStop: vi.fn(), monitorKillProcess: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(monitorStart).mockResolvedValue(undefined);
  vi.mocked(monitorStop).mockResolvedValue(undefined);
  vi.mocked(monitorGetLatest).mockResolvedValue(null);
  vi.mocked(monitorGetHistory).mockResolvedValue([]);
  useMonitorStore.setState({ activeSessionId: null, activeConnId: null, isMonitoring: false, refCount: 0, latest: null, history: [], autoRefreshInterval: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("shares a pending monitor start and only stops after the last view leaves", async () => {
  let finish!: () => void;
  vi.mocked(monitorStart).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = useMonitorStore.getState().start("session", "connection");
  const second = useMonitorStore.getState().start("session", "connection");
  expect(monitorStart).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  await useMonitorStore.getState().stop("session", "connection");
  expect(useMonitorStore.getState().isMonitoring).toBe(true);
  await useMonitorStore.getState().stop("session", "connection");
  expect(useMonitorStore.getState()).toMatchObject({ isMonitoring: false, activeConnId: null, latest: null, history: [], autoRefreshInterval: null });
});

it("discards an old poll after disconnect and reconnect to the same session", async () => {
  const old = { session_id: "session", cpu_percent: 90 } as HostMetrics;
  const latest = { session_id: "session", cpu_percent: 10 } as HostMetrics;
  useMonitorStore.setState({ activeSessionId: "session", activeConnId: "old", isMonitoring: true, refCount: 1, latest: old, history: [old] });
  let finish!: (value: HostMetrics) => void;
  vi.mocked(monitorGetLatest).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(latest);
  const pending = useMonitorStore.getState().poll();
  await useMonitorStore.getState().stop("session", "old");
  expect(useMonitorStore.getState().latest).toBeNull();
  await useMonitorStore.getState().start("session", "new");
  finish(old);
  await pending;
  await useMonitorStore.getState().stop("session", "old");
  expect(useMonitorStore.getState().activeConnId).toBe("new");
  expect(useMonitorStore.getState().latest).toEqual(latest);
});

it("does not restart polling when a stopped startup request finishes late", async () => {
  let finish!: () => void;
  vi.mocked(monitorStart).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = useMonitorStore.getState().start("session", "connection");
  await useMonitorStore.getState().stop("session", "connection");
  finish();
  await pending;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(monitorGetLatest).not.toHaveBeenCalled();
  expect(useMonitorStore.getState().isMonitoring).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
