import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSyncStore } from "./syncStore";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

describe("useSyncStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({
      config: null,
      syncing: false,
      modalOpen: false,
      lastResult: null,
      updateInfo: null,
      error: null,
    });
  });

  it("should initialize with default states and toggle modalOpen", () => {
    const store = useSyncStore.getState();
    expect(store.modalOpen).toBe(false);
    expect(store.config).toBeNull();

    store.setModalOpen(true);
    expect(useSyncStore.getState().modalOpen).toBe(true);

    store.setModalOpen(false);
    expect(useSyncStore.getState().modalOpen).toBe(false);
  });

  it("should load sync configuration via invoke", async () => {
    const mockConfig = {
      server_url: "https://sync.example.com",
      account_id: "acc_123",
      device_id: "dev_abc",
      auto_sync: true,
      last_sync_at: 1700000000000,
      last_error: null,
      conflict_count: 0,
      is_logged_in: true,
    };

    vi.mocked(invoke).mockResolvedValueOnce(mockConfig);

    await useSyncStore.getState().loadConfig();

    expect(invoke).toHaveBeenCalledWith("sync_get_config");
    expect(useSyncStore.getState().config).toEqual(mockConfig);
  });

  it("should perform syncNow and store lastResult", async () => {
    const mockResult = {
      pushed_count: 3,
      pulled_count: 1,
      conflict_count: 0,
      head_seq: 42,
    };

    vi.mocked(invoke)
      .mockResolvedValueOnce(mockResult) // for sync_now
      .mockResolvedValueOnce({ is_logged_in: true }); // for subsequent loadConfig

    const res = await useSyncStore.getState().syncNow();

    expect(invoke).toHaveBeenCalledWith("sync_now");
    expect(res).toEqual(mockResult);
    expect(useSyncStore.getState().lastResult).toEqual(mockResult);
    expect(useSyncStore.getState().syncing).toBe(false);
  });

  it("should capture sync errors gracefully", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Network timeout"));

    await expect(useSyncStore.getState().syncNow()).rejects.toThrow("Network timeout");
    // 展示给用户的 error 必须是中文友好文案，不能直接暴露 "Network timeout" 这类技术原文
    expect(useSyncStore.getState().error).toMatch(/连接超时/);
    expect(useSyncStore.getState().error).not.toContain("Network timeout");
    expect(useSyncStore.getState().syncing).toBe(false);
  });

  it("should load conflicts via sync_list_conflicts", async () => {
    const mockConflicts = [
      {
        id: "conf_1",
        record_id: "sess_100",
        record_type: "session",
        created_at: 1700000000000,
        has_local_snapshot: true,
      },
    ];

    vi.mocked(invoke).mockResolvedValueOnce(mockConflicts);

    const conflicts = await useSyncStore.getState().loadConflicts();

    expect(invoke).toHaveBeenCalledWith("sync_list_conflicts");
    expect(conflicts).toEqual(mockConflicts);
    expect(useSyncStore.getState().conflicts).toEqual(mockConflicts);
  });

  it("should retain existing conflicts and report error when loadConflicts fails", async () => {
    const existing = [
      {
        id: "conf_old",
        record_id: "sess_old",
        record_type: "session",
        created_at: 1700000000000,
        has_local_snapshot: true,
      },
    ];
    useSyncStore.setState({ conflicts: existing });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Network disconnect"));

    await expect(useSyncStore.getState().loadConflicts()).rejects.toThrow("Network disconnect");
    // 不伪造无冲突，保留已有列表并呈现失败
    expect(useSyncStore.getState().conflicts).toEqual(existing);
    expect(useSyncStore.getState().error).toBeTruthy();
  });

  it("should resolve conflict with local choice and refresh conflicts and config", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined) // sync_resolve_conflict
      .mockResolvedValueOnce([]) // loadConflicts after resolve
      .mockResolvedValueOnce({ is_logged_in: true, conflict_count: 0 }); // loadConfig after resolve

    await useSyncStore.getState().resolveConflict("conf_1", "local");

    expect(invoke).toHaveBeenCalledWith("sync_resolve_conflict", {
      conflictId: "conf_1",
      choice: "local",
    });
    expect(useSyncStore.getState().conflicts).toEqual([]);
    expect(useSyncStore.getState().resolvingConflictId).toBeNull();
  });

  it("should resolve conflict with remote choice and prevent duplicate flight invocation", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined) // sync_resolve_conflict
      .mockResolvedValueOnce([]) // loadConflicts
      .mockResolvedValueOnce({ is_logged_in: true, conflict_count: 0 }); // loadConfig

    const p1 = useSyncStore.getState().resolveConflict("conf_2", "remote");
    // Duplicate call while p1 is in flight
    const p2 = useSyncStore.getState().resolveConflict("conf_2", "remote");

    await Promise.all([p1, p2]);

    // Should only be called once because resolvingConflictId guarded against duplicate submission
    const resolveCalls = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === "sync_resolve_conflict");
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0][1]).toEqual({ conflictId: "conf_2", choice: "remote" });
  });

  it("should handle resolve failure by setting error and keeping conflicts intact", async () => {
    useSyncStore.setState({
      conflicts: [
        {
          id: "conf_fail",
          record_id: "sess_fail",
          record_type: "session",
          created_at: 1700000000000,
          has_local_snapshot: true,
        },
      ],
    });

    vi.mocked(invoke).mockRejectedValueOnce(new Error("Database locked"));

    await expect(
      useSyncStore.getState().resolveConflict("conf_fail", "local")
    ).rejects.toThrow("Database locked");

    expect(useSyncStore.getState().error).toBeTruthy();
    // Conflicts list must not be wiped on failure
    expect(useSyncStore.getState().conflicts.length).toBe(1);
    expect(useSyncStore.getState().resolvingConflictId).toBeNull();
  });

  it("should record refreshError when conflict resolution succeeds but view refresh fails, and allow retryRefreshViews without repeating resolution", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined) // sync_resolve_conflict
      .mockRejectedValueOnce(new Error("Refresh network failure")); // loadConflicts after resolve

    await useSyncStore.getState().resolveConflict("conf_s07", "local");

    expect(invoke).toHaveBeenCalledWith("sync_resolve_conflict", {
      conflictId: "conf_s07",
      choice: "local",
    });
    expect(useSyncStore.getState().resolvingConflictId).toBeNull();
    expect(useSyncStore.getState().refreshError).toBeTruthy();

    // Now retryRefreshViews succeeds
    vi.mocked(invoke)
      .mockResolvedValueOnce([]) // loadConflicts
      .mockResolvedValueOnce({ is_logged_in: true, conflict_count: 0 }); // loadConfig

    await useSyncStore.getState().retryRefreshViews();

    expect(useSyncStore.getState().refreshError).toBeNull();
    const resolveCalls = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === "sync_resolve_conflict");
    expect(resolveCalls.length).toBe(1);
  });

  it("syncNow preserves lastResult and records refreshError if view refresh rejects, allowing retry without re-syncing", async () => {
    const mockResult = {
      pushed_count: 5,
      pulled_count: 2,
      conflict_count: 0,
      head_seq: 100,
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") return mockResult;
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") throw new Error("Snippet DB locked during sync refresh");
      return undefined;
    });

    const res = await useSyncStore.getState().syncNow();

    expect(res).toEqual(mockResult);
    expect(useSyncStore.getState().lastResult).toEqual(mockResult);
    expect(useSyncStore.getState().syncing).toBe(false);
    // error must be null because mutation itself succeeded!
    expect(useSyncStore.getState().error).toBeNull();
    // refreshError must capture the view refresh error
    expect(useSyncStore.getState().refreshError).toBeTruthy();

    // Now retryRefreshViews succeeds
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") throw new Error("Should not be called!");
      if (cmd === "sync_list_conflicts") return [];
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") return [];
      return undefined;
    });

    await useSyncStore.getState().retryRefreshViews();

    expect(useSyncStore.getState().refreshError).toBeNull();
    const syncCalls = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "sync_now");
    expect(syncCalls.length).toBe(1); // Still only 1 call from before!
  });

  it("login preserves login success and records refreshError if view refresh rejects, allowing retry without re-login", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_login") return undefined;
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") throw new Error("Snippet list failed");
      return undefined;
    });

    await useSyncStore.getState().login("https://sync.example.com", "user@test.com", "pass");

    expect(useSyncStore.getState().syncing).toBe(false);
    expect(useSyncStore.getState().error).toBeNull();
    expect(useSyncStore.getState().refreshError).toBeTruthy();

    // retryRefreshViews succeeds
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_login") throw new Error("Should not re-login!");
      if (cmd === "sync_list_conflicts") return [];
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") return [];
      return undefined;
    });

    await useSyncStore.getState().retryRefreshViews();

    expect(useSyncStore.getState().refreshError).toBeNull();
    const loginCalls = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "sync_login");
    expect(loginCalls.length).toBe(1);
  });

  it("register preserves registration success and records refreshError if view refresh rejects, allowing retry without re-registering", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_register") return undefined;
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") throw new Error("Snippet list failed");
      return undefined;
    });

    await useSyncStore.getState().register("https://sync.example.com", "user@test.com", "pass");

    expect(useSyncStore.getState().syncing).toBe(false);
    expect(useSyncStore.getState().error).toBeNull();
    expect(useSyncStore.getState().refreshError).toBeTruthy();

    const regCalls = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "sync_register");
    expect(regCalls.length).toBe(1);
  });

  it("retryRefreshViews fails and does not clear refreshError if loadConfig or checkStatus fails", async () => {
    useSyncStore.setState({ refreshError: "Existing refresh error" });

    // Test failure in loadConfig
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_list_conflicts") return [];
      if (cmd === "sync_get_config") throw new Error("Config sync error");
      return undefined;
    });

    await expect(useSyncStore.getState().retryRefreshViews()).rejects.toThrow();
    expect(useSyncStore.getState().refreshError).toBeTruthy();

    // Test failure in vault checkStatus
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_list_conflicts") return [];
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") throw new Error("Vault check error");
      if (cmd === "snippet_list") return [];
      return undefined;
    });

    await expect(useSyncStore.getState().retryRefreshViews()).rejects.toThrow();
    expect(useSyncStore.getState().refreshError).toBeTruthy();
  });

  it("syncNow keeps syncing=true during view refresh and prevents re-entrant sync", async () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const refreshDef = deferred<any[]>();

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") return { pushed_count: 1, pulled_count: 1, conflict_count: 0, head_seq: 1 };
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 0 };
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") return refreshDef.promise; // delayed view refresh
      return undefined;
    });

    // Start syncNow
    const syncPromise = useSyncStore.getState().syncNow();

    // Give time for sync_now invoke to resolve
    await Promise.resolve();
    await Promise.resolve();

    // WHILE view refresh is pending, syncing MUST STILL BE TRUE!
    expect(useSyncStore.getState().syncing).toBe(true);

    // Re-entrant syncNow while refresh is pending should be guarded
    const reentrantPromise = useSyncStore.getState().syncNow();
    // Finish refresh
    refreshDef.resolve([]);
    await syncPromise;
    await reentrantPromise;

    // After finish, syncing becomes false
    expect(useSyncStore.getState().syncing).toBe(false);
    // sync_now should only be called once, not twice
    const syncCalls = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "sync_now");
    expect(syncCalls.length).toBe(1);
  });

  it("loadConfig awaits loadConflicts when conflict_count > 0, propagating failure to refreshError", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") return { pushed_count: 1, pulled_count: 1, conflict_count: 1, head_seq: 1 };
      if (cmd === "sync_get_config") return { is_logged_in: true, conflict_count: 1 };
      if (cmd === "sync_list_conflicts") throw new Error("Conflict DB read error");
      if (cmd === "session_list") return [];
      if (cmd === "group_list") return [];
      if (cmd === "vault_status") return { state: "unlocked", has_keychain: true, auto_lock_minutes: 15 };
      if (cmd === "snippet_list") return [];
      return undefined;
    });

    const res = await useSyncStore.getState().syncNow();
    expect(res.pushed_count).toBe(1);
    // Because conflict reading failed, it must NOT be swallowed silently!
    // refreshError must capture the failure
    expect(useSyncStore.getState().refreshError).toBeTruthy();
    expect(useSyncStore.getState().syncing).toBe(false);
  });
});
