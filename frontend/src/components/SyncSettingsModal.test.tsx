import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncSettingsModal } from "./SyncSettingsModal";

const mock = vi.hoisted(() => ({
  modalOpen: true, config: null as any, conflicts: [] as any[], resolvingConflictId: null as string | null, syncing: false, error: null,
  refreshError: null as string | null, refreshingViews: false,
  setModalOpen: vi.fn(), loadConfig: vi.fn(), loadConflicts: vi.fn(), resolveConflict: vi.fn(), retryRefreshViews: vi.fn(), saveConfig: vi.fn(),
  register: vi.fn(), login: vi.fn(), logout: vi.fn(), clearLocalSyncData: vi.fn(),
  syncNow: vi.fn(), checkUpdates: vi.fn(),
}));
vi.mock("../stores/syncStore", () => ({
  useSyncStore: Object.assign(() => mock, { getState: () => mock }),
}));
vi.mock("./ui/Overlay", () => ({ Modal: ({ children, onClose }: any) => <div><button onClick={onClose}>close</button>{children}</div> }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

describe("sync login privacy", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<SyncSettingsModal />));
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const change = (field: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    mock.modalOpen = true;
    mock.login.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("starts with empty server, username and password fields", () => {
    render();
    expect([...container.querySelectorAll("input")].every((field) => field.value === "")).toBe(true);
    expect(input("同步密码").getAttribute("autocomplete")).toBe("new-password");
  });

  it("forgets an entered password when the dialog is closed and reopened", () => {
    render();
    change(input("同步密码"), "test-only-password");
    expect(input("同步密码").value).toBe("test-only-password");
    mock.modalOpen = false; render();
    mock.modalOpen = true; render();
    expect(input("同步密码").value).toBe("");
  });

  it("clears the password even when authentication fails", async () => {
    mock.login.mockRejectedValueOnce(new Error("test failure"));
    render();
    change(input("服务端地址"), "https://sync.example.invalid");
    change(input("同步账号"), "test-user");
    change(input("同步密码"), "test-only-password");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(input("同步密码").value).toBe("");
  });

  it("renders conflicts list and allows resolving conflict with local or remote choice", async () => {
    mock.config = {
      server_url: "https://sync.example.com",
      account_id: "acc_1",
      device_id: "dev_1",
      auto_sync: true,
      last_sync_at: 1700000000000,
      last_error: null,
      conflict_count: 1,
      is_logged_in: true,
    };
    mock.conflicts = [
      {
        id: "conf_test_1",
        record_id: "session_abc",
        record_type: "session",
        created_at: 1700000000000,
        has_local_snapshot: true,
      },
    ];
    mock.resolveConflict.mockResolvedValue(undefined);

    render();

    expect(container.textContent).toContain("待解决版本冲突");
    expect(container.textContent).toContain("session : session_abc");

    const localBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保留本地副本")
    );
    const remoteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("使用远端数据")
    );

    expect(localBtn).toBeTruthy();
    expect(remoteBtn).toBeTruthy();

    await act(async () => {
      localBtn!.click();
    });

    expect(mock.resolveConflict).toHaveBeenCalledWith("conf_test_1", "local");
    expect(container.textContent).toContain("已选择保留本地副本");

    await act(async () => {
      remoteBtn!.click();
    });

    expect(mock.resolveConflict).toHaveBeenCalledWith("conf_test_1", "remote");
    expect(container.textContent).toContain("已选择使用远端数据");
  });

  it("displays '操作已成功、刷新失败' and offers '重试刷新' button when resolve succeeds but refresh fails", async () => {
    mock.config = {
      server_url: "https://sync.example.com",
      account_id: "acc_1",
      device_id: "dev_1",
      auto_sync: true,
      last_sync_at: 1700000000000,
      last_error: null,
      conflict_count: 1,
      is_logged_in: true,
    };
    mock.conflicts = [
      {
        id: "conf_test_refresh_fail",
        record_id: "session_s07",
        record_type: "session",
        created_at: 1700000000000,
        has_local_snapshot: true,
      },
    ];
    mock.resolveConflict.mockImplementation(async () => {
      mock.refreshError = "Failed to load snippets";
    });
    mock.retryRefreshViews.mockResolvedValue(undefined);

    render();

    const localBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保留本地副本")
    );
    expect(localBtn).toBeTruthy();

    await act(async () => {
      localBtn!.click();
    });

    // 1. Resolve conflict was called once
    expect(mock.resolveConflict).toHaveBeenCalledWith("conf_test_refresh_fail", "local");
    // 2. Feedback and notice indicate success of commit, but refresh failure
    expect(container.textContent).toContain("操作已成功、刷新失败");
    expect(container.textContent).toContain("重试刷新");

    // 3. Clicking "重试刷新" retries views without calling resolveConflict again
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("重试刷新")
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn!.click();
    });

    expect(mock.retryRefreshViews).toHaveBeenCalledTimes(1);
    expect(mock.resolveConflict).toHaveBeenCalledTimes(1); // Not called again!
  });
});
