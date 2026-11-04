import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalStore, type TerminalTab } from "./terminalStore";
import { closeConnection, closeTerminal, connectSession, forwardList } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  closeConnection: vi.fn(), closeTerminal: vi.fn(), connectSession: vi.fn(), forwardList: vi.fn(),
  closeSerial: vi.fn(), closeCard: vi.fn(),
}));
const tab = { tabId: "tab", sessionId: "session", sessionName: "Test host", protocol: "ssh", connectionId: "old-connection", status: "connected", currentMode: "command" } as TerminalTab;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(closeConnection).mockResolvedValue(undefined);
  vi.mocked(closeTerminal).mockResolvedValue(undefined);
  vi.mocked(forwardList).mockResolvedValue([]);
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
