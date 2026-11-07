import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalStore, type TerminalTab } from "./terminalStore";
import { useSessionStore } from "./sessionStore";
import {
  closeConnection,
  closeTerminal,
  connectSession,
  forwardList,
  rdpClose,
  rdpGetStatus,
  sendSerial,
  terminalEncode,
  writeTerminal,
} from "../lib/ipc";
import { closeCard, closeSerial, createCard, launchRdp, openSerial } from "../lib/ipc";
import { useSerialStore } from "./serialStore";
import type { SerialProfileConfig, Session } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  closeConnection: vi.fn(), closeTerminal: vi.fn(), connectSession: vi.fn(), forwardList: vi.fn(),
  closeSerial: vi.fn(), closeCard: vi.fn(), createCard: vi.fn(), openSerial: vi.fn(), launchRdp: vi.fn(),
  rdpClose: vi.fn(), rdpGetStatus: vi.fn(), sendSerial: vi.fn(), writeTerminal: vi.fn(), terminalEncode: vi.fn(),
  setCardMode: vi.fn(), forwardStart: vi.fn(), listSerialPorts: vi.fn(), setSerialLines: vi.fn(),
  getSerialModemStatus: vi.fn(), getSerialStats: vi.fn(), readSerial: vi.fn(),
}));
const tab = { tabId: "tab", sessionId: "session", sessionName: "Test host", protocol: "ssh", connectionId: "old-connection", status: "connected", currentMode: "command" } as TerminalTab;
const serialConfig = {
  port_name: "COM9",
  baud_rate: 9600,
  data_bits: 7,
  stop_bits: 2,
  parity: "even",
  flow_control: "rts_cts",
  dtr: false,
  rts: true,
  newline_mode: "crlf",
  local_echo: false,
  auto_reconnect: false,
} as unknown as SerialProfileConfig;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(closeConnection).mockResolvedValue(undefined);
  vi.mocked(closeTerminal).mockResolvedValue(undefined);
  vi.mocked(forwardList).mockResolvedValue([]);
  vi.mocked(closeSerial).mockResolvedValue(undefined);
  vi.mocked(createCard).mockResolvedValue({ card_id: "card-1" } as any);
  vi.mocked(openSerial).mockResolvedValue(undefined);
  vi.mocked(rdpClose).mockResolvedValue(undefined);
  vi.mocked(sendSerial).mockImplementation(async (_cardId, bytes) => bytes.length);
  vi.mocked(writeTerminal).mockImplementation(async (_tabId, bytes) => bytes.length);
  vi.mocked(rdpGetStatus).mockResolvedValue({
    launch_id: "",
    session_id: "",
    state: "launched",
    error: null,
    exit_code: null,
  } as any);
  useSessionStore.setState({ sessions: [] });
  useTerminalStore.setState({ tabs: [{ ...tab }], activeTabId: tab.tabId, rdpCleanupFailures: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("stays disconnected after idle timeout instead of scheduling an automatic retry", async () => {
  useTerminalStore.getState().markDisconnected(tab.tabId, "Idle timeout");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(useTerminalStore.getState().tabs[0]).toMatchObject({ status: "disconnected", connectionId: null, error: "Idle timeout" });
  expect(connectSession).not.toHaveBeenCalled();
  expect(closeConnection).toHaveBeenCalledWith("old-connection");
  expect(vi.getTimerCount()).toBe(0);
});

it("only connects once for repeated manual requests, and waits again after a failure", async () => {
  useTerminalStore.setState({ tabs: [{ ...tab, status: "disconnected", connectionId: null }] });
  let fail!: (error: Error) => void;
  vi.mocked(connectSession).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const first = useTerminalStore.getState().reconnectTab(tab.tabId);
  const second = useTerminalStore.getState().reconnectTab(tab.tabId);
  await vi.advanceTimersByTimeAsync(0);
  expect(connectSession).toHaveBeenCalledTimes(1);
  expect(useTerminalStore.getState().tabs[0].status).toBe("connecting");
  fail(new Error("Connection refused"));
  await Promise.all([first, second]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connectSession).toHaveBeenCalledTimes(1);
  expect(useTerminalStore.getState().tabs[0].status).toBe("disconnected");
  vi.mocked(connectSession).mockResolvedValueOnce({ connection_id: "new-connection", session_id: tab.sessionId });
  await useTerminalStore.getState().reconnectTab(tab.tabId);
  expect(connectSession).toHaveBeenCalledTimes(2);
  expect(useTerminalStore.getState().tabs[0].connectionId).toBe("new-connection");
});

it("waits for the asynchronous disconnect teardown before reusing the tab id", async () => {
  let finishClose!: () => void;
  vi.mocked(closeTerminal).mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
  vi.mocked(connectSession).mockResolvedValue({ connection_id: "new-connection", session_id: tab.sessionId });
  useTerminalStore.getState().markDisconnected(tab.tabId, "Idle timeout");
  const pending = useTerminalStore.getState().reconnectTab(tab.tabId);
  await vi.advanceTimersByTimeAsync(0);
  expect(connectSession).not.toHaveBeenCalled();
  finishClose();
  await pending;
  expect(connectSession).toHaveBeenCalledTimes(1);
  expect(useTerminalStore.getState().tabs[0].connectionId).toBe("new-connection");
});

it("closes a late connection result when its tab was closed during the request", async () => {
  useTerminalStore.setState({ tabs: [{ ...tab, status: "disconnected", connectionId: null }] });
  let finish!: (value: { connection_id: string; session_id: string }) => void;
  vi.mocked(connectSession).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = useTerminalStore.getState().reconnectTab(tab.tabId);
  await vi.advanceTimersByTimeAsync(0);
  let finishClose!: () => void;
  vi.mocked(closeTerminal).mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
  const closing = useTerminalStore.getState().closeTab(tab.tabId);
  expect(useTerminalStore.getState().tabs).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(0);
  finish({ connection_id: "late-connection", session_id: tab.sessionId });
  await pending;
  finishClose();
  await closing;
  expect(useTerminalStore.getState().tabs).toHaveLength(0);
  expect(closeConnection).toHaveBeenCalledWith("late-connection");
});

const serialSession = (options?: Record<string, unknown>): Session =>
  ({
    id: "serial-session",
    name: "Serial device",
    protocol: "serial",
    protocol_options_json: options,
  }) as unknown as Session;

it("opens a real serial port exactly once with the full config and never falls back to mock", async () => {
  vi.mocked(openSerial).mockRejectedValueOnce(new Error("Access denied"));
  const tabId = await useTerminalStore
    .getState()
    .openSessionTab(serialSession({ ...serialConfig, port_name: "COM7" }));

  expect(openSerial).toHaveBeenCalledTimes(1);
  expect(vi.mocked(openSerial).mock.calls[0]).toEqual([
    "card-1",
    expect.objectContaining({
      port_name: "COM7",
      baud_rate: 9600,
      data_bits: 7,
      stop_bits: 2,
      parity: "even",
      flow_control: "rts_cts",
      newline_mode: "crlf",
    }),
    false,
  ]);
  const opened = useTerminalStore.getState().tabs.find((item) => item.tabId === tabId);
  expect(opened).toMatchObject({ status: "error", connectedAt: null, error: expect.any(String) });
});

it("refuses a serial session without a port instead of silently connecting COM1", async () => {
  const tabId = await useTerminalStore
    .getState()
    .openSessionTab(serialSession({ baud_rate: 115200 }));

  expect(openSerial).not.toHaveBeenCalled();
  const opened = useTerminalStore.getState().tabs.find((item) => item.tabId === tabId);
  expect(opened).toMatchObject({ status: "error", connectedAt: null });
  expect(opened?.error).toContain("未配置端口号");
});

it("reconnects with the stored full serial config instead of hardcoded COM1", async () => {
  useTerminalStore.setState({
    tabs: [
      {
        ...tab,
        tabId: "serial-tab",
        sessionId: "serial-session",
        protocol: "serial",
        connectionId: null,
        cardId: "card-1",
        status: "disconnected",
        serialConfig,
      } as TerminalTab,
    ],
    activeTabId: "serial-tab",
  });

  await useTerminalStore.getState().reconnectTab("serial-tab");

  expect(closeSerial).toHaveBeenCalledWith("card-1");
  expect(openSerial).toHaveBeenCalledTimes(1);
  expect(vi.mocked(openSerial).mock.calls[0]).toEqual([
    "card-1",
    expect.objectContaining({
      port_name: "COM9",
      baud_rate: 9600,
      data_bits: 7,
      stop_bits: 2,
      parity: "even",
      flow_control: "rts_cts",
    }),
    false,
  ]);
  expect(useTerminalStore.getState().tabs[0]).toMatchObject({ status: "connected", connectedAt: expect.any(Number) });
});

it("stops serial reconnect with a clear error when no config can be resolved", async () => {
  useTerminalStore.setState({
    tabs: [
      {
        ...tab,
        tabId: "serial-tab",
        sessionId: "missing-session",
        protocol: "serial",
        connectionId: null,
        cardId: "card-2",
        status: "disconnected",
      } as TerminalTab,
    ],
    activeTabId: "serial-tab",
  });

  await useTerminalStore.getState().reconnectTab("serial-tab");

  expect(openSerial).not.toHaveBeenCalled();
  expect(useTerminalStore.getState().tabs[0]).toMatchObject({ status: "error" });
  expect(useTerminalStore.getState().tabs[0].error).toContain("串口配置缺失");
});

it("marks an RDP launch as launched, not connected", async () => {
  vi.mocked(launchRdp).mockResolvedValueOnce({
    launch_id: "L-launch",
    session_id: "rdp-1",
    rdp_file_path: "C:\\tmp\\x.rdp",
    pid: 1,
    host: "h",
    port: 3389,
  } as any);
  const session = { id: "rdp-1", name: "RDP", protocol: "rdp", protocol_options_json: {} } as unknown as Session;
  const tabId = await useTerminalStore.getState().openSessionTab(session);
  expect(useTerminalStore.getState().tabs.find((item) => item.tabId === tabId)).toMatchObject({
    status: "connecting",
    rdpPhase: "launched",
    connectedAt: null,
  });
});

it("marks an RDP launch failure as error without claiming a connection", async () => {
  vi.mocked(launchRdp).mockRejectedValueOnce(new Error("mstsc not found"));
  const session = { id: "rdp-2", name: "RDP", protocol: "rdp", protocol_options_json: {} } as unknown as Session;
  const tabId = await useTerminalStore.getState().openSessionTab(session);
  expect(useTerminalStore.getState().tabs.find((item) => item.tabId === tabId)).toMatchObject({
    status: "error",
    rdpPhase: "failed",
    connectedAt: null,
  });
});

const rdpSession = (id: string): Session =>
  ({ id, name: "RDP", protocol: "rdp", protocol_options_json: {} }) as unknown as Session;

const launchResult = (launchId: string, sessionId: string) =>
  ({
    launch_id: launchId,
    session_id: sessionId,
    rdp_file_path: `C:\\tmp\\${launchId}.rdp`,
    pid: 100,
  }) as any;

const rdpStatus = (launchId: string, sessionId: string, state: string, error: string | null = null) =>
  ({ launch_id: launchId, session_id: sessionId, state, error, exit_code: null }) as any;

const findTab = (tabId: string) =>
  useTerminalStore.getState().tabs.find((item) => item.tabId === tabId);

it("connects an RDP tab only after rdp_get_status reports connected", async () => {
  vi.mocked(launchRdp).mockResolvedValueOnce(launchResult("L1", "rdp-a"));
  vi.mocked(rdpGetStatus)
    .mockResolvedValueOnce(rdpStatus("L1", "rdp-a", "launched"))
    .mockResolvedValueOnce(rdpStatus("L1", "rdp-a", "connected"));
  const tabId = await useTerminalStore.getState().openSessionTab(rdpSession("rdp-a"));

  expect(findTab(tabId)).toMatchObject({ status: "connecting", rdpPhase: "launched", connectedAt: null });

  await vi.advanceTimersByTimeAsync(2000);
  expect(rdpGetStatus).toHaveBeenCalledWith("L1");
  expect(findTab(tabId)).toMatchObject({ status: "connecting", connectedAt: null });

  await vi.advanceTimersByTimeAsync(2000);
  const connected = findTab(tabId);
  expect(connected).toMatchObject({ status: "connected", connectedAt: expect.any(Number) });
});

it("maps RDP failure to an error without a success timestamp and stops polling", async () => {
  vi.mocked(launchRdp).mockResolvedValueOnce(launchResult("L2", "rdp-b"));
  vi.mocked(rdpGetStatus).mockResolvedValueOnce(
    rdpStatus("L2", "rdp-b", "failed", "NLA 认证被拒绝")
  );
  const tabId = await useTerminalStore.getState().openSessionTab(rdpSession("rdp-b"));

  await vi.advanceTimersByTimeAsync(2000);
  expect(findTab(tabId)).toMatchObject({
    status: "error",
    rdpPhase: "failed",
    connectedAt: null,
    error: "NLA 认证被拒绝",
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(rdpGetStatus).toHaveBeenCalledTimes(1);
});

it("maps RDP disconnect/exit to disconnected and never revives a closed tab", async () => {
  vi.mocked(launchRdp).mockResolvedValueOnce(launchResult("L3", "rdp-c"));
  vi.mocked(rdpGetStatus).mockResolvedValueOnce(rdpStatus("L3", "rdp-c", "closed"));
  const tabId = await useTerminalStore.getState().openSessionTab(rdpSession("rdp-c"));

  await vi.advanceTimersByTimeAsync(2000);
  expect(findTab(tabId)).toMatchObject({ status: "disconnected", connectedAt: null });

  await useTerminalStore.getState().closeTab(tabId);
  expect(findTab(tabId)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(findTab(tabId)).toBeUndefined();
  expect(rdpGetStatus).toHaveBeenCalledTimes(1);
});

it("closes a late RDP launch when its tab was closed during the request", async () => {
  let finishLaunch!: (value: any) => void;
  vi.mocked(launchRdp).mockImplementationOnce(
    () => new Promise((resolve) => { finishLaunch = resolve; })
  );
  const opening = useTerminalStore.getState().openSessionTab(rdpSession("rdp-d"));
  const tabId = useTerminalStore.getState().tabs[useTerminalStore.getState().tabs.length - 1].tabId;
  await vi.advanceTimersByTimeAsync(0);

  await useTerminalStore.getState().closeTab(tabId);
  expect(findTab(tabId)).toBeUndefined();

  finishLaunch(launchResult("L-late", "rdp-d"));
  await opening;
  expect(rdpClose).toHaveBeenCalledWith("L-late");
  expect(vi.getTimerCount()).toBe(0);
});

it("restarts an launched RDP tab: closes its own launch and polls the new instance", async () => {
  useTerminalStore.setState({
    tabs: [
      {
        ...tab,
        tabId: "rdp-tab",
        sessionId: "rdp-e",
        protocol: "rdp",
        connectionId: null,
        status: "connecting",
        rdpPhase: "launched",
        rdpInfo: launchResult("L-old", "rdp-e"),
        connectedAt: null,
      } as unknown as TerminalTab,
    ],
    activeTabId: "rdp-tab",
  });
  vi.mocked(launchRdp).mockResolvedValueOnce(launchResult("L-new", "rdp-e"));
  vi.mocked(rdpGetStatus).mockResolvedValue(rdpStatus("L-new", "rdp-e", "connected"));

  await useTerminalStore.getState().reconnectTab("rdp-tab");

  expect(rdpClose).toHaveBeenCalledWith("L-old");
  expect(launchRdp).toHaveBeenCalledTimes(1);
  expect(findTab("rdp-tab")).toMatchObject({ status: "connecting", rdpInfo: { launch_id: "L-new" } });

  await vi.advanceTimersByTimeAsync(2000);
  expect(findTab("rdp-tab")).toMatchObject({ status: "connected", connectedAt: expect.any(Number) });
});

it("keeps two RDP instances of the same session isolated when one tab closes", async () => {
  vi.mocked(launchRdp)
    .mockResolvedValueOnce(launchResult("L-a", "rdp-f"))
    .mockResolvedValueOnce(launchResult("L-b", "rdp-f"));
  vi.mocked(rdpGetStatus).mockImplementation(async (launchId: string) =>
    rdpStatus(launchId, "rdp-f", "connected")
  );
  const firstId = await useTerminalStore.getState().openSessionTab(rdpSession("rdp-f"));
  const secondId = await useTerminalStore.getState().openSessionTab(rdpSession("rdp-f"));
  expect(findTab(firstId)).toMatchObject({ rdpInfo: { launch_id: "L-a" } });
  expect(findTab(secondId)).toMatchObject({ rdpInfo: { launch_id: "L-b" } });

  await useTerminalStore.getState().closeTab(firstId);
  expect(rdpClose).toHaveBeenCalledWith("L-a");
  expect(rdpClose).not.toHaveBeenCalledWith("L-b");
  expect(findTab(secondId)).toBeDefined();

  await vi.advanceTimersByTimeAsync(2000);
  expect(findTab(secondId)).toMatchObject({ status: "connected" });
  // 第一个标签的轮询不能把已关闭标签复活
  expect(rdpGetStatus).not.toHaveBeenCalledWith("L-a");
});

const gbSession = (id: string, protocol = "ssh"): Session =>
  ({ id, name: "GB18030 host", protocol, encoding: "gb18030", protocol_options_json: {} }) as unknown as Session;

it("sendTextToTab encodes with the session encoding and writes only the target tab", async () => {
  useSessionStore.setState({ sessions: [gbSession("gb")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "gb-1", sessionId: "gb", status: "connected", protocol: "ssh" } as TerminalTab,
      { ...tab, tabId: "gb-2", sessionId: "gb", status: "connected", protocol: "ssh" } as TerminalTab,
    ],
    activeTabId: "gb-2",
  });
  const encoded = [0xc4, 0xe3];
  vi.mocked(terminalEncode).mockResolvedValueOnce(encoded);

  await useTerminalStore.getState().sendTextToTab("gb-1", "中文");

  expect(terminalEncode).toHaveBeenCalledWith("中文", "gb18030");
  expect(writeTerminal).toHaveBeenCalledTimes(1);
  expect(writeTerminal).toHaveBeenCalledWith("gb-1", new Uint8Array(encoded));
  expect(useTerminalStore.getState().activeTabId).toBe("gb-2");
  expect(useTerminalStore.getState().commandHistory).toHaveLength(0);
});

it("sendTextToTab routes serial targets to sendSerial and rejects unavailable targets", async () => {
  useSessionStore.setState({ sessions: [gbSession("gb-serial", "serial")] });
  useTerminalStore.setState({
    tabs: [
      {
        ...tab,
        tabId: "serial-1",
        sessionId: "gb-serial",
        protocol: "serial",
        cardId: "card-9",
        status: "connected",
      } as TerminalTab,
      { ...tab, tabId: "not-connected", sessionId: "gb", status: "disconnected" } as TerminalTab,
      { ...tab, tabId: "rdp-1", sessionId: "gb", protocol: "rdp", status: "connected" } as TerminalTab,
    ],
    activeTabId: "serial-1",
  });
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);

  await useTerminalStore.getState().sendTextToTab("serial-1", "A");
  expect(sendSerial).toHaveBeenCalledWith("card-9", [0x41]);

  await expect(useTerminalStore.getState().sendTextToTab("missing", "A")).rejects.toThrow();
  await expect(useTerminalStore.getState().sendTextToTab("not-connected", "A")).rejects.toThrow();
  await expect(useTerminalStore.getState().sendTextToTab("rdp-1", "A")).rejects.toThrow();
  expect(writeTerminal).not.toHaveBeenCalled();
});

it("sendCommandToTabs broadcasts with session encoding and surfaces per-target failures", async () => {
  useSessionStore.setState({ sessions: [gbSession("gb")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "b-1", sessionId: "gb", status: "connected", protocol: "ssh" } as TerminalTab,
      { ...tab, tabId: "b-2", sessionId: "gb", status: "connected", protocol: "ssh" } as TerminalTab,
    ],
    activeTabId: "b-1",
  });
  vi.mocked(terminalEncode).mockResolvedValue([0xc4, 0xe3]);
  vi.mocked(writeTerminal)
    .mockRejectedValueOnce(new Error("写入失败"))
    .mockImplementationOnce(async (_tabId, bytes) => bytes.length);

  await useTerminalStore.getState().sendCommandToTabs("dir", { allTabs: true, appendCr: false });

  expect(terminalEncode).toHaveBeenNthCalledWith(1, "dir", "gb18030");
  expect(writeTerminal).toHaveBeenCalledTimes(2);
  const state = useTerminalStore.getState();
  expect(state.tabs.find((item) => item.tabId === "b-1")?.error).toBeTruthy();
  expect(state.tabs.find((item) => item.tabId === "b-2")?.error).toBeUndefined();
});

// Task6 S05/S06 竞态回归：先写红测复现，再做最小修复。
const rdpRaceTab = (tabId: string, launchId = "L-old") =>
  ({
    ...tab,
    tabId,
    sessionId: "rdp-race-session",
    protocol: "rdp",
    connectionId: null,
    status: "connecting",
    rdpPhase: "launched",
    rdpInfo: launchResult(launchId, "rdp-race-session"),
    connectedAt: null,
  }) as unknown as TerminalTab;

const raceSession = (id: string, protocol = "ssh") =>
  ({ id, name: "Race host", protocol, encoding: "gb18030", protocol_options_json: {} }) as unknown as Session;

it("S05: two quick restarts during a delayed rdpClose must not create two instances", async () => {
  useTerminalStore.setState({ tabs: [rdpRaceTab("rdp-race")], activeTabId: "rdp-race" });
  let finishClose!: () => void;
  vi.mocked(rdpClose).mockImplementationOnce(
    () => new Promise<void>((resolve) => { finishClose = resolve; })
  );
  vi.mocked(launchRdp).mockResolvedValue(launchResult("L-new", "rdp-race-session"));

  const first = useTerminalStore.getState().reconnectTab("rdp-race");
  const second = useTerminalStore.getState().reconnectTab("rdp-race");
  await vi.advanceTimersByTimeAsync(0);

  // 第一次 await 之前必须已锁定本次重启：阶段不再是 launched，按钮 busy 生效
  expect(findTab("rdp-race")?.rdpPhase).not.toBe("launched");
  expect(rdpClose).toHaveBeenCalledTimes(1);
  expect(launchRdp).not.toHaveBeenCalled();

  finishClose();
  await Promise.all([first, second]);

  expect(rdpClose).toHaveBeenCalledWith("L-old");
  expect(launchRdp).toHaveBeenCalledTimes(1);
  expect(findTab("rdp-race")?.rdpInfo?.launch_id).toBe("L-new");
});

it("S05: an rdpClose failure is visible and retryable without launching a replacement", async () => {
  useTerminalStore.setState({ tabs: [rdpRaceTab("rdp-close-fail")], activeTabId: "rdp-close-fail" });
  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("close denied"));
  vi.mocked(launchRdp).mockResolvedValue(launchResult("L-new", "rdp-race-session"));

  await useTerminalStore.getState().reconnectTab("rdp-close-fail");

  expect(launchRdp).not.toHaveBeenCalled();
  const failed = findTab("rdp-close-fail");
  expect(failed?.status).toBe("error");
  expect(failed?.rdpPhase).toBe("failed");
  expect(failed?.error).toBeTruthy();

  // 重试仍持有旧 launch_id：再次关闭旧实例后只启动一个新实例
  await useTerminalStore.getState().reconnectTab("rdp-close-fail");
  expect(rdpClose).toHaveBeenCalledTimes(2);
  expect(launchRdp).toHaveBeenCalledTimes(1);
  expect(findTab("rdp-close-fail")?.rdpInfo?.launch_id).toBe("L-new");
});

it("S05: a launch finishing after the tab was closed is released and never revives it", async () => {
  useTerminalStore.setState({ tabs: [rdpRaceTab("rdp-late")], activeTabId: "rdp-late" });
  let finishLaunch!: (value: any) => void;
  vi.mocked(launchRdp).mockImplementationOnce(
    () => new Promise((resolve) => { finishLaunch = resolve; })
  );

  const restarting = useTerminalStore.getState().reconnectTab("rdp-late");
  await vi.advanceTimersByTimeAsync(0);
  const closing = useTerminalStore.getState().closeTab("rdp-late");
  await vi.advanceTimersByTimeAsync(0);
  expect(findTab("rdp-late")).toBeUndefined();

  finishLaunch(launchResult("L-late-new", "rdp-race-session"));
  await Promise.all([restarting, closing]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(rdpClose).toHaveBeenCalledWith("L-late-new");
  expect(findTab("rdp-late")).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("S05: restarting one RDP tab does not disturb another tab of the same session", async () => {
  useTerminalStore.setState({
    tabs: [rdpRaceTab("rdp-a", "L-a"), rdpRaceTab("rdp-b", "L-b")],
    activeTabId: "rdp-a",
  });
  vi.mocked(launchRdp).mockResolvedValue(launchResult("L-a-new", "rdp-race-session"));

  await useTerminalStore.getState().reconnectTab("rdp-a");

  expect(rdpClose).toHaveBeenCalledWith("L-a");
  expect(rdpClose).not.toHaveBeenCalledWith("L-b");
  expect(findTab("rdp-a")?.rdpInfo?.launch_id).toBe("L-a-new");
  expect(findTab("rdp-b")?.rdpInfo?.launch_id).toBe("L-b");
});

it("S06: rejects a pending send when the SSH connection changes during encoding", async () => {
  useSessionStore.setState({ sessions: [raceSession("race-ssh")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "race-1", sessionId: "race-ssh", protocol: "ssh", status: "connected", connectionId: "old-conn" } as TerminalTab,
    ],
    activeTabId: "race-1",
  });
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );

  const pending = useTerminalStore.getState().sendTextToTab("race-1", "中文");
  await vi.advanceTimersByTimeAsync(0);
  useTerminalStore.setState((state) => ({
    tabs: state.tabs.map((t) => (t.tabId === "race-1" ? { ...t, connectionId: "new-conn" } : t)),
  }));
  finishEncode([0xc4, 0xe3]);

  await expect(pending).rejects.toThrow();
  expect(writeTerminal).not.toHaveBeenCalled();
});

it("S06: rejects a pending send when the tab is closed or reconnected during encoding", async () => {
  useSessionStore.setState({ sessions: [raceSession("race-close")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "race-2", sessionId: "race-close", protocol: "ssh", status: "connected", connectionId: "conn-2" } as TerminalTab,
    ],
    activeTabId: "race-2",
  });
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );

  const pending = useTerminalStore.getState().sendTextToTab("race-2", "中文");
  await vi.advanceTimersByTimeAsync(0);
  await useTerminalStore.getState().closeTab("race-2");
  finishEncode([0xc4, 0xe3]);

  await expect(pending).rejects.toThrow();
  expect(writeTerminal).not.toHaveBeenCalled();
});

