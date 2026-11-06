import { beforeEach, expect, it, vi } from "vitest";
import { useContainerStore } from "./containerStore";
import { sshExec } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({ sshExec: vi.fn() }));
const exec = vi.mocked(sshExec);
const result = (stdout: string) => ({ stdout, stderr: "", exit_code: 0 });

beforeEach(() => {
  vi.resetAllMocks();
  useContainerStore.getState().reset();
});

it("clears the previous server while probing and ignores its late probe result", async () => {
  let finishOld!: (value: ReturnType<typeof result>) => void;
  exec.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const oldProbe = useContainerStore.getState().probe("old");
  useContainerStore.setState({ runtime: "/usr/bin/docker", probed: true,
    containers: [{ id: "old", name: "old", image: "old", state: "running", status: "Up", ports: "", created: "" }] });
  exec.mockResolvedValueOnce(result("/usr/bin/podman")).mockResolvedValueOnce(result(""));
  const newProbe = useContainerStore.getState().probe("new");
  expect(useContainerStore.getState().containers).toEqual([]);
  expect(useContainerStore.getState().probed).toBe(false);
  await newProbe;
  finishOld(result("/usr/bin/docker"));
  await oldProbe;
  expect(useContainerStore.getState()).toMatchObject({ connId: "new", runtime: "/usr/bin/podman", containers: [], loading: false });
  expect(exec).toHaveBeenCalledTimes(3);
});

it("does not let an old reload or failure overwrite the new server", async () => {
  let failOld!: (reason: Error) => void;
  useContainerStore.setState({ connId: "old", runtime: "docker", probed: true });
  exec.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
  const oldReload = useContainerStore.getState().reload();
  exec.mockResolvedValueOnce(result("podman")).mockResolvedValueOnce(result('{"ID":"new-container","Names":"new","State":"running"}'));
  await useContainerStore.getState().probe("new");
  failOld(new Error("old connection lost"));
  await oldReload;
  expect(useContainerStore.getState()).toMatchObject({ connId: "new", error: null, loading: false });
  expect(useContainerStore.getState().containers.map((item) => item.id)).toEqual(["new-container"]);
});

it("ignores a probe that completes after disconnect", async () => {
  let finish!: (value: ReturnType<typeof result>) => void;
  exec.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const probe = useContainerStore.getState().probe("old");
  useContainerStore.getState().reset();
  finish(result("docker"));
  await probe;
  expect(useContainerStore.getState()).toMatchObject({ connId: null, runtime: "", loading: false, probed: false });
});

it("ignores the first request when switching from A to B and back to A", async () => {
  let finishOld!: (value: ReturnType<typeof result>) => void;
  exec.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const firstA = useContainerStore.getState().probe("A");
  exec.mockResolvedValueOnce(result("docker")).mockResolvedValueOnce(result(""));
  await useContainerStore.getState().probe("B");
  exec.mockResolvedValueOnce(result("podman")).mockResolvedValueOnce(result('{"ID":"latest-A","Names":"latest-A","State":"running"}'));
  await useContainerStore.getState().probe("A");
  finishOld(result(""));
  await firstA;
  expect(useContainerStore.getState()).toMatchObject({ connId: "A", runtime: "podman", error: null });
  expect(useContainerStore.getState().containers.map((item) => item.id)).toEqual(["latest-A"]);
});

it("rejects an action issued by a connection that is no longer current", async () => {
  useContainerStore.setState({
    connId: "B",
    runtime: "docker",
    probed: true,
    containers: [{ id: "b1", name: "b1", image: "img", state: "running", status: "Up", ports: "", created: "" }],
  });
  const msg = await useContainerStore.getState().action("A", "a1", "stop");
  expect(msg).toBe("当前连接已切换，已取消操作");
  expect(exec).not.toHaveBeenCalled();
});

it("never sends a stale container id to the new connection", async () => {
  useContainerStore.setState({
    connId: "B",
    runtime: "docker",
    probed: true,
    containers: [{ id: "b1", name: "b1", image: "img", state: "running", status: "Up", ports: "", created: "" }],
  });
  const msg = await useContainerStore.getState().action("B", "a1", "stop");
  expect(msg).toBe("容器列表已更新，请刷新后重试");
  expect(exec).not.toHaveBeenCalled();
});

it("runs the action on the owning connection and re-reads its list", async () => {
  useContainerStore.setState({
    connId: "A",
    runtime: "docker",
    probed: true,
    containers: [{ id: "a1", name: "a1", image: "img", state: "running", status: "Up", ports: "", created: "" }],
  });
  exec.mockResolvedValueOnce(result("")).mockResolvedValueOnce(result('{"ID":"a1","Names":"a1","State":"exited"}'));
  const msg = await useContainerStore.getState().action("A", "a1", "stop");
  expect(msg).toBe("已停止容器");
  expect(exec.mock.calls[0]).toEqual(["A", "docker stop a1"]);
  expect(useContainerStore.getState().containers.map((item) => item.id)).toEqual(["a1"]);
});
