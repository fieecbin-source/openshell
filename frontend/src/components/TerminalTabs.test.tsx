import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalTabs } from "./TerminalTabs";
import { useTerminalStore, type TerminalTab } from "../stores/terminalStore";
import { rdpClose } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  ackTerminal: vi.fn().mockResolvedValue(undefined),
  openTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminal: vi.fn().mockResolvedValue(1),
  sendSerial: vi.fn().mockResolvedValue(1),
  readSerial: vi.fn().mockResolvedValue([]),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  connectSession: vi.fn(),
  createCard: vi.fn(),
  closeCard: vi.fn(),
  setCardMode: vi.fn(),
  forwardList: vi.fn().mockResolvedValue([]),
  forwardStart: vi.fn(),
  openSerial: vi.fn().mockResolvedValue(undefined),
  closeSerial: vi.fn().mockResolvedValue(undefined),
  launchRdp: vi.fn(),
  rdpGetStatus: vi.fn(),
  rdpClose: vi.fn(),
  terminalEncode: vi.fn(),
  createGroup: vi.fn(),
  createSession: vi.fn(),
  deleteGroup: vi.fn(),
  deleteSession: vi.fn(),
  duplicateSession: vi.fn(),
  listGroups: vi.fn(),
  listSessions: vi.fn(),
  renameGroup: vi.fn(),
  updateSession: vi.fn(),
  listSerialPorts: vi.fn(),
  setSerialLines: vi.fn(),
  getSerialModemStatus: vi.fn(),
  getSerialStats: vi.fn(),
}));

const FAILURE = { tabId: "t8-rdp-tab", launchId: "L-T8-orphan", error: "kill denied" };
const alert = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="远程桌面实例清理失败"]');

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useTerminalStore.setState({ tabs: [], activeTabId: null, rdpCleanupFailures: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderTabs = async () => {
  await act(async () => {
    root.render(<TerminalTabs />);
  });
};

it("T8-10: a failed cleanup keeps its launch_id visible and retry succeeds then clears the alert", async () => {
  // 失败记录来自真实 store 状态（closeTab / late launch 的 recordRdpCleanupFailure 路径）
  useTerminalStore.setState({ rdpCleanupFailures: [FAILURE] });
  await renderTabs();

  expect(alert()).not.toBeNull();
  expect(alert()!.title).toContain(FAILURE.launchId);
  expect(alert()!.title).toContain(FAILURE.error);
  expect(alert()!.getAttribute("aria-label")).toContain("1 项");
  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([FAILURE]);

  vi.mocked(rdpClose).mockResolvedValue(undefined);
  await act(async () => {
    alert()!.click();
  });

  expect(rdpClose).toHaveBeenCalledWith(FAILURE.launchId);
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
  expect(alert()).toBeNull();
});

it("T8-11: a retry that fails again keeps the same launch_id and the alert stays actionable", async () => {
  useTerminalStore.setState({ rdpCleanupFailures: [FAILURE] });
  await renderTabs();

  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("kill denied again"));
  await act(async () => {
    alert()!.click();
  });

  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([
    expect.objectContaining({ tabId: FAILURE.tabId, launchId: FAILURE.launchId }),
  ]);
  expect(alert()).not.toBeNull();
  expect(alert()!.title).toContain(FAILURE.launchId);

  vi.mocked(rdpClose).mockResolvedValueOnce(undefined);
  await act(async () => {
    alert()!.click();
  });
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
  expect(alert()).toBeNull();
});

it("T8-13: a real closeTab rdpClose failure keeps the launch_id in the visible alert until retry succeeds", async () => {
  const launchId = "L-T8-close-failure";
  useTerminalStore.setState({
    tabs: [
      {
        tabId: "t8-rdp-close-tab",
        sessionId: "t8-rdp-close-session",
        sessionName: "RDP host",
        protocol: "rdp",
        connectionId: null,
        status: "connected",
        currentMode: "command",
        rdpInfo: { launch_id: launchId },
      } as unknown as TerminalTab,
    ],
    activeTabId: "t8-rdp-close-tab",
    rdpCleanupFailures: [],
  });

  // 真实 closeTab 的 closeRdp 步骤失败：recordRdpCleanupFailure 保留 launch_id 所有权
  vi.mocked(rdpClose).mockRejectedValueOnce(new Error("kill denied"));
  await act(async () => {
    await useTerminalStore.getState().closeTab("t8-rdp-close-tab");
  });
  expect(useTerminalStore.getState().rdpCleanupFailures).toEqual([
    expect.objectContaining({ tabId: "t8-rdp-close-tab", launchId }),
  ]);

  await renderTabs();
  expect(alert()).not.toBeNull();
  expect(alert()!.title).toContain(launchId);

  vi.mocked(rdpClose).mockResolvedValueOnce(undefined);
  await act(async () => {
    alert()!.click();
  });
  expect(rdpClose).toHaveBeenCalledWith(launchId);
  expect(useTerminalStore.getState().rdpCleanupFailures).toHaveLength(0);
  expect(alert()).toBeNull();
});
