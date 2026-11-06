import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeHub } from "./HomeHub";
import { useSessionStore } from "../stores/sessionStore";
import type { Group, Protocol, Session } from "../types/ipc";

vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const group = (id: string, name: string): Group => ({
  id, name, kind: "session", parent_id: null, color: null, icon_key: null, notes: null,
  expanded: true, sort_order: 0, created_at: 0, updated_at: 0, deleted_at: null,
});

describe("home group entry points", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onNewSession = vi.fn();
  const onNewSessionWithProtocol = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes(": reduce"), media: query,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSessionStore.setState({ sessions: [], groups: [group("prod", "生产环境"), group("staging", "预发布环境")] });
    act(() => root.render(
      <HomeHub
        onNewSession={onNewSession}
        onNewSessionWithProtocol={onNewSessionWithProtocol}
        onEditSession={vi.fn()}
        onConnectSession={vi.fn()}
      />
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows empty groups so a newly created group can accept its first server", () => {
    expect(container.querySelector('[aria-label="生产环境服务器分组"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="预发布环境服务器分组"]')).not.toBeNull();
    expect(container.textContent).toContain("暂无服务器");
  });

  it("passes the exact group id when creating a server inside an empty group", () => {
    const add = container.querySelector<HTMLButtonElement>('[aria-label="在预发布环境添加连接"]')!;
    act(() => add.click());
    const ssh = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="添加连接"] button'))
      .find((button) => button.textContent?.includes("SSH 主机连接"))!;
    act(() => ssh.click());
    expect(onNewSessionWithProtocol).toHaveBeenCalledWith("ssh", "staging");
  });

  it("keeps the selected group when using the main new-connection action", () => {
    const tab = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "生产环境 (0)")!;
    act(() => tab.click());
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    act(() => trigger.click());
    const ssh = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="添加连接"] button'))
      .find((button) => button.textContent?.includes("SSH 主机连接"))!;
    act(() => ssh.click());
    expect(onNewSessionWithProtocol).toHaveBeenCalledWith("ssh", "prod");
  });

  it("replaces the add section with a modal containing exactly five connection choices", () => {
    const source = container.querySelector<HTMLElement>('[aria-label="添加第一台主机"]')!;
    const trigger = Array.from(source.querySelectorAll("button")).find((button) => button.textContent?.trim() === "添加")!;
    expect(trigger).toBeTruthy();
    act(() => trigger.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="添加连接"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector('[role="menu"][aria-label="新建连接类型"]')).toBeNull();
    expect(source.style.visibility).toBe("hidden");
    expect(dialog.querySelectorAll('[data-connection-option]')).toHaveLength(5);
    for (const label of [
      "SSH 主机连接",
      "Windows 远程桌面 (RDP)",
      "串口 (Serial) 通信",
      "Telnet 连接",
      "本地终端 (Local Shell)",
    ]) {
      expect(dialog.textContent).toContain(label);
    }
  });

  it("removes the redundant add button from the default connection group", () => {
    act(() => useSessionStore.setState({ sessions: [], groups: [] }));
    const section = container.querySelector('[aria-label="全部连接服务器分组"]')!;
    expect(section.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-label="在全部连接新建连接"]')).toBeNull();
  });

  it("opens the dedicated form for each of the five protocols", () => {
    for (const protocol of ["ssh", "rdp", "serial", "telnet", "local_shell"]) {
      const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
      act(() => trigger.click());
      const choice = document.querySelector<HTMLButtonElement>(`[data-connection-option="${protocol}"]`)!;
      act(() => choice.click());
      expect(onNewSessionWithProtocol).toHaveBeenLastCalledWith(protocol, undefined);
      expect(document.querySelector('[role="dialog"][aria-label="添加连接"]')).toBeNull();
    }
  });

  it("restores the source section and trigger focus after Escape without creating a connection", () => {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    act(() => { trigger.focus(); trigger.click(); });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="添加连接"]')).toBeNull();
    expect(trigger.closest<HTMLElement>('[data-add-surface]')!.style.visibility).not.toBe("hidden");
    expect(document.activeElement).toBe(trigger);
    expect(onNewSessionWithProtocol).not.toHaveBeenCalled();
  });

  it("hands focus to the dedicated form after selecting a protocol", () => {
    function ConnectionFlow() {
      const [protocol, setProtocol] = useState<Protocol | null>(null);
      return <>
        <HomeHub onNewSession={onNewSession} onEditSession={vi.fn()} onConnectSession={vi.fn()}
          onNewSessionWithProtocol={(next) => { if (next) setProtocol(next); }} />
        {protocol && <div role="dialog" aria-label={`新建 ${protocol}`}>
          <input autoFocus aria-label="连接地址" />
        </div>}
      </>;
    }
    act(() => root.render(<ConnectionFlow />));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    act(() => { trigger.focus(); trigger.click(); });
    act(() => document.querySelector<HTMLButtonElement>('[data-connection-option="ssh"]')!.click());
    expect(document.querySelector('[role="dialog"][aria-label="添加连接"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="连接地址"]'));
  });

  it("exposes group creation on the home page and blocks an empty name", () => {
    const add = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "新建分组")!;
    act(() => add.click());
    expect(document.querySelector('[role="dialog"][aria-label="新建分组"]')).not.toBeNull();
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
  });

  it("opens the first-host flow with the selected device type", () => {
    const server = container.querySelector<HTMLButtonElement>('[aria-label="添加 服务器 主机"]')!;
    act(() => server.click());
    expect(onNewSession).toHaveBeenCalledWith(undefined, "device:server");
  });

  it("keeps the same system logo in card and list views and handles legacy keys", () => {
    const sessions = [
      { id: "ubuntu", name: "Production", protocol: "ssh", auth_method: "password", icon_key: "os:ubuntu" },
      { id: "legacy", name: "Legacy", protocol: "ssh", auth_method: "password", icon_key: "old-custom-icon" },
    ] as Session[];
    act(() => useSessionStore.setState({ sessions, groups: [] }));
    expect(container.querySelector('[aria-label="添加第一台主机"]')).toBeNull();
    expect(container.querySelector('img[alt="Ubuntu"]')?.getAttribute("src")).toBe("/os/ubuntu.svg");
    expect(container.querySelector('img[alt="默认"]')?.getAttribute("src")).toBe("/os/tux.svg");
    act(() => container.querySelector<HTMLButtonElement>('[title="列表视图"]')!.click());
    expect(container.querySelector('[aria-label="机器列表视图"] img[alt="Ubuntu"]')?.getAttribute("src")).toBe("/os/ubuntu.svg");
    expect(container.querySelector('[aria-label="机器列表视图"] img[alt="默认"]')?.getAttribute("src")).toBe("/os/tux.svg");
  });

  it("keeps the group sections in list view and persists the view preference", () => {
    const sessions = [
      { id: "prod-1", name: "Production", group_id: "prod", protocol: "ssh", auth_method: "password" },
      { id: "staging-1", name: "Staging", group_id: "staging", protocol: "ssh", auth_method: "password" },
    ] as Session[];
    act(() => useSessionStore.setState({ sessions }));
    act(() => container.querySelector<HTMLButtonElement>('[title="列表视图"]')!.click());
    expect(localStorage.getItem("openshell_home_view_mode_v1")).toBe("list");
    expect(container.querySelector('[aria-label="生产环境服务器分组"] [aria-label="机器列表视图"]')?.textContent).toContain("Production");
    expect(container.querySelector('[aria-label="预发布环境服务器分组"] [aria-label="机器列表视图"]')?.textContent).toContain("Staging");
  });

  it("shows a compact empty state with a working clear action only when filters are active", () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索连接"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "missing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("未找到匹配的机器");
    const clear = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "清除筛选")!;
    expect(clear).toBeTruthy();
    act(() => clear.click());
    expect(container.textContent).not.toContain("未找到匹配的机器");
  });

  it("collapses into one flat section when every connection shares one protocol", () => {
    const sessions = [
      { id: "ssh-1", name: "One", protocol: "ssh", auth_method: "password" },
      { id: "ssh-2", name: "Two", protocol: "ssh", auth_method: "password" },
    ] as Session[];
    act(() => useSessionStore.setState({ sessions, groups: [] }));
    expect(container.querySelectorAll('section[aria-label$="服务器分组"]').length).toBe(1);
    expect(container.textContent).toContain("全部连接");
  });

  it("groups connections by protocol when multiple protocols are present", () => {
    const sessions = [
      { id: "ssh-1", name: "One", protocol: "ssh", auth_method: "password" },
      { id: "rdp-1", name: "Two", protocol: "rdp", auth_method: "password" },
      { id: "serial-1", name: "Three", protocol: "serial", auth_method: "password" },
    ] as Session[];
    act(() => useSessionStore.setState({ sessions, groups: [] }));
    expect(container.querySelector('[aria-label="SSH 连接服务器分组"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Windows 远程桌面服务器分组"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="串口通信服务器分组"]')).not.toBeNull();
    expect(container.textContent).not.toContain("全部连接");
  });
});
