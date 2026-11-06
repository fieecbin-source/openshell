import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerSidebar } from "./ServerSidebar";
import { useMonitorStore } from "../stores/monitorStore";
import { useContainerStore } from "../stores/containerStore";
import type { TerminalTab } from "../stores/terminalStore";
import type { HostMetrics } from "../types/ipc";

vi.mock("../lib/ipc", () => ({ sshExec: vi.fn() }));
vi.mock("./NetworkTraffic", () => ({ NetworkTraffic: () => null }));
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
  useMonitorStore.setState({ start: vi.fn(), stop: vi.fn(), latest: null, history: [] });
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
