import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerSidebar } from "./ServerSidebar";
import { useMonitorStore } from "../stores/monitorStore";
import { useContainerStore } from "../stores/containerStore";
import type { TerminalTab } from "../stores/terminalStore";
import type { HostMetrics } from "../types/ipc";

vi.mock("../lib/ipc", () => ({ sshExec: vi.fn() }));
vi.mock("./ConnectionDetailsPopover", () => ({ ConnectionDetailsPopover: ({ open, tab }: { open: boolean; tab: TerminalTab }) =>
  open ? <div role="dialog">{tab.sessionName}</div> : null }));
let root: Root;
let host: HTMLDivElement;
const tab = (id: string): TerminalTab => ({ tabId: id, sessionId: id, sessionName: id,
  connectionId: id, protocol: "ssh", currentMode: "command", status: "connected" });
const onOpenMonitor = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useMonitorStore.setState({ start: vi.fn(), stop: vi.fn(), latest: null, history: [], latestError: null });
  useContainerStore.setState({ probe: vi.fn(), runtime: "docker", probed: true, containers: [], error: null });
  vi.clearAllMocks();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("places details, resource monitoring and unlimited speed in the second header row", () => {
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed={false} onOpenMonitor={onOpenMonitor} />));
  const header = host.querySelector("aside")!.firstElementChild!;
  expect(header.children[0].textContent).toBe("server-a已连接");
  expect(header.children[1].textContent).toBe("连接详情资源监控⚡ 无限速");
  expect(header.textContent).not.toMatch(/直连|保活|运行|负载/);
});

it("updates the monitor target and resets local panels when switching server keys", () => {
  act(() => root.render(<ServerSidebar key="server-a" tab={tab("server-a")} collapsed={false} onOpenMonitor={onOpenMonitor} />));
  act(() => host.querySelector<HTMLButtonElement>('[title="server-a · 连接详情"]')!.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toBe("server-a");
  act(() => root.render(<ServerSidebar key="server-b" tab={tab("server-b")} collapsed={false} onOpenMonitor={onOpenMonitor} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  const monitor = host.querySelector<HTMLButtonElement>('[title="server-b · 资源监控"]')!;
  expect(monitor).not.toBeNull();
  act(() => monitor.click());
  expect(onOpenMonitor).toHaveBeenCalledOnce();
});

it("keeps resource monitoring accessible when collapsed and opens the container tab on expansion", () => {
  const current = tab("server-a");
  useMonitorStore.setState({ latest: { session_id: current.sessionId, top_processes: [], disks: [] } as unknown as HostMetrics });
  const onOpenContainer = vi.fn();
  act(() => root.render(<ServerSidebar tab={current} collapsed onOpenMonitor={onOpenMonitor} onOpenContainer={onOpenContainer} />));
  expect(host.querySelector('[aria-label="资源监控"]')).not.toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[title="容器管理"]')!.click());
  expect(onOpenContainer).toHaveBeenCalledOnce();
  act(() => root.render(<ServerSidebar tab={current} collapsed={false} onOpenMonitor={onOpenMonitor} onOpenContainer={onOpenContainer} />));
  expect(host.textContent).toContain("Docker / Podman 容器");
});

it("keeps container navigation available before the first monitor sample", () => {
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed={false} onOpenMonitor={onOpenMonitor} />));
  const containers = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "容器")!;
  expect(containers).toBeTruthy();
  act(() => containers.click());
  expect(host.textContent).toContain("Docker / Podman 容器");
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed onOpenMonitor={onOpenMonitor} />));
  expect(host.querySelector('[title="容器管理"]')).not.toBeNull();
});

const sample = (extra: Partial<HostMetrics> = {}): HostMetrics => ({
  session_id: "server-a", timestamp_ms: Date.now(), cpu_percent: 32, cpu_cores: [32, 32],
  memory_total_bytes: 8 * 1024 ** 3, memory_used_bytes: 4 * 1024 ** 3,
  memory_cached_bytes: 0, load_1: 0.6, load_5: 0.4, load_15: 0.3,
  net_rx_bps: 1024, net_tx_bps: 2048, net_rx_total: 8192, net_tx_total: 4096,
  disk_mounts: [], top_processes: [], uptime_seconds: 90000, ...extra,
});

it("uses release-style capsules and shows both network directions above the whale entry", () => {
  const latest = sample();
  useMonitorStore.setState({ latest });
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed onOpenContainer={vi.fn()} />));
  const cpu = host.querySelector('[aria-label="CPU 使用率"]');
  expect(cpu).not.toBeNull();
  expect(cpu!.querySelector<HTMLElement>('[data-resource-fill]')!.style.height).toBe("32%");
  expect(host.querySelector('[aria-label="内存使用率"]')).not.toBeNull();
  expect(host.textContent).toContain("32%");
  expect(host.textContent).toContain("50%");
  expect(host.querySelector('[title="容器管理"] svg text')?.textContent).toBe("🐳");
  expect(host.querySelector('[title="容器管理"]')!.parentElement).toBe(cpu!.parentElement);
  expect(host.querySelectorAll('[aria-label="网络传输速率"] svg[role="img"]')).toHaveLength(2);
});

it("identifies the fullest disk partition instead of presenting root usage as the entire host", () => {
  useMonitorStore.setState({ latest: sample({ disk_mounts: [
    { mount_point: "/", filesystem: "root", total_bytes: 100, used_bytes: 35, available_bytes: 65, use_percent: 35 },
    { mount_point: "/data", filesystem: "data", total_bytes: 100, used_bytes: 87, available_bytes: 13, use_percent: 87 },
  ] }) });
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed />));
  const disk = host.querySelector('[aria-label="最高分区占用"]');
  expect(disk).not.toBeNull();
  expect(disk!.textContent).toContain("87%");
  expect(disk!.getAttribute("title")).toContain("/data");
});

it("does not render unavailable memory or CPU as a healthy zero", () => {
  useMonitorStore.setState({ latest: sample({ unavailable_fields: ["memory_used_bytes", "cpu_percent"] }) });
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed={false} />));
  expect(host.textContent).toContain("内存占用不可用");
  expect(host.textContent).toContain("CPU 占用不可用");
  expect(host.textContent).not.toContain("已用: 4 GB");
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed />));
  expect(host.querySelector('svg[aria-label="CPU 使用率历史"]')).toBeNull();
  expect(host.querySelector('svg[aria-label="内存使用率历史"]')).toBeNull();
});

it("keeps valid zero samples and hides live indicators on collection failure", () => {
  useMonitorStore.setState({ latest: sample({ cpu_percent: 0, memory_used_bytes: 0 }) });
  act(() => root.render(<ServerSidebar tab={tab("server-a")} collapsed />));
  expect(host.textContent).toContain("0%");
  expect(host.querySelector<HTMLElement>('[aria-label="CPU 使用率"] [data-resource-fill]')?.style.height).toBe("0%");
  act(() => useMonitorStore.setState({ latestError: "采集断开" }));
  expect(host.textContent).toContain("采集失败");
  expect(host.querySelector('[aria-label="CPU 使用率"]')).toBeNull();
});
