import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { XtermView } from "./XtermView";
import type { TerminalTab } from "../stores/terminalStore";
import { useToastStore } from "../stores/toastStore";
import { useTerminalStore } from "../stores/terminalStore";
import { openTerminal } from "../lib/ipc";

const { term, keys } = vi.hoisted(() => {
  const keys: { handler?: (event: KeyboardEvent) => boolean } = {};
  return { keys, term: {
    options: {}, unicode: {}, cols: 80, rows: 24, selection: "",
    loadAddon: vi.fn(), open: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
    writeln: vi.fn(), write: vi.fn(), paste: vi.fn(), clear: vi.fn(),
    selectAll: vi.fn(), scrollToBottom: vi.fn(),
    getSelection: vi.fn(() => ""), hasSelection: vi.fn(() => false),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
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
vi.mock("../lib/ipc", () => ({
  ackTerminal: vi.fn().mockResolvedValue(undefined), openTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined), writeTerminal: vi.fn().mockResolvedValue(1),
  sendSerial: vi.fn().mockResolvedValue(1), readSerial: vi.fn().mockResolvedValue([]),
  closeTerminal: vi.fn().mockResolvedValue(undefined), closeConnection: vi.fn().mockResolvedValue(undefined),
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
