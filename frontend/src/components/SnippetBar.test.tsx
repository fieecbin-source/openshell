import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnippetBar } from "./SnippetBar";
import { useSnippetStore } from "../stores/snippetStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore, type TerminalTab } from "../stores/terminalStore";
import { sendSerial, terminalEncode, writeTerminal } from "../lib/ipc";
import type { Session, Snippet } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  writeTerminal: vi.fn().mockResolvedValue(1),
  sendSerial: vi.fn().mockResolvedValue(1),
  terminalEncode: vi.fn().mockImplementation(async (text: string, encoding: string) => {
    if (encoding.toLowerCase() === "gb18030") {
      // 模拟 GB18030 编码结果
      return [0xc4, 0xe3, 0xba, 0xc3];
    }
    return Array.from(new TextEncoder().encode(text));
  }),
}));

vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const makeSnippet = (overrides?: Partial<Snippet>): Snippet => ({
  id: "snippet_1",
  group_id: null,
  name: "测试命令",
  kind: "snippet",
  body: "uptime",
  shortcut: null,
  send_mode: "execute",
  sort_order: 0,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  ...overrides,
});

const originalSendTextToTab = useTerminalStore.getState().sendTextToTab;

describe("SnippetBar (R05, R09)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({ sendTextToTab: originalSendTextToTab });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("exposes the full long name and sends command via sendTextToTab in execute mode", async () => {
    const name = "查看生产服务器服务日志".repeat(12);
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    useTerminalStore.setState({
      tabs: [{ tabId: "active-terminal", status: "connected" } as TerminalTab],
      sendTextToTab: sendSpy,
    });
    useSnippetStore.setState({
      snippets: [makeSnippet({ id: "snippet", name, body: "uptime", send_mode: "execute" })],
      loadSnippets: vi.fn(),
    });

    await act(async () => {
      root.render(<SnippetBar activeTabId="active-terminal" />);
    });

    const button = container.querySelector<HTMLButtonElement>("[aria-label]")!;
    expect(button.getAttribute("aria-label")).toBe(name);
    expect(button.title).toContain(name);

    await act(async () => {
      button.click();
    });

    // R09: 必须通过 sendTextToTab 发送，且 execute 模式附加换行
    expect(sendSpy).toHaveBeenCalledWith("active-terminal", "uptime\n");
  });

  it("sends command via sendTextToTab in insert mode without trailing newline", async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    useTerminalStore.setState({
      tabs: [{ tabId: "active-terminal", status: "connected" } as TerminalTab],
      sendTextToTab: sendSpy,
    });
    useSnippetStore.setState({
      snippets: [
        makeSnippet({
          id: "snip_insert",
          name: "Git Status",
          body: "git status",
          send_mode: "insert",
        }),
      ],
      loadSnippets: vi.fn(),
    });

    await act(async () => {
      root.render(<SnippetBar activeTabId="active-terminal" />);
    });

    const button = container.querySelector<HTMLButtonElement>("[aria-label='Git Status']")!;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
    });

    // insert 模式不附加换行
    expect(sendSpy).toHaveBeenCalledWith("active-terminal", "git status");
  });

  it("expands variable placeholders in parameter modal before sending to terminal", async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    useTerminalStore.setState({
      tabs: [{ tabId: "active-terminal", status: "connected" } as TerminalTab],
      sendTextToTab: sendSpy,
    });
    useSnippetStore.setState({
      snippets: [
        makeSnippet({
          id: "snip_var",
          name: "Ping Host",
          body: "ping ${HOST:-127.0.0.1} -c ${COUNT:-4}",
          send_mode: "execute",
        }),
      ],
      loadSnippets: vi.fn(),
    });

    await act(async () => {
      root.render(<SnippetBar activeTabId="active-terminal" />);
    });

    const snippetBtn = container.querySelector<HTMLButtonElement>("[aria-label='Ping Host']")!;
    await act(async () => {
      snippetBtn.click();
    });

    // 弹窗出现，具有两个参数输入框
    const inputs = Array.from(document.body.querySelectorAll<HTMLInputElement>("input[aria-label='命令参数']"));
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("127.0.0.1");
    expect(inputs[1].value).toBe("4");

    // 修改第一个参数
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[0], "192.168.1.1");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    });

    const sendBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("发送到终端")
    );
    expect(sendBtn).toBeTruthy();

    await act(async () => {
      sendBtn!.click();
    });

    expect(sendSpy).toHaveBeenCalledWith("active-terminal", "ping 192.168.1.1 -c 4\n");
  });

  it("end-to-end integration: serial session with GB18030 encoding routes through sendSerial", async () => {
    // 设置会话为 GB18030 编码的串口会话
    const serialSession = {
      id: "sess_serial",
      name: "Serial Console",
      protocol: "serial",
      encoding: "gb18030",
    } as Session;

    useSessionStore.setState({ sessions: [serialSession] });

    useTerminalStore.setState({
      tabs: [
        {
          tabId: "serial_tab_1",
          sessionId: "sess_serial",
          protocol: "serial",
          cardId: "card_serial_99",
          status: "connected",
        } as TerminalTab,
      ],
      // 保持 store 原生 sendTextToTab
    });

    useSnippetStore.setState({
      snippets: [
        makeSnippet({
          id: "snip_serial",
          name: "串口问候",
          body: "你好",
          send_mode: "execute",
        }),
      ],
      loadSnippets: vi.fn(),
    });

    await act(async () => {
      root.render(<SnippetBar activeTabId="serial_tab_1" />);
    });

    const button = container.querySelector<HTMLButtonElement>("[aria-label='串口问候']")!;
    await act(async () => {
      button.click();
    });

    // 验证 terminalEncode 被传入 "你好\n" 及 "gb18030"
    expect(terminalEncode).toHaveBeenCalledWith("你好\n", "gb18030");
    // 串口走 sendSerial，不走 writeTerminal
    expect(sendSerial).toHaveBeenCalledWith("card_serial_99", [0xc4, 0xe3, 0xba, 0xc3]);
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("handles snippet load failure gracefully without unhandled rejection and preserves existing snippets", async () => {
    const existingSnippet = makeSnippet({
      id: "snip_existing_bar",
      name: "Existing Command",
      body: "echo hello",
      send_mode: "execute",
    });

    const failingLoadSnippets = vi.fn().mockRejectedValue(new Error("Snippet backend read error"));
    useSnippetStore.setState({
      snippets: [existingSnippet],
      loadSnippets: failingLoadSnippets,
    });

    await act(async () => {
      root.render(<SnippetBar activeTabId="active-terminal" />);
    });

    expect(failingLoadSnippets).toHaveBeenCalled();
    // Existing snippets must not be wiped out
    const button = container.querySelector<HTMLButtonElement>("[aria-label='Existing Command']");
    expect(button).toBeTruthy();
  });
});
