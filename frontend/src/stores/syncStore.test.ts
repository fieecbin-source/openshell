import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSyncStore, type SyncConfig, type SyncConflict } from "./syncStore";
import { useSessionStore } from "./sessionStore";
import { useVaultStore } from "./vaultStore";
import { useSnippetStore } from "./snippetStore";

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
      configError: null,
      refreshError: null,
      refreshingViews: false,
      conflicts: [],
      resolvingConflictId: null,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const configFixture: SyncConfig = {
  server_url: "https://sync.example.invalid", account_id: "account-fixture", device_id: "device-fixture",
  auto_sync: false, last_sync_at: null, last_error: null, conflict_count: 0, is_logged_in: true,
};
const conflictFixture: SyncConflict = {
  id: "conflict-fixture", record_id: "session-fixture", record_type: "session",
  created_at: 1700000000000, has_local_snapshot: true,
};
const resultFixture = { pushed_count: 2, pulled_count: 1, conflict_count: 0, head_seq: 17 };
const vaultFixture = { state: "unlocked" as const, has_keychain: true, auto_lock_minutes: 15 };
const readResult = (cmd: string): unknown => {
  if (cmd === "sync_get_config") return configFixture;
  if (cmd === "sync_now") return resultFixture;
  if (cmd === "vault_status") return vaultFixture;
  if (["sync_list_conflicts", "session_list", "group_list", "snippet_list"].includes(cmd)) return [];
  return undefined;
};
const flushReads = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const commandCalls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === cmd);
const mutate = (entry: string) => {
  const store = useSyncStore.getState();
  if (entry === "sync") return store.syncNow();
  if (entry === "login") return store.login("https://sync.example.invalid", "user", "fixture-only");
  if (entry === "register") return store.register("https://sync.example.invalid", "user", "fixture-only");
  if (entry === "resolve") return store.resolveConflict(conflictFixture.id, "local");
  return store.retryRefreshViews();
};

