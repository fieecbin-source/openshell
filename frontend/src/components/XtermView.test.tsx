import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { XtermView } from "./XtermView";
import type { TerminalTab } from "../stores/terminalStore";
import { useToastStore } from "../stores/toastStore";
import { useTerminalStore } from "../stores/terminalStore";
import { openTerminal, writeTerminal } from "../lib/ipc";
import { useSettingsStore } from "../stores/settingsStore";
import { appendSessionLog } from "../lib/terminal-log";

const { term, keys, data } = vi.hoisted(() => {
  const keys: { handler?: (event: KeyboardEvent) => boolean } = {};
  const data: { handler?: (value: string) => void } = {};
  return { keys, data, term: {
    options: {}, unicode: {}, cols: 80, rows: 24, selection: "",
    loadAddon: vi.fn(), open: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
    writeln: vi.fn(), write: vi.fn(), paste: vi.fn(), clear: vi.fn(),
    selectAll: vi.fn(), scrollToBottom: vi.fn(),
    getSelection: vi.fn(() => ""), hasSelection: vi.fn(() => false),
    onData: vi.fn((handler) => { data.handler = handler; return { dispose: vi.fn() }; }),
    attachCustomKeyEventHandler: vi.fn((handler) => { keys.handler = handler; }),
    buffer: { active: { length: 0, getLine: vi.fn() } },
  } };
});
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn(function () { return term; }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));
vi.mock("../lib/terminal-log", () => ({ appendSessionLog: vi.fn(), dropSessionLog: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  ackTerminal: vi.fn().mockResolvedValue(undefined), openTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined), writeTerminal: vi.fn().mockResolvedValue(1),
  sendSerial: vi.fn().mockResolvedValue(1), readSerial: vi.fn().mockResolvedValue([]),
  closeTerminal: vi.fn().mockResolvedValue(undefined), closeConnection: vi.fn().mockResolvedValue(undefined),
  connectSession: vi.fn(), createCard: vi.fn(), closeCard: vi.fn(), setCardMode: vi.fn(),
  forwardList: vi.fn(), forwardStart: vi.fn(), openSerial: vi.fn(), closeSerial: vi.fn(),
  launchRdp: vi.fn(), rdpGetStatus: vi.fn(), rdpClose: vi.fn(), terminalEncode: vi.fn(),
  createGroup: vi.fn(), createSession: vi.fn(), deleteGroup: vi.fn(), deleteSession: vi.fn(),
  duplicateSession: vi.fn(), listGroups: vi.fn(), listSessions: vi.fn(), renameGroup: vi.fn(),
  updateSession: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
const tab = { tabId: "tab", sessionId: "session", sessionName: "Test host", protocol: "ssh", connectionId: "connection", status: "connected", currentMode: "command" } as TerminalTab;
const click = (text: string) => [...document.querySelectorAll("button")].find((button) => button.textContent === text)!.click();

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue(""),
  } });
  term.getSelection.mockReturnValue("");
  term.hasSelection.mockReturnValue(false);
  useTerminalStore.setState({ tabs: [tab], activeTabId: tab.tabId });
  useSettingsStore.setState({ logSessionOutput: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<XtermView tab={tab} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useToastStore.getState().clear();
});

it("copies once on Ctrl+C with feedback, and preserves Ctrl+C without a selection", async () => {
  term.getSelection.mockReturnValue("selected text");
  term.hasSelection.mockReturnValue(true);
  await act(async () => {
    expect(keys.handler!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false);
    expect(keys.handler!(new KeyboardEvent("keyup", { key: "c", ctrlKey: true }))).toBe(true);
  });
  expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
  expect(useToastStore.getState().toasts.at(-1)?.title).toBe("已复制到剪贴板");
  term.hasSelection.mockReturnValue(false);
  expect(keys.handler!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
});

it("renders a keyboard accessible context menu and closes it with Escape", () => {
  act(() => container.querySelector(".z-10")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })));
  const menu = document.querySelector('[role="menu"][aria-label="终端操作"]')!;
  expect(menu).not.toBeNull();
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(16);
  expect([...menu.querySelectorAll("button")].find((button) => button.textContent?.includes("复制选中内容"))!.disabled).toBe(true);
  expect(menu.contains(document.activeElement)).toBe(true);
  act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement?.textContent).toBe("全选");
  act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(term.focus).toHaveBeenCalled();
});

