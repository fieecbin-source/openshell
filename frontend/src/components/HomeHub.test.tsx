import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeHub } from "./HomeHub";
import { useSessionStore } from "../stores/sessionStore";
import type { Group, Session } from "../types/ipc";

vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const group = (id: string, name: string): Group => ({
  id, name, kind: "session", parent_id: null, color: null, icon_key: null, notes: null,
  expanded: true, sort_order: 0, created_at: 0, updated_at: 0, deleted_at: null,
});

describe("home group entry points", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onNewSession = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSessionStore.setState({ sessions: [], groups: [group("prod", "生产环境"), group("staging", "预发布环境")] });
    act(() => root.render(<HomeHub onNewSession={onNewSession} onEditSession={vi.fn()} onConnectSession={vi.fn()} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows empty groups so a newly created group can accept its first server", () => {
    expect(container.querySelector('[aria-label="生产环境服务器分组"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="预发布环境服务器分组"]')).not.toBeNull();
    expect(container.textContent).toContain("暂无服务器");
  });

  it("passes the exact group id when creating a server inside an empty group", () => {
    const add = container.querySelector<HTMLButtonElement>('[aria-label="在预发布环境新建服务器"]')!;
    act(() => add.click());
    expect(onNewSession).toHaveBeenCalledWith("staging");
  });

  it("keeps the selected group when using the main new-server action", () => {
    const tab = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "生产环境 (0)")!;
    act(() => tab.click());
    const add = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "新建服务器")!;
    act(() => add.click());
    expect(onNewSession).toHaveBeenCalledWith("prod");
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
    const search = container.querySelector<HTMLInputElement>('input[placeholder="搜索别名、IP、用户或备注..."]')!;
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
});
