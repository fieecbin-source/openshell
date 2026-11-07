import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HostMetrics } from "../types/ipc";
import { DiskUsageRail } from "./DiskUsageRail";

let host: HTMLDivElement;
let root: Root;
const metrics = (values: number[], unavailable = false) => ({
  disk_mounts: values.map((use_percent, index) => ({ mount_point: `/data/${index}`, filesystem: `/dev/vd${index}`,
    use_percent, total_bytes: 100, used_bytes: use_percent, available_bytes: 100 - use_percent })),
  unavailable_fields: unavailable ? ["disk_mounts"] : [],
}) as HostMetrics;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it("keeps all partitions, including real zero and full capacity, in the rail", () => {
  act(() => root.render(<DiskUsageRail metrics={metrics([0, 35, 87, 100, 52, 64])} />));
  const meters = host.querySelectorAll('[role="meter"]');
  expect(meters).toHaveLength(6);
  expect(meters[0].getAttribute("aria-valuenow")).toBe("0");
  expect(meters[3].getAttribute("aria-valuenow")).toBe("100");
  expect(meters[5].getAttribute("title")).toContain("/data/5");
});

it("distinguishes a missing partition value from zero and honors unavailable disk data", () => {
  act(() => root.render(<DiskUsageRail metrics={metrics([NaN, -1])} />));
  for (const meter of host.querySelectorAll('[role="meter"]')) {
    expect(meter.hasAttribute("aria-valuenow")).toBe(false);
    expect(meter.getAttribute("aria-valuetext")).toBe("不可用");
  }
  act(() => root.render(<DiskUsageRail metrics={metrics([35], true)} />));
  expect(host.querySelector('[role="meter"]')).toBeNull();
  expect(host.textContent).toContain("—");
});
