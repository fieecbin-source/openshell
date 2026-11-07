import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalHost } from "./TerminalHost";
import { useTerminalStore, type TerminalTab } from "../stores/terminalStore";
import { useSerialStore } from "../stores/serialStore";
import { sendSerial } from "../lib/ipc";

vi.mock("./XtermView", () => ({ XtermView: () => null }));
vi.mock("./SerialControlBar", () => ({ SerialControlBar: () => null }));
vi.mock("./SerialSendBar", () => ({ SerialSendBar: () => null }));
vi.mock("./HexDumpView", () => ({ HexDumpView: () => null }));
vi.mock("./RdpSessionView", () => ({ RdpSessionView: () => null }));
vi.mock("../stores/sessionStore", () => ({
  useSessionStore: { getState: () => ({ sessions: [] }), setState: vi.fn() },
}));
vi.mock("../lib/ipc", () => ({
  closeConnection: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  closeSerial: vi.fn().mockResolvedValue(undefined),
  connectSession: vi.fn(),
  createCard: vi.fn(),
  closeCard: vi.fn().mockResolvedValue(undefined),
  setCardMode: vi.fn(),
  openSerial: vi.fn().mockResolvedValue(undefined),
  forwardList: vi.fn().mockResolvedValue([]),
  forwardStart: vi.fn(),
  launchRdp: vi.fn(),
  rdpGetStatus: vi.fn(),
  rdpClose: vi.fn().mockResolvedValue(undefined),
  writeTerminal: vi.fn(),
  sendSerial: vi.fn(),
  listSerialPorts: vi.fn(),
  setSerialLines: vi.fn(),
  getSerialModemStatus: vi.fn(),
  getSerialStats: vi.fn(),
  readSerial: vi.fn().mockResolvedValue([]),
  terminalEncode: vi.fn(),
}));

const serialTab = (tabId: string, cardId: string) =>
  ({
    tabId,
    sessionId: "t8-session",
    sessionName: tabId,
    protocol: "serial",
    cardId,
    connectionId: null,
    status: "connected",
    currentMode: "command",
  }) as unknown as TerminalTab;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(sendSerial).mockImplementation(async (cardId, bytes) => {
    if (cardId === "card-A") throw new Error("write failed");
    return bytes.length;
  });
  useSerialStore.setState({
    sendText: "AT",
    sendIsHex: false,
    newlineMode: "none",
    timerIntervalMs: 10,
    isTimerRunning: false,
    timerHandle: null,
    timerCardId: null,
    sendError: null,
    history: [],
    stats: {},
  });
  useTerminalStore.setState({
    tabs: [serialTab("tab-A", "card-A"), serialTab("tab-B", "card-B")],
    activeTabId: "tab-A",
    rdpCleanupFailures: [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  useSerialStore.getState().stopTimer();
  act(() => root.unmount());
  container.remove();
});

it("T8-9: a real send failure on A is consumed by TerminalHost without stopping B's timer", async () => {
  await act(async () => {
    root.render(<TerminalHost visible />);
  });

  useSerialStore.getState().startTimer("card-B", "utf-8");
  expect(useSerialStore.getState().timerCardId).toBe("card-B");

  // A 的真实 sendSerial 失败：failSerialSend 写 sendError，TerminalHost 的 effect 消费它
  await act(async () => {
    await expect(
      useSerialStore.getState().sendCurrent("card-A", "utf-8")
    ).rejects.toThrow("write failed");
  });

  // markDisconnected(A) 的停止动作在此 flush；随后 B 的 timer 必须继续真实写入
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(useTerminalStore.getState().tabs.find((t) => t.tabId === "tab-A")?.status).toBe("disconnected");
  expect(useSerialStore.getState().isTimerRunning).toBe(true);
  expect(useSerialStore.getState().timerCardId).toBe("card-B");
  const bWrites = vi.mocked(sendSerial).mock.calls.filter(([cardId]) => cardId === "card-B");
  expect(bWrites.length).toBeGreaterThan(0);
});
