import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContainerWorkspace } from "./ContainerWorkspace";
import { useContainerStore } from "../stores/containerStore";

vi.mock("../lib/ipc", () => ({ sshExec: vi.fn().mockResolvedValue({ stdout: "[]", stderr: "", exit_code: 0 }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useContainerStore.setState({ connId: "server", runtime: "docker", probed: true, containers: [], loading: false, error: null });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("removes the duplicate container navigation when the server sidebar expands", () => {
  act(() => root.render(<ContainerWorkspace connId="server" showList onClose={vi.fn()} />));
  expect(host.querySelector('[aria-label="搜索容器"]')).not.toBeNull();
  act(() => root.render(<ContainerWorkspace connId="server" showList={false} onClose={vi.fn()} />));
  expect(host.querySelector("aside")).toBeNull();
  expect(host.textContent).toContain("返回终端");
  act(() => root.render(<ContainerWorkspace connId="server" showList onClose={vi.fn()} />));
  expect(host.querySelectorAll("aside")).toHaveLength(1);
});

it("follows another container selected in the expanded server sidebar", async () => {
  useContainerStore.setState({ containers: ["first", "second"].map((id) => ({
    id, name: id, image: id, status: "Up", state: "running", ports: "", created: "",
  })) });
  await act(async () => root.render(<ContainerWorkspace connId="server" initialContainerId="first" showList={false} onClose={vi.fn()} />));
  expect(host.querySelector("dd")?.textContent).toBe("first");
  await act(async () => root.render(<ContainerWorkspace connId="server" initialContainerId="second" showList={false} onClose={vi.fn()} />));
  expect(host.querySelector("dd")?.textContent).toBe("second");
});