it("S06: rejects a pending send when the same serial card is reopened during encoding", async () => {
  useSessionStore.setState({ sessions: [raceSession("race-serial", "serial")] });
  useTerminalStore.setState({
    tabs: [
      {
        ...tab,
        tabId: "race-serial",
        sessionId: "race-serial",
        protocol: "serial",
        cardId: "card-race",
        connectionId: null,
        status: "connected",
        serialConfig,
      } as TerminalTab,
    ],
    activeTabId: "race-serial",
  });
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );

  const pending = useTerminalStore.getState().sendTextToTab("race-serial", "中文");
  await vi.advanceTimersByTimeAsync(0);
  // 真实链路：设备先断开（connected 态下 reconnectTab 本就早退），再按同一 cardId 重开
  useTerminalStore.getState().markDisconnected("race-serial", "device reset");
  const reconnecting = useTerminalStore.getState().reconnectTab("race-serial");
  await vi.advanceTimersByTimeAsync(0);
  finishEncode([0xc4, 0xe3]);

  await expect(pending).rejects.toThrow();
  await reconnecting;
  expect(closeSerial).toHaveBeenCalledWith("card-race");
  expect(openSerial).toHaveBeenCalledWith("card-race", serialConfig, false);
  expect(sendSerial).not.toHaveBeenCalled();
});