describe("sync cross-flow ownership at the Tauri boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useSyncStore.setState({ config: null, configError: null, conflicts: [], resolvingConflictId: null,
      syncing: false, modalOpen: false, lastResult: null, updateInfo: null, error: null,
      refreshError: null, refreshingViews: false });
    useSessionStore.setState({ sessions: [], groups: [], isLoading: false, error: null });
    useVaultStore.setState({ status: null, isLoading: false, error: null });
    useSnippetStore.setState({ snippets: [], loading: false, error: null });
    vi.mocked(invoke).mockImplementation(async (cmd) => readResult(cmd));
  });

  it.each(["resolve", "login", "register"])("blocks %s while sync refresh owns busy and releases busy afterwards", async (entry) => {
    const snippets = deferred<unknown[]>();
    vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "snippet_list" ? snippets.promise : readResult(cmd));
    const sync = mutate("sync");
    await flushReads();
    try {
      expect(useSyncStore.getState().syncing).toBe(true);
      const duplicate = mutate(entry);
      await flushReads();
      snippets.resolve([]);
      await Promise.all([sync, duplicate]);
      expect(commandCalls(entry === "resolve" ? "sync_resolve_conflict" : `sync_${entry}`)).toHaveLength(0);
      expect(useSyncStore.getState().syncing).toBe(false);
    } finally { snippets.resolve([]); await sync; }
  });

  it.each(["sync", "login", "register", "resolve", "retry"])("%s waits for all started view siblings after an early rejection", async (entry) => {
    const sessions = deferred<unknown[]>();
    const vault = deferred<typeof vaultFixture>();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "snippet_list") throw new Error("Network timeout");
      if (cmd === "session_list") return sessions.promise;
      if (cmd === "vault_status") return vault.promise;
      return readResult(cmd);
    });
    const operation = mutate(entry);
    const outcome = operation.then(() => "success", () => "read failure");
    await flushReads();
    try {
      const busy = () => entry === "retry" ? useSyncStore.getState().refreshingViews
        : entry === "resolve" ? useSyncStore.getState().resolvingConflictId !== null : useSyncStore.getState().syncing;
      expect(busy()).toBe(true);
      sessions.resolve([]);
      await flushReads();
      expect(busy()).toBe(true);
      vault.resolve(vaultFixture);
      expect(await outcome).toBe(entry === "retry" ? "read failure" : "success");
      expect(busy()).toBe(false);
      expect(useSyncStore.getState().refreshError).toBeTruthy();
      expect(useSyncStore.getState().error).toBeNull();
      expect(useSessionStore.getState().sessions).toEqual([]);
      expect(useVaultStore.getState().status).toEqual(vaultFixture);
      if (entry === "sync") expect(useSyncStore.getState().lastResult).toEqual(resultFixture);
    } finally { sessions.resolve([]); vault.resolve(vaultFixture); await outcome; }
  });

  it.each(["sync", "login", "register", "resolve"].flatMap((entry) => [
    { entry, late: "resolve" }, { entry, late: "reject" },
  ]))("retry A late $late cannot replace $entry B refreshError or retain busy", async ({ entry, late }) => {
    const snippets = deferred<unknown[]>();
    let newer = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "snippet_list") return snippets.promise;
      if (newer && cmd === "sync_get_config") throw new Error("Database locked");
      return readResult(cmd);
    });
    const retry = mutate("retry").catch(() => undefined);
    await flushReads();
    newer = true;
    await mutate(entry);
    const current = useSyncStore.getState().refreshError;
    try {
      expect(current).toBeTruthy();
      if (late === "resolve") snippets.resolve([]); else snippets.reject(new Error("Network timeout"));
      await retry;
      expect(useSyncStore.getState().refreshError).toBe(current);
      expect(useSyncStore.getState().refreshingViews).toBe(false);
      expect(useSyncStore.getState().syncing).toBe(false);
    } finally { snippets.resolve([]); await retry; }
  });

  it.each(["sync", "login", "register", "resolve"].flatMap((entry) => [
    { entry, late: "resolve" }, { entry, late: "reject" },
  ]))("$entry A late $late cannot replace retry B error and releases its own busy", async ({ entry, late }) => {
    const snippets = deferred<unknown[]>();
    let newer = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "snippet_list") return snippets.promise;
      if (newer && cmd === "sync_list_conflicts") throw new Error("Database locked");
      return readResult(cmd);
    });
    const operation = mutate(entry);
    await flushReads();
    newer = true;
    await expect(mutate("retry")).rejects.toThrow("Database locked");
    const current = useSyncStore.getState().refreshError;
    try {
      if (late === "resolve") snippets.resolve([]); else snippets.reject(new Error("Network timeout"));
      await operation;
      expect(useSyncStore.getState().refreshError).toBe(current);
      expect(useSyncStore.getState().syncing).toBe(false);
      expect(useSyncStore.getState().resolvingConflictId).toBeNull();
    } finally { snippets.resolve([]); await operation; }
  });

  it("stale config cannot derive a conflict read that supersedes a newer conflict list", async () => {
    const oldConfig = deferred<SyncConfig>();
    const currentConflicts = deferred<SyncConflict[]>();
    let configCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_get_config") return ++configCalls === 1 ? oldConfig.promise : configFixture;
      if (cmd === "sync_list_conflicts") return commandCalls(cmd).length === 1 ? currentConflicts.promise : [];
      return readResult(cmd);
    });
    const old = useSyncStore.getState().loadConfig();
    await useSyncStore.getState().loadConfig();
    const current = useSyncStore.getState().loadConflicts();
    oldConfig.resolve({ ...configFixture, conflict_count: 1 });
    await old;
    currentConflicts.resolve([conflictFixture]);
    await current;
    expect(commandCalls("sync_list_conflicts")).toHaveLength(1);
    expect(useSyncStore.getState().config).toEqual(configFixture);
    expect(useSyncStore.getState().conflicts).toEqual([conflictFixture]);
  });

  it("derived conflict failure remains independent of successful config and configError", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_get_config") return { ...configFixture, conflict_count: 1 };
      if (cmd === "sync_list_conflicts") throw new Error("Database locked");
      return readResult(cmd);
    });
    await expect(useSyncStore.getState().loadConfig({ throwOnError: true })).rejects.toThrow();
    expect(useSyncStore.getState().config?.is_logged_in).toBe(true);
    expect(useSyncStore.getState().configError).toBeNull();
    expect(useSyncStore.getState().error).toBeTruthy();
  });

  it.each(["resolve", "reject"])("derived conflict read late %s cannot outlive a newer config", async (late) => {
    const oldConflicts = deferred<SyncConflict[]>();
    let newer = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_get_config") return { ...configFixture, conflict_count: newer ? 0 : 1 };
      if (cmd === "sync_list_conflicts") return oldConflicts.promise;
      return readResult(cmd);
    });
    const old = useSyncStore.getState().loadConfig({ throwOnError: true }).catch(() => undefined);
    await flushReads();
    newer = true;
    await useSyncStore.getState().loadConfig();
    if (late === "resolve") oldConflicts.resolve([conflictFixture]);
    else oldConflicts.reject(new Error("Network timeout"));
    await old;
    expect(useSyncStore.getState().config?.conflict_count).toBe(0);
    expect(useSyncStore.getState().conflicts).toEqual([]);
    expect(useSyncStore.getState().error).toBeNull();
    expect(useSyncStore.getState().configError).toBeNull();
  });

  it("successful conflict read cannot erase an unrelated login failure", async () => {
    const conflicts = deferred<SyncConflict[]>();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_login") throw new Error("Network timeout");
      if (cmd === "sync_list_conflicts") return conflicts.promise;
      return readResult(cmd);
    });
    const read = useSyncStore.getState().loadConflicts();
    await expect(mutate("login")).rejects.toThrow();
    const loginError = useSyncStore.getState().error;
    conflicts.resolve([]);
    await read;
    expect(loginError).toBeTruthy();
    expect(useSyncStore.getState().error).toBe(loginError);
  });

  it.each(["logout", "clearLocalSyncData"].flatMap((exit) => [
    { exit, late: "resolve" }, { exit, late: "reject" },
  ]))("$exit invalidates late $late from sync, config, conflict and retry without repeating writes", async ({ exit, late }) => {
    const syncWrite = deferred<typeof resultFixture>();
    const oldConfig = deferred<SyncConfig>();
    const oldConflicts = deferred<SyncConflict[]>();
    const oldSnippets = deferred<unknown[]>();
    let exiting = false;
    let holdingReads = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "sync_now") return syncWrite.promise;
      if (cmd === "sync_logout") { exiting = true; return undefined; }
      if (cmd === "sync_get_config") return exiting ? { ...configFixture, is_logged_in: false, account_id: null }
        : holdingReads ? oldConfig.promise : configFixture;
      if (cmd === "sync_list_conflicts" && holdingReads && !exiting) return oldConflicts.promise;
      if (cmd === "snippet_list" && !exiting) return oldSnippets.promise;
      return readResult(cmd);
    });
    const retry = mutate("retry").catch(() => undefined);
    await flushReads();
    const sync = mutate("sync").catch(() => undefined);
    holdingReads = true;
    const config = useSyncStore.getState().loadConfig();
    const conflicts = useSyncStore.getState().loadConflicts().catch(() => []);
    await useSyncStore.getState()[exit as "logout" | "clearLocalSyncData"]();
    const exitedConfig = useSyncStore.getState().config;
    if (late === "resolve") {
      syncWrite.resolve(resultFixture); oldConfig.resolve({ ...configFixture, conflict_count: 1 });
      oldConflicts.resolve([conflictFixture]); oldSnippets.resolve([]);
    } else {
      const failure = new Error("Network timeout");
      syncWrite.reject(failure); oldConfig.reject(failure); oldConflicts.reject(failure); oldSnippets.reject(failure);
    }
    await Promise.all([sync, config, conflicts, retry]);
    expect(exitedConfig?.is_logged_in).toBe(false);
    expect(useSyncStore.getState().config).toEqual(exitedConfig);
    expect(useSyncStore.getState().conflicts).toEqual([]);
    expect(useSyncStore.getState().lastResult).toBeNull();
    expect(useSyncStore.getState().error).toBeNull();
    expect(useSyncStore.getState().configError).toBeNull();
    expect(useSyncStore.getState().refreshError).toBeNull();
    expect(useSyncStore.getState().syncing).toBe(false);
    expect(useSyncStore.getState().refreshingViews).toBe(false);
    expect(commandCalls("sync_now")).toHaveLength(1);
    expect(commandCalls("sync_logout")).toHaveLength(1);
    if (late === "resolve") expect(commandCalls("vault_status").length).toBeGreaterThan(1);
  });
});
