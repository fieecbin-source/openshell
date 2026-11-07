import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NetworkTraffic } from "./NetworkTraffic";
import { useMonitorStore } from "../stores/monitorStore";
import type { HostMetrics } from "../types/ipc";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); useMonitorStore.setState({ history: [] }); vi.unstubAllGlobals(); });

it("uses bounded, finite samples and collapses the graph with all speed and total values", () => {
  const now = Date.now();
  const samples = Array.from({ length: 60 }, (_, index) => ({ session_id: "server-a", timestamp_ms: now - (60 - index) * 3000, net_tx_bps: index % 2 ? 1200 : 0, net_rx_bps: index === 2 ? NaN : 400 })) as HostMetrics[];
  useMonitorStore.setState({ history: samples });
  const latest = { session_id: "server-a", timestamp_ms: now, net_tx_bps: 2048, net_rx_bps: 1024, net_tx_total: 4096, net_rx_total: 8192 } as HostMetrics;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  act(() => root.render(<NetworkTraffic metrics={latest} />));
  const graph = container.querySelector('[role="img"]')!;
  expect(graph.getAttribute("aria-label")).toContain("上行 2.0 KB/s，下行 1.0 KB/s");
  expect(container.textContent).toContain("累计 4.0 KB");
  for (const line of graph.querySelectorAll("polyline")) {
    const points = line.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(60);
    expect(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 200 && y >= 2 && y <= 38)).toBe(true);
  }
  act(() => container.querySelector("button")!.click());
  expect(container.querySelector('[role="img"]')).toBeNull();
  expect(container.textContent).not.toMatch(/累计|KB\/s/);
  expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
});

it("leaves a gap for unavailable network samples instead of inventing zero traffic", () => {
  const now = Date.now();
  const latest = { session_id: "a", timestamp_ms: now, net_tx_bps: 2048, net_rx_bps: 1024 } as HostMetrics;
  useMonitorStore.setState({ history: [
    { ...latest, timestamp_ms: now - 6000, net_tx_bps: 1500 },
    { ...latest, timestamp_ms: now - 3000, unavailable_fields: ["net_tx_bps"] },
  ] });
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={latest} />));
  const upload = container.querySelector('g.text-accent')!;
  expect(upload.querySelectorAll("polyline")).toHaveLength(2);
  expect([...upload.querySelectorAll("polyline")].every((line) => line.getAttribute("points")!.split(" ").length === 1)).toBe(true);
});

it("does not show missing network rates as zero traffic", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={null} />));
  expect(container.textContent).toContain("不可用");
  expect(container.textContent).not.toContain("0 B/s");
});

it("breaks the trend across collection outages and fills only continuous segments", () => {
  const now = Date.now();
  const latest = { session_id: "a", timestamp_ms: now, net_tx_bps: 2048, net_rx_bps: 1024 } as HostMetrics;
  useMonitorStore.setState({ history: [
    { ...latest, timestamp_ms: now - 60_000 },
    { ...latest, timestamp_ms: now - 57_000 },
    { ...latest, timestamp_ms: now - 3000 },
  ] });
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={latest} />));
  expect(container.querySelector('g.text-accent')!.querySelectorAll("polyline")).toHaveLength(2);
  expect(container.querySelectorAll("[data-network-area]")).toHaveLength(4);
  expect(container.textContent).toContain("-1m");
  expect(container.querySelector("[data-network-axis]")!.lastElementChild!.textContent).toBe("0");
});

it("shows parallel upload and download meters with readable live values in the rail", () => {
  const now = Date.now();
  const latest = { session_id: "a", timestamp_ms: now, net_tx_bps: 2048, net_rx_bps: 1024 } as HostMetrics;
  useMonitorStore.setState({ history: [{ ...latest, timestamp_ms: now - 3000 }] });
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={latest} mode="rail" />));
  expect(container.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(container.querySelector('[aria-label="上行速率：2.0 KB/s"]')?.getAttribute("aria-valuenow")).toBe("2048");
  expect(container.querySelector('[aria-label="下行速率：1.0 KB/s"]')?.getAttribute("aria-valuenow")).toBe("1024");
  expect(container.querySelector('svg[role="img"]')).toBeNull();
  expect(container.textContent).toContain("2.0KB/s");
  expect(container.textContent).toContain("1.0KB/s");
  act(() => root.render(<NetworkTraffic metrics={{ ...latest, net_tx_bps: 0, unavailable_fields: ["net_rx_bps"] }} mode="rail" />));
  expect(container.querySelector('[aria-label="上行速率：0 B/s"]')?.getAttribute("aria-valuenow")).toBe("0");
  expect(container.querySelector('[aria-label="下行速率：不可用"]')?.hasAttribute("aria-valuenow")).toBe(false);
  expect(container.textContent).toContain("—");
  act(() => root.render(<NetworkTraffic metrics={{ ...latest, net_tx_bps: 1023.8, net_rx_bps: 999.6 * 1024 }} mode="rail" />));
  const meters = container.querySelectorAll('[role="meter"]');
  expect(meters[0].textContent).toContain("1.0KB/s");
  expect(meters[1].textContent).toContain("1.0MB/s");
});

it("keeps both directions and the trend visible in the dashboard presentation", () => {
  const latest = { session_id: "a", timestamp_ms: Date.now(), net_tx_bps: 2048, net_rx_bps: 0,
    net_tx_total: 4096, net_rx_total: 0 } as HostMetrics;
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={latest} mode="dashboard" />));
  expect(container.querySelector('section[aria-label="网络仪表盘"]')).not.toBeNull();
  expect(container.textContent).toContain("2.0 KB/s");
  expect(container.textContent).toContain("0 B/s");
  expect(container.textContent).toContain("累计 4.0 KB");
  expect(container.querySelector('svg[role="img"]')).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
  act(() => {
    useMonitorStore.setState({ history: [{ ...latest, timestamp_ms: latest.timestamp_ms - 3000, net_tx_bps: 0 }] });
    root.render(<NetworkTraffic metrics={{ ...latest, net_tx_bps: 0 }} mode="dashboard" />);
  });
  expect(container.textContent).toContain("峰值 0 B/s");
});

it("stops scrolling when reduced motion changes and advances the static axis with new samples", () => {
  let reduced = false;
  let onChange = () => {};
  const cancel = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_type: string, listener: () => void) => { onChange = listener; }, removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const now = Date.now();
  const latest = { session_id: "a", timestamp_ms: now, net_tx_bps: 2048, net_rx_bps: 1024 } as HostMetrics;
  useMonitorStore.setState({ history: [{ ...latest, timestamp_ms: now - 3000 }] });
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() => root.render(<NetworkTraffic metrics={latest} />));
  act(() => { reduced = true; onChange(); });
  expect(cancel).toHaveBeenCalledWith(1);
  act(() => {
    useMonitorStore.setState({ history: [{ ...latest, timestamp_ms: now + 57_000 }] });
    root.render(<NetworkTraffic metrics={{ ...latest, timestamp_ms: now + 60_000 }} />);
  });
  const points = container.querySelector("polyline")!.getAttribute("points")!.split(" ");
  expect(Number(points[0].split(",")[0])).toBeLessThan(198);
});