// ── Task7 R06–R09：先在未修复实现上作为红测复现，再做最小修复 ──
const serialRaceTab = (tabId: string, cardId: string) =>
  ({
    ...tab,
    tabId,
    sessionId: "serial-close-session",
    protocol: "serial",
    cardId,
    connectionId: null,
    status: "connected",
    serialConfig,
  }) as unknown as TerminalTab;

const reconnectSsh = async (tabId: string, sessionId: string, connectionId: string) => {
  vi.mocked(connectSession).mockResolvedValue({ connection_id: connectionId, session_id: sessionId });
  useTerminalStore.getState().markDisconnected(tabId, "link reset");
  await useTerminalStore.getState().reconnectTab(tabId);
};

it("R06: a stale terminalEncode rejection after a reconnect is not reported as a write failure", async () => {
  useSessionStore.setState({ sessions: [raceSession("r06-ssh")] });
  useTerminalStore.setState({
    tabs: [{ ...tab, tabId: "r06-ssh-tab", sessionId: "r06-ssh", protocol: "ssh", status: "connected", connectionId: "r06-old" } as TerminalTab],
    activeTabId: "r06-ssh-tab",
  });
  let failEncode!: (error: Error) => void;
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((_resolve, reject) => { failEncode = reject; })
  );

  const pending = useTerminalStore.getState().sendTextToTab("r06-ssh-tab", "中文");
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(connectSession).mockResolvedValue({ connection_id: "r06-new", session_id: "r06-ssh" });
  useTerminalStore.getState().markDisconnected("r06-ssh-tab", "link reset");
  const reconnecting = useTerminalStore.getState().reconnectTab("r06-ssh-tab");
  await vi.advanceTimersByTimeAsync(0);
  failEncode(new Error("encoder unavailable"));
  await reconnecting;

  await expect(pending).rejects.toMatchObject({ name: "StaleTargetError" });
  expect(writeTerminal).not.toHaveBeenCalled();
  expect(findTab("r06-ssh-tab")).toMatchObject({ status: "connected", connectionId: "r06-new" });
});

