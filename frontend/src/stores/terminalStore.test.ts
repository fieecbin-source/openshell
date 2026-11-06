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
import { closeSerial, createCard, launchRdp, openSerial } from "../lib/ipc";
import type { SerialProfileConfig, Session } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  closeConnection: vi.fn(), closeTerminal: vi.fn(), connectSession: vi.fn(), forwardList: vi.fn(),
  closeSerial: vi.fn(), closeCard: vi.fn(), createCard: vi.fn(), openSerial: vi.fn(), launchRdp: vi.fn(),
  rdpClose: vi.fn(), rdpGetStatus: vi.fn(), sendSerial: vi.fn(), writeTerminal: vi.fn(), terminalEncode: vi.fn(),
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
  useTerminalStore.setState({ tabs: [{ ...tab }], activeTabId: tab.tabId });
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
