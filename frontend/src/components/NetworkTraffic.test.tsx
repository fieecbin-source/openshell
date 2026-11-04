import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { NetworkTraffic } from "./NetworkTraffic";
import { useMonitorStore } from "../stores/monitorStore";
import type { HostMetrics } from "../types/ipc";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); useMonitorStore.setState({ history: [] }); });

it("uses bounded, finite samples and collapses the graph with all speed and total values", () => {
  const samples = Array.from({ length: 60 }, (_, index) => ({ timestamp_ms: index + 1, net_tx_bps: index % 2 ? 1200 : 0, net_rx_bps: index === 2 ? NaN : 400 })) as HostMetrics[];
  useMonitorStore.setState({ history: samples });
  const latest = { timestamp_ms: 61, net_tx_bps: 2048, net_rx_bps: 1024, net_tx_total: 4096, net_rx_total: 8192 } as HostMetrics;
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
    expect(points).toHaveLength(60);
    expect(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 220 && y >= 6 && y <= 62)).toBe(true);
  }
  act(() => container.querySelector("button")!.click());
  expect(container.querySelector('[role="img"]')).toBeNull();
  expect(container.textContent).not.toMatch(/累计|KB\/s/);
  expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
});