it("R06: a stale writeTerminal rejection after a reconnect is not reported as a write failure", async () => {
  useTerminalStore.setState({
    tabs: [{ ...tab, tabId: "r06-write", status: "connected", connectionId: "r06-w-old" } as TerminalTab],
    activeTabId: "r06-write",
  });
  let failWrite!: (error: Error) => void;
  vi.mocked(writeTerminal).mockImplementationOnce(
    () => new Promise<number>((_resolve, reject) => { failWrite = reject; })
  );

  const pending = useTerminalStore.getState().sendTextToTab("r06-write", "A");
  await vi.advanceTimersByTimeAsync(0);
  await reconnectSsh("r06-write", "session", "r06-w-new");
  failWrite(new Error("pty write failed"));

  await expect(pending).rejects.toMatchObject({ name: "StaleTargetError" });
  expect(findTab("r06-write")).toMatchObject({ status: "connected", connectionId: "r06-w-new" });
});

it("R07: closeTab expires pending serial sends before the deferred closeCard resolves", async () => {
  useTerminalStore.setState({
    tabs: [serialRaceTab("r07-tab", "r07-card")],
    activeTabId: "r07-tab",
  });
  useSerialStore.setState({ sendText: "AT", sendIsHex: false, newlineMode: "none", sendError: null });
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );

  const pendingSend = useSerialStore.getState().sendCurrent("r07-card", "gb18030");
  await vi.advanceTimersByTimeAsync(0);

  let finishCloseCard!: () => void;
  vi.mocked(closeCard).mockImplementationOnce(
    () => new Promise<void>((resolve) => { finishCloseCard = resolve; })
  );
  const closing = useTerminalStore.getState().closeTab("r07-tab");
  await vi.advanceTimersByTimeAsync(0);
  expect(useTerminalStore.getState().tabs).toHaveLength(0);

  // closeCard 仍然 pending：旧编码结果不能落到旧句柄或随后重开的同 cardId 句柄
  finishEncode([0x41]);
  await expect(pendingSend).rejects.toThrow();
  expect(sendSerial).not.toHaveBeenCalled();

  finishCloseCard();
  await closing;
});

