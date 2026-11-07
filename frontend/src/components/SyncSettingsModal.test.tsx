import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SyncSettingsModal } from "./SyncSettingsModal";
import { useSyncStore, type SyncConfig } from "../stores/syncStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./ui/Overlay", () => ({ Modal: ({ children, onClose }: any) => <div><button onClick={onClose}>close</button>{children}</div> }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const configFixture: SyncConfig = {
  server_url: null, account_id: null, device_id: "device-fixture", auto_sync: false,
  last_sync_at: null, last_error: null, conflict_count: 0, is_logged_in: false,
};
const conflictFixture = {
  id: "conflict-fixture", record_id: "session-fixture", record_type: "session",
  created_at: 1700000000000, has_local_snapshot: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("sync settings with the real sync store", () => {
  let container: HTMLDivElement;
  let root: Root;
  let loggedIn: boolean;
  let conflicts: typeof conflictFixture[];
  const render = async () => act(async () => { root.render(<SyncSettingsModal />); });
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
  const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === cmd);
  const change = (field: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  const fillAuth = () => {
    change(input("服务端地址"), "https://sync.example.invalid");
    change(input("同步账号"), "fixture-user");
    change(input("同步密码"), "fixture-only-password");
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.resetAllMocks();
    loggedIn = false;
    conflicts = [];
    useSyncStore.setState({ modalOpen: true, config: null, configError: null, conflicts: [],
      resolvingConflictId: null, syncing: false, error: null, refreshError: null,
      refreshingViews: false, lastResult: null });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_get_config") return { ...configFixture, is_logged_in: loggedIn,
        server_url: loggedIn ? "https://sync.example.invalid" : null, conflict_count: conflicts.length };
      if (cmd === "sync_list_conflicts") return conflicts;
      if (cmd === "sync_login" || cmd === "sync_register") { loggedIn = true; return undefined; }
      if (cmd === "sync_resolve_conflict") { conflicts = []; return undefined; }
      if (cmd === "sync_logout") { loggedIn = false; return undefined; }
      if (cmd === "sync_now") return { pushed_count: 1, pulled_count: 0, conflict_count: 0, head_seq: 10 };
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (["session_list", "group_list", "snippet_list"].includes(cmd)) return [];
      return undefined;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("starts with empty fields and clears password on close and reopen", async () => {
    await render();
    expect([...container.querySelectorAll("input")].every((field) => field.value === "")).toBe(true);
    expect(input("同步密码").getAttribute("autocomplete")).toBe("new-password");
    change(input("同步密码"), "fixture-only-password");
    expect(input("同步密码").value).toBe("fixture-only-password");
    act(() => useSyncStore.getState().setModalOpen(false));
    await act(async () => useSyncStore.getState().setModalOpen(true));
    expect(input("同步密码").value).toBe("");
  });

  it("clears entered password and renders real authentication failure", async () => {
    await render();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Network timeout"));
    fillAuth();
    await submit();
    expect(calls("sync_login")).toHaveLength(1);
    expect(input("同步密码").value).toBe("");
    expect(container.textContent).toContain(useSyncStore.getState().error);
  });

  it.each(["保留本地副本", "使用远端数据"])("renders and resolves conflict with %s through IPC", async (choice) => {
    loggedIn = true;
    conflicts = [conflictFixture];
    await render();
    expect(container.textContent).toContain("待解决版本冲突");
    expect(container.textContent).toContain("session : session-fixture");
    expect(button("保留本地副本")).toBeTruthy();
    expect(button("使用远端数据")).toBeTruthy();
    await act(async () => button(choice).click());
    expect(calls("sync_resolve_conflict")).toEqual([["sync_resolve_conflict", {
      conflictId: conflictFixture.id, choice: choice === "保留本地副本" ? "local" : "remote",
    }]]);
    expect(useSyncStore.getState().conflicts).toEqual([]);
    expect(container.textContent).toContain(choice === "保留本地副本" ? "已选择保留本地副本" : "已选择使用远端数据");
  });

  it("renders current conflict mutation failure and preserves the choice buttons for another attempt", async () => {
    loggedIn = true;
    conflicts = [conflictFixture];
    await render();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Network timeout"));
    await act(async () => button("保留本地副本").click());
    expect(container.textContent).toContain("解决冲突失败");
    expect(useSyncStore.getState().conflicts).toEqual([conflictFixture]);
    expect(useSyncStore.getState().resolvingConflictId).toBeNull();
    expect(button("使用远端数据").disabled).toBe(false);
    expect(calls("sync_resolve_conflict")).toHaveLength(1);
  });

  it.each(["sync", "login", "resolve"])("%s mutation success with view failure offers read-only retry", async (entry) => {
    loggedIn = entry !== "login";
    conflicts = entry === "resolve" ? [conflictFixture] : [];
    await render();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    let failing = true;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "snippet_list" && failing) throw new Error("Database locked");
      return implementation(cmd, args, options);
    });
    if (entry === "login") { fillAuth(); await submit(); }
    else await act(async () => button(entry === "resolve" ? "保留本地副本" : "立即同步").click());
    expect(container.textContent).toContain("操作已成功、刷新失败");
    expect(container.textContent).not.toContain("同步失败");
    expect(container.textContent).not.toContain("登录失败");
    expect(useSyncStore.getState().error).toBeNull();
    failing = false;
    await act(async () => button("重试刷新").click());
    expect(useSyncStore.getState().refreshError).toBeNull();
    expect(calls(entry === "resolve" ? "sync_resolve_conflict" : entry === "sync" ? "sync_now" : "sync_login")).toHaveLength(1);
    expect(container.textContent).toContain("刷新成功");
  });

  it("shows initial configError independently of conflicts and retries only configuration reads", async () => {
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    let failing = true;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "sync_get_config" && failing) throw new Error("Network timeout");
      return implementation(cmd, args, options);
    });
    await render();
    const error = useSyncStore.getState().configError;
    expect(error).toBeTruthy();
    expect(container.textContent).toContain(error);
    expect(button("重试配置")).toBeTruthy();
    failing = false;
    await act(async () => button("重试配置").click());
    expect(useSyncStore.getState().configError).toBeNull();
    expect(calls("sync_get_config")).toHaveLength(2);
    expect(calls("sync_login")).toHaveLength(0);
    expect(calls("sync_now")).toHaveLength(0);
  });

  it.each(["login", "update"].flatMap((entry) => [
    { entry, late: "resolve" }, { entry, late: "reject" },
  ]))("config retry late $late releases its own busy after the real $entry button changes feedback", async ({ entry, late }) => {
    loggedIn = entry === "update";
    if (loggedIn) useSyncStore.setState({ config: { ...configFixture, is_logged_in: true } });
    const pending = deferred<SyncConfig>();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    let configCalls = 0;
    let recovered = false;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "sync_get_config") {
        configCalls++;
        if (configCalls === 2) return pending.promise;
        if (!recovered) throw new Error("Network timeout");
      }
      if (cmd === "sync_login") throw new Error("Database locked");
      if (cmd === "sync_check_updates") return null;
      return implementation(cmd, args, options);
    });
    await render();
    expect(useSyncStore.getState().configError).toBeTruthy();
    await act(async () => button("重试配置").click());
    expect(button("重试配置").disabled).toBe(true);
    try {
      if (entry === "login") {
        fillAuth();
        await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
        expect(calls("sync_login")).toHaveLength(1);
        expect(input("同步密码").value).toBe("");
        expect(button("重试配置").disabled).toBe(false);
      } else {
        await act(async () => button("检查软件更新").click());
        expect(calls("sync_check_updates")).toHaveLength(1);
        expect(container.textContent).toContain("当前已是最新版本");
        expect(button("重试配置").disabled).toBe(true);
      }
      await act(async () => {
        if (late === "resolve") pending.resolve({ ...configFixture, is_logged_in: loggedIn });
        else pending.reject(new Error("Network timeout"));
      });
      // A fresh real failure also exposes a spinner left behind by an old success.
      await act(async () => useSyncStore.getState().loadConfig());
      expect(container.textContent).toContain(useSyncStore.getState().configError);
      expect(button("重试配置").disabled).toBe(false);
      recovered = true;
      await act(async () => button("重试配置").click());
      expect(useSyncStore.getState().configError).toBeNull();
      expect(configCalls).toBe(4);
      expect(calls("sync_now")).toHaveLength(0);
      expect(calls("sync_login")).toHaveLength(entry === "login" ? 1 : 0);
    } finally { await act(async () => pending.resolve(configFixture)); }
  });

  it("disables conflict choices during sync and keeps resolution busy through all view reads", async () => {
    loggedIn = true;
    conflicts = [conflictFixture];
    await render();
    const snippets = deferred<unknown[]>();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => cmd === "snippet_list"
      ? snippets.promise : implementation(cmd, args, options));
    let sync!: Promise<unknown>;
    await act(async () => { sync = useSyncStore.getState().syncNow(); });
    try {
      expect(button("保留本地副本").disabled).toBe(true);
      expect(button("使用远端数据").disabled).toBe(true);
      act(() => button("保留本地副本").click());
      expect(calls("sync_resolve_conflict")).toHaveLength(0);
    } finally { await act(async () => { snippets.resolve([]); await sync; }); }
    expect(button("保留本地副本").disabled).toBe(false);
    const pending = deferred<unknown[]>();
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "sync_list_conflicts") return [conflictFixture];
      if (cmd === "snippet_list") return pending.promise;
      return implementation(cmd, args, options);
    });
    await act(async () => button("保留本地副本").click());
    try {
      expect(button("立即同步").disabled).toBe(true);
      expect(button("使用远端数据").disabled).toBe(true);
    } finally { await act(async () => pending.resolve([])); }
    expect(useSyncStore.getState().resolvingConflictId).toBeNull();
  });

  it("consumes initial conflict rejection and clears its read error with read-only retry", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    let failing = true;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "sync_list_conflicts" && failing) throw new Error("Database locked");
      return implementation(cmd, args, options);
    });
    try {
      await render();
      expect(useSyncStore.getState().error).toBeTruthy();
      expect(container.textContent).toContain(useSyncStore.getState().error);
      failing = false;
      await act(async () => button("重试").click());
      expect(useSyncStore.getState().error).toBeNull();
      expect(calls("sync_resolve_conflict")).toHaveLength(0);
      expect(calls("sync_now")).toHaveLength(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { window.removeEventListener("unhandledrejection", unhandled); }
  });

  it.each(["退出当前账号", "清除本地同步数据"])("%s prevents old sync completion from restoring success feedback", async (exit) => {
    loggedIn = true;
    await render();
    const write = deferred<unknown>();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => cmd === "sync_now"
      ? write.promise : implementation(cmd, args, options));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => button("立即同步").click());
    await act(async () => button(exit).click());
    await act(async () => write.resolve({ pushed_count: 1, pulled_count: 0, conflict_count: 0, head_seq: 10 }));
    expect(container.querySelector("form")).toBeTruthy();
    expect(container.textContent).not.toContain("同步成功");
    expect(useSyncStore.getState().lastResult).toBeNull();
    expect(calls("sync_now")).toHaveLength(1);
    expect(calls("sync_logout")).toHaveLength(1);
    if (exit === "清除本地同步数据") expect(container.textContent).toContain("本地同步数据已清除");
  });

  it("does not let old clear completion write feedback after real close and reopen", async () => {
    loggedIn = true;
    await render();
    const clear = deferred<void>();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "sync_logout") { await clear.promise; loggedIn = false; return undefined; }
      return implementation(cmd, args, options);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => button("清除本地同步数据").click());
    await act(async () => button("close").click());
    expect(container.textContent).toBe("");
    await act(async () => useSyncStore.getState().setModalOpen(true));
    expect(container.textContent).toContain("close");
    await act(async () => clear.resolve(undefined));
    expect(container.textContent).not.toContain("本地同步数据已清除");
    expect(container.querySelector("form")).toBeTruthy();
    expect(calls("sync_logout")).toHaveLength(1);
  });

  it.each(["logout during refresh", "update during refresh then logout"])("clears the login secret for %s and preserves new input against old finally", async (path) => {
    const snippets = deferred<unknown[]>();
    const implementation = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args, options) => {
      if (cmd === "snippet_list") return snippets.promise;
      if (cmd === "sync_check_updates") return null;
      return implementation(cmd, args, options);
    });
    await render();
    fillAuth();
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    try {
      expect(useSyncStore.getState().config?.is_logged_in).toBe(true);
      expect(useSyncStore.getState().syncing).toBe(true);
      if (path.startsWith("update")) {
        await act(async () => button("检查软件更新").click());
        expect(calls("sync_check_updates")).toHaveLength(1);
        await act(async () => snippets.resolve([]));
      }
      await act(async () => button("退出当前账号").click());
      expect(input("同步密码").value).toBe("");
      change(input("同步密码"), "new-fixture-only-password");
      await act(async () => snippets.resolve([]));
      expect(input("同步密码").value).toBe("new-fixture-only-password");
      expect(calls("sync_login")).toHaveLength(1);
      expect(calls("sync_logout")).toHaveLength(1);
    } finally { await act(async () => snippets.resolve([])); }
  });
});
