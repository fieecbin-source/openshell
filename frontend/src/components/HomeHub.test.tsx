import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeHub } from "./HomeHub";
import { useSessionStore } from "../stores/sessionStore";
import type { Group } from "../types/ipc";

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
});