it("R07: reopening the same card accepts a fresh send but still rejects the stale one", async () => {
  useTerminalStore.setState({
    tabs: [serialRaceTab("r07-reopen", "r07-reopen-card")],
    activeTabId: "r07-reopen",
  });
  useSerialStore.setState({ sendText: "AT", sendIsHex: false, newlineMode: "none", sendError: null });
  let finishStale!: (value: number[]) => void;
  let finishFresh!: (value: number[]) => void;
  vi.mocked(terminalEncode)
    .mockImplementationOnce(() => new Promise<number[]>((resolve) => { finishStale = resolve; }))
    .mockImplementationOnce(() => new Promise<number[]>((resolve) => { finishFresh = resolve; }));

  const staleSend = useSerialStore.getState().sendCurrent("r07-reopen-card", "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  await useTerminalStore.getState().closeTab("r07-reopen");

  // 相同 cardId 重新打开：新发送领到新代次，旧发送仍是旧代次
  const freshSend = useSerialStore.getState().sendCurrent("r07-reopen-card", "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  finishFresh([0x42]);
  await freshSend;
  expect(sendSerial).toHaveBeenCalledTimes(1);
  expect(sendSerial).toHaveBeenCalledWith("r07-reopen-card", expect.any(Uint8Array));

  finishStale([0x41]);
  await expect(staleSend).rejects.toThrow();
  expect(sendSerial).toHaveBeenCalledTimes(1);
});

it("R09: freezes the whole broadcast set so a tab reconnecting during A's await gets no old command", async () => {
  useSessionStore.setState({ sessions: [raceSession("r09")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "r09-A", sessionId: "r09", protocol: "ssh", status: "connected", connectionId: "r09-conn-A" } as TerminalTab,
      { ...tab, tabId: "r09-B", sessionId: "r09", protocol: "ssh", status: "connected", connectionId: "r09-conn-B" } as TerminalTab,
      { ...tab, tabId: "r09-C", sessionId: "r09", protocol: "ssh", status: "connected", connectionId: "r09-conn-C" } as TerminalTab,
    ],
    activeTabId: "r09-A",
  });
  let finishA!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockResolvedValue([0x43]);
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishA = resolve; })
  );

  const broadcast = useTerminalStore.getState().sendCommandToTabs("ls", { allTabs: true });
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(connectSession).mockResolvedValue({ connection_id: "r09-conn-B-new", session_id: "r09" });
  useTerminalStore.getState().markDisconnected("r09-B", "network reset");
  const reconnectB = useTerminalStore.getState().reconnectTab("r09-B");
  await vi.advanceTimersByTimeAsync(0);
  finishA([0x41]);
  await reconnectB;
  await broadcast;

  expect(terminalEncode).toHaveBeenNthCalledWith(1, "ls\r", "gb18030");
  expect(writeTerminal).toHaveBeenCalledWith("r09-A", new Uint8Array([0x41]));
  expect(writeTerminal).toHaveBeenCalledWith("r09-C", new Uint8Array([0x43]));
  expect(writeTerminal).not.toHaveBeenCalledWith("r09-B", expect.anything());
  expect(findTab("r09-B")).toMatchObject({ status: "connected", connectionId: "r09-conn-B-new" });
  expect(findTab("r09-B")?.error).toBeUndefined();
});