it("previews multiline paste and only passes it to xterm after confirmation", async () => {
  vi.mocked(navigator.clipboard.readText).mockResolvedValue("echo first\necho second");
  await act(async () => { keys.handler!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true })); });
  expect(term.paste).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"][aria-label="粘贴多行内容"]')).not.toBeNull();
  act(() => click("确认粘贴"));
  expect(term.paste).toHaveBeenCalledWith("echo first\necho second");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("marks a failed PTY channel disconnected instead of displaying a healthy connection", async () => {
  vi.mocked(openTerminal).mockRejectedValueOnce(new Error("channel open failed"));
  const replacement = { ...tab, connectionId: "new-connection" };
  useTerminalStore.setState({ tabs: [replacement] });
  await act(async () => root.render(<XtermView tab={replacement} />));
  expect(useTerminalStore.getState().tabs[0].status).toBe("disconnected");
  expect(useTerminalStore.getState().tabs[0].connectionId).toBeNull();
});

it("only retries on a deliberate Enter keydown while disconnected", () => {
  const reconnect = vi.spyOn(useTerminalStore.getState(), "reconnectTab").mockResolvedValue(undefined);
  useTerminalStore.setState({ tabs: [{ ...tab, status: "disconnected", connectionId: null }] });
  expect(keys.handler!(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  expect(keys.handler!(new KeyboardEvent("keyup", { key: "Enter" }))).toBe(true);
  expect(keys.handler!(new KeyboardEvent("keydown", { key: "Enter", repeat: true }))).toBe(false);
  expect(reconnect).not.toHaveBeenCalled();
  const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  expect(keys.handler!(enter)).toBe(false);
  expect(enter.defaultPrevented).toBe(true);
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(reconnect).toHaveBeenCalledWith(tab.tabId);
  reconnect.mockRestore();
});

it("applies session logging changes to the existing terminal channel", () => {
  const incoming = vi.mocked(openTerminal).mock.calls[0][4];
  const frame = [1, 0, 0, 0, 0, 65];
  incoming(frame);
  expect(appendSessionLog).not.toHaveBeenCalled();
  act(() => useSettingsStore.setState({ logSessionOutput: true }));
  incoming(frame);
  expect(appendSessionLog).toHaveBeenCalledWith(tab.tabId, new Uint8Array([65]));
  act(() => useSettingsStore.setState({ logSessionOutput: false }));
  incoming(frame);
  expect(appendSessionLog).toHaveBeenCalledTimes(1);
  expect(openTerminal).toHaveBeenCalledTimes(1);
});

it("ignores channel data delivered after the terminal view was disposed", () => {
  const incoming = vi.mocked(openTerminal).mock.calls[0][4];
  act(() => root.render(null));
  term.write.mockClear();
  incoming([1, 0, 0, 0, 0, 65]);
  expect(term.write).not.toHaveBeenCalled();
});

it("routes keyboard input through sendTextToTab without marking a changed connection disconnected", async () => {
  const original = useTerminalStore.getState().sendTextToTab;
  let rejectSend!: (error: Error) => void;
  const send = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
  try {
    useTerminalStore.setState({ sendTextToTab: send });

    act(() => { data.handler!("A"); });
    expect(send).toHaveBeenCalledWith("tab", "A");

    // 发送等待期间同 tab 换了连接：store 以 StaleTargetError 取消本次发送，
    // XtermView 不能把新连接误标成 disconnected，也不能自行写 PTY。
    act(() => useTerminalStore.setState({ tabs: [{ ...tab, connectionId: "new-connection" }] }));
    const stale = new Error("目标标签连接已变更，本次发送已取消");
    stale.name = "StaleTargetError";
    rejectSend(stale);
    await act(async () => { await Promise.resolve(); });

    expect(writeTerminal).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      status: "connected",
      connectionId: "new-connection",
    });
  } finally {
    useTerminalStore.setState({ sendTextToTab: original });
  }
});

it("R06: a stale write failure after a reconnect never marks the new connection disconnected", async () => {
  const markDisconnected = vi.spyOn(useTerminalStore.getState(), "markDisconnected");
  let rejectWrite!: (error: Error) => void;
  vi.mocked(writeTerminal).mockImplementationOnce(
    () => new Promise<number>((_resolve, reject) => { rejectWrite = reject; })
  );
  try {
    act(() => { data.handler!("A"); });
    // 等真实发送链走到 writeTerminal（该 promise 保持 pending），再触发重连
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    // 真实断开动作递增连接代次，再模拟同 tab 重连完成
    act(() => { useTerminalStore.getState().markDisconnected("tab", "link reset"); });
    act(() => {
      useTerminalStore.setState({
        tabs: [{ ...tab, connectionId: "new-connection", status: "connected" }],
      });
    });
    markDisconnected.mockClear();

    rejectWrite(new Error("pty write failed"));
    await act(async () => { await Promise.resolve(); });

    expect(markDisconnected).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().tabs[0]).toMatchObject({
      status: "connected",
      connectionId: "new-connection",
    });
  } finally {
    markDisconnected.mockRestore();
  }
});
