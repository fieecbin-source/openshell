import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isFieldUnavailable,
  isMetricsStale,
  readAvailableMetric,
  useMonitorStore,
} from "./monitorStore";
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
  useMonitorStore.setState({ activeSessionId: null, activeConnId: null, isMonitoring: false, refCount: 0, latest: null, history: [], autoRefreshInterval: null, error: null, latestError: null, latestFailedAt: null, latestReceivedAt: null });
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

it("records latest failure without refreshing the old snapshot and clears it on recovery", async () => {
  const old = { session_id: "session", cpu_percent: 42, timestamp_ms: 1 } as HostMetrics;
  const fresh = { session_id: "session", cpu_percent: 7, timestamp_ms: 2 } as HostMetrics;
  useMonitorStore.setState({ activeSessionId: "session", activeConnId: "connection", isMonitoring: true, refCount: 1, latest: old });

  vi.mocked(monitorGetLatest).mockRejectedValueOnce(new Error("monitor ipc down"));
  await useMonitorStore.getState().poll();
  expect(useMonitorStore.getState().latest).toEqual(old);
  expect(useMonitorStore.getState().latestError).toBeTruthy();
  expect(useMonitorStore.getState().latestFailedAt).toEqual(expect.any(Number));

  vi.mocked(monitorGetLatest).mockResolvedValueOnce(fresh);
  await useMonitorStore.getState().poll();
  expect(useMonitorStore.getState()).toMatchObject({
    latest: fresh,
    latestError: null,
    latestFailedAt: null,
  });
});

it("treats a null snapshot as waiting for first sample instead of zero", async () => {
  const old = { session_id: "session", cpu_percent: 0, timestamp_ms: 1 } as HostMetrics;
  useMonitorStore.setState({ activeSessionId: "session", activeConnId: "connection", isMonitoring: true, refCount: 1, latest: old });
  vi.mocked(monitorGetLatest).mockResolvedValueOnce(null);
  await useMonitorStore.getState().poll();
  expect(useMonitorStore.getState().latest).toBeNull();
  expect(useMonitorStore.getState().latestError).toBeNull();
  expect(useMonitorStore.getState().latestReceivedAt).toEqual(expect.any(Number));
});

it("marks snapshots older than three collection periods as stale", () => {
  const now = 10_000;
  expect(isMetricsStale(null, now)).toBe(true);
  expect(isMetricsStale({ timestamp_ms: now - 1_000 } as HostMetrics, now)).toBe(false);
  expect(isMetricsStale({ timestamp_ms: now - 9_500 } as HostMetrics, now)).toBe(true);
});

it("treats unavailable first-sample fields as null but keeps a legal zero on the second sample", () => {
  const first: HostMetrics = {
    session_id: "session",
    timestamp_ms: 1,
    cpu_percent: 0,
    cpu_cores: [],
    memory_total_bytes: 0,
    memory_used_bytes: 0,
    memory_cached_bytes: 0,
    load_1: 0,
    load_5: 0,
    load_15: 0,
    net_rx_bps: 0,
    net_tx_bps: 0,
    net_rx_total: 0,
    net_tx_total: 0,
    disk_mounts: [],
    top_processes: [],
    uptime_seconds: 0,
    unavailable_fields: ["cpu_percent", "net_rx_bps", "net_tx_bps", "top_processes"],
  };
  expect(isFieldUnavailable(first, "cpu_percent")).toBe(true);
  expect(readAvailableMetric(first, "cpu_percent")).toBeNull();
  expect(readAvailableMetric(first, "net_rx_bps")).toBeNull();
  expect(readAvailableMetric(first, "net_tx_bps")).toBeNull();

  const second: HostMetrics = {
    ...first,
    timestamp_ms: 2,
    unavailable_fields: [],
  };
  // 合法 0 必须保留，不能因为 0 就当作不可用
  expect(isFieldUnavailable(second, "cpu_percent")).toBe(false);
  expect(readAvailableMetric(second, "cpu_percent")).toBe(0);
  expect(readAvailableMetric(second, "net_rx_bps")).toBe(0);
  expect(readAvailableMetric(second, "net_tx_bps")).toBe(0);

  // 字段根本缺失时同样返回 null，界面显示“不可用”而不是伪 0
  expect(readAvailableMetric({ timestamp_ms: 3 } as HostMetrics, "cpu_percent")).toBeNull();
});