it("R09: a tab closed during A's await is dropped and an unchanged C still receives the command", async () => {
  useSessionStore.setState({ sessions: [raceSession("r09-close")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "r09c-A", sessionId: "r09-close", status: "connected" } as TerminalTab,
      { ...tab, tabId: "r09c-B", sessionId: "r09-close", status: "connected" } as TerminalTab,
      { ...tab, tabId: "r09c-C", sessionId: "r09-close", status: "connected" } as TerminalTab,
    ],
    activeTabId: "r09c-A",
  });
  let finishA!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockResolvedValue([0x43]);
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishA = resolve; })
  );

  const broadcast = useTerminalStore.getState().sendCommandToTabs("ls", { allTabs: true });
  await vi.advanceTimersByTimeAsync(0);
  const closing = useTerminalStore.getState().closeTab("r09c-B");
  await vi.advanceTimersByTimeAsync(0);
  finishA([0x41]);
  await closing;
  await broadcast;

  expect(writeTerminal).not.toHaveBeenCalledWith("r09c-B", expect.anything());
  expect(writeTerminal).toHaveBeenCalledWith("r09c-C", new Uint8Array([0x43]));
  expect(findTab("r09c-B")).toBeUndefined();
});

it("R09: the frozen broadcast keeps the selected tab, CRLF payload, active tab and history", async () => {
  useSessionStore.setState({ sessions: [raceSession("r09-select")] });
  useTerminalStore.setState({
    tabs: [
      { ...tab, tabId: "r09s-A", sessionId: "r09-select", status: "connected" } as TerminalTab,
      { ...tab, tabId: "r09s-B", sessionId: "r09-select", status: "connected" } as TerminalTab,
    ],
    activeTabId: "r09s-A",
    commandHistory: [],
  });
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);

  await useTerminalStore.getState().sendCommandToTabs("ls");

  expect(terminalEncode).toHaveBeenCalledTimes(1);
  expect(terminalEncode).toHaveBeenCalledWith("ls\r", "gb18030");
  expect(writeTerminal).toHaveBeenCalledTimes(1);
  expect(writeTerminal).toHaveBeenCalledWith("r09s-A", new Uint8Array([0x41]));
  expect(useTerminalStore.getState().activeTabId).toBe("r09s-A");
  expect(useTerminalStore.getState().commandHistory).toHaveLength(0);
});

