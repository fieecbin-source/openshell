import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonitorDashboard } from "./MonitorDashboard";
import { useMonitorStore } from "../stores/monitorStore";
import type { HostMetrics } from "../types/ipc";

let root: Root;
let host: HTMLDivElement;
const latest: HostMetrics = {
  session_id: "a", timestamp_ms: Date.now(), cpu_percent: 20, cpu_cores: [],
  memory_total_bytes: 100, memory_used_bytes: 50, memory_cached_bytes: 0,
  load_1: 0, load_5: 0, load_15: 0, net_tx_bps: 2048, net_rx_bps: 1024,
  net_tx_total: 4096, net_rx_total: 8192, disk_mounts: [], top_processes: [], uptime_seconds: 3600,
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  root = createRoot(host);
  useMonitorStore.setState({ start: vi.fn(), stop: vi.fn(), latest: { ...latest, timestamp_ms: Date.now() },
    history: [], error: null, latestError: null });
});
afterEach(() => act(() => root.unmount()));

it("uses the shared network dashboard with the current connection's rates", () => {
  act(() => root.render(<MonitorDashboard sessionId="a" connId="conn-a" onClose={vi.fn()} />));
  const network = host.querySelector('section[aria-label="网络仪表盘"]');
  expect(network).not.toBeNull();
  expect(network!.textContent).toContain("2.0 KB/s");
  expect(network!.querySelector('svg[role="img"]')).not.toBeNull();
});

it("does not label failed or another session's snapshot as live network traffic", () => {
  act(() => root.render(<MonitorDashboard sessionId="a" connId="conn-a" onClose={vi.fn()} />));
  act(() => useMonitorStore.setState({ latestError: "采集失败" }));
  expect(host.querySelector('section[aria-label="网络仪表盘"]')?.textContent).toContain("无数据");
  expect(host.querySelector('section[aria-label="网络仪表盘"]')?.textContent).not.toContain("2.0 KB/s");
  act(() => useMonitorStore.setState({ latestError: null, latest: { ...latest, session_id: "b" } }));
  expect(host.querySelector('section[aria-label="网络仪表盘"]')?.textContent).not.toContain("2.0 KB/s");
});

it("honors unavailable memory fields in the monitor dashboard", () => {
  useMonitorStore.setState({ latest: { ...latest, timestamp_ms: Date.now(), unavailable_fields: ["memory_used_bytes"] } });
  act(() => root.render(<MonitorDashboard sessionId="a" connId="conn-a" onClose={vi.fn()} />));
  expect(host.textContent).not.toContain("50.0%");
  expect(host.textContent).toContain("不可用");
});