it("R08: a late first-open launch whose cleanup fails keeps a retryable launch_id owner", async () => {
  let finishLaunch!: (value: any) => void;
  vi.mocked(launchRdp).mockImplementationOnce(
    () => new Promise((resolve) => { finishLaunch = resolve; })
  );
  const opening = useTerminalStore.getState().openSessionTab(rdpSession("r08-first"));
  const tabId = useTerminalStore.getState().tabs.at(-1)!.tabId;
  await vi.advanceTimersByTimeAsync(0);
  await useTerminalStore.getState().closeTab(tabId);
  expect(findTab(tabId)).toBeUndefined();

  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("kill denied"));
  finishLaunch(launchResult("L-orphan-first", "r08-first"));
  await opening;

  expect(rdpClose).toHaveBeenCalledWith("L-orphan-first");
  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([
    expect.objectContaining({ tabId, launchId: "L-orphan-first", error: expect.any(String) }),
  ]);
  expect(typeof useTerminalStore.getState().retryRdpCleanups).toBe("function");

  await useTerminalStore.getState().retryRdpCleanups();
  expect(rdpClose).toHaveBeenCalledTimes(2);
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
  expect(findTab(tabId)).toBeUndefined();
});

it("R08: a late restart launch whose cleanup fails keeps a retryable owner without reviving the tab", async () => {
  useTerminalStore.setState({ tabs: [rdpRaceTab("r08-late", "L-old")], activeTabId: "r08-late" });
  let finishLaunch!: (value: any) => void;
  vi.mocked(launchRdp).mockImplementationOnce(
    () => new Promise((resolve) => { finishLaunch = resolve; })
  );
  const restarting = useTerminalStore.getState().reconnectTab("r08-late");
  await vi.advanceTimersByTimeAsync(0);
  await useTerminalStore.getState().closeTab("r08-late");
  expect(findTab("r08-late")).toBeUndefined();

  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("kill denied"));
  finishLaunch(launchResult("L-late-orphan", "rdp-race-session"));
  await restarting;

  expect(rdpClose).toHaveBeenCalledWith("L-late-orphan");
  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([
    expect.objectContaining({ tabId: "r08-late", launchId: "L-late-orphan" }),
  ]);
  await useTerminalStore.getState().retryRdpCleanups();
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
  expect(findTab("r08-late")).toBeUndefined();
});

it("R08: a closeTab rdpClose failure keeps the launch_id for an explicit retry", async () => {
  useTerminalStore.setState({ tabs: [rdpRaceTab("r08-close", "L-close")], activeTabId: "r08-close" });
  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("kill denied"));

  await useTerminalStore.getState().closeTab("r08-close");

  expect(findTab("r08-close")).toBeUndefined();
  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([
    expect.objectContaining({ tabId: "r08-close", launchId: "L-close" }),
  ]);
  await useTerminalStore.getState().retryRdpCleanups();
  expect(rdpClose).toHaveBeenCalledTimes(2);
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
});
