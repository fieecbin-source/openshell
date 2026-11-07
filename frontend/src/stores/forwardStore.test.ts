import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardCreate, forwardList, forwardListStatuses } from "../lib/ipc";
import { useForwardStore } from "./forwardStore";
import type { ForwardRuleView, ForwardStatus } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  forwardList: vi.fn(),
  forwardListStatuses: vi.fn(),
  forwardCreate: vi.fn(),
  forwardUpdate: vi.fn(),
  forwardDelete: vi.fn(),
  forwardStart: vi.fn(),
  forwardStop: vi.fn(),
}));

const healthy: ForwardRuleView = {
  id: "rule_a",
  credential_state: "ready",
  session_id: "sess_1",
  name: "healthy",
  rule_type: "dynamic",
  bind_host: "127.0.0.1",
  bind_port: 1080,
  dest_host: null,
  dest_port: null,
  auto_start: false,
  auto_reconnect: true,
  reconnect_max: 3,
  socks_auth: "userpass",
  socks_username: "user",
  socks_password_ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  has_socks_password: true,
  expose_warning_ack: false,
  sort_order: 0,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};

// 脱敏列举契约：坏行的未知 ref 不回传，只给布尔/状态元数据。
const broken: ForwardRuleView = {
  ...healthy,
  id: "rule_b",
  name: "broken",
  bind_port: 1081,
  socks_password_ref: null,
  has_socks_password: false,
  credential_state: "needs_reentry",
};

type RecoveredState = {
  loadError: string | null;
  refreshError: string | null;
  retryRefresh: () => Promise<void>;
};

const state = () => useForwardStore.getState() as ReturnType<typeof useForwardStore.getState> & RecoveredState;

describe("forwardStore credential recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(forwardListStatuses).mockResolvedValue({});
    useForwardStore.setState({ rules: [], statuses: {}, loading: false, activeSessionId: null });
  });

  it("keeps a redacted broken rule in the list and exposes its credential state", async () => {
    vi.mocked(forwardList).mockResolvedValue([healthy, broken]);
    await state().loadRules("sess_1");
    expect(state().rules).toHaveLength(2);
    const bad = state().rules.find((rule) => rule.id === "rule_b");
    expect(bad?.socks_password_ref).toBeNull();
    expect(bad?.credential_state).toBe("needs_reentry");
  });

  it("does not swallow a real IPC read failure", async () => {
    vi.mocked(forwardList).mockRejectedValue(new Error("forward_list failed"));
    await expect(state().loadRules("sess_1")).rejects.toThrow("forward_list failed");
    expect(state().loading).toBe(false);
  });

  it("separates a successful mutation from a failed refresh and retries by reading only", async () => {
    vi.mocked(forwardCreate).mockResolvedValue(healthy);
    vi.mocked(forwardList)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce([healthy]);

    const created = await state().createRule({ name: "healthy", bind_port: 1080 });
    expect(created.id).toBe("rule_a");
    expect(state().refreshError).toContain("refresh failed");

    await state().retryRefresh();
    expect(forwardCreate).toHaveBeenCalledTimes(1);
    expect(forwardList).toHaveBeenCalledTimes(2);
    expect(state().refreshError).toBeNull();
    expect(state().rules).toEqual([healthy]);
  });

  it("exposes status read failures instead of silently reporting success", async () => {
    vi.mocked(forwardListStatuses).mockRejectedValue(new Error("status failed"));
    await expect(state().loadStatuses()).rejects.toThrow("status failed");
  });

  it("delayed refreshAfterMutation A resolving late after refresh B fails must not clear B's refreshError", async () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const defA = deferred<any[]>();
    vi.mocked(forwardCreate).mockResolvedValue(healthy);

    // Refresh A will be delayed on forwardList
    vi.mocked(forwardList)
      .mockReturnValueOnce(defA.promise)
      .mockRejectedValueOnce(new Error("Refresh B network timeout"));

    // Mutation A starts, triggers Refresh A (delayed)
    const pA = state().createRule({ name: "Rule A", bind_port: 1080 });

    await Promise.resolve();
    await Promise.resolve();

    // Mutation B starts, triggers Refresh B (which fails)
    const pB = state().createRule({ name: "Rule B", bind_port: 1081 });
    await pB;

    // Refresh B set refreshError
    expect(state().refreshError).toContain("Refresh B network timeout");

    // Now Refresh A resolves late with success
    defA.resolve([healthy]);
    await pA;

    // Refresh A must NOT have cleared Refresh B's error!
    expect(state().refreshError).toContain("Refresh B network timeout");
  });

  it("delayed loadStatuses A resolving late after loadStatuses B must not overwrite newer statuses", async () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const defA = deferred<Record<string, any>>();
    const defB = deferred<Record<string, any>>();

    vi.mocked(forwardListStatuses)
      .mockReturnValueOnce(defA.promise)
      .mockReturnValueOnce(defB.promise);

    const pA = state().loadStatuses();
    const pB = state().loadStatuses();

    // B resolves with Listening
    defB.resolve({ rule_1: { state: "Listening" as any } });
    await pB;
    expect(state().statuses).toEqual({ rule_1: { state: "Listening" } });

    // A resolves late with Stopped
    defA.resolve({ rule_1: { state: "Stopped" as any } });
    await pA;

    // A must NOT overwrite B's Listening status!
    expect(state().statuses).toEqual({ rule_1: { state: "Listening" } });
  });

  it.each(["rules", "statuses"] as const)(
    "keeps the latest statuses when an older %s read completes across both read paths",
    async (olderReader) => {
      let resolveOlder!: (statuses: Record<string, ForwardStatus>) => void;
      const olderStatuses = new Promise<Record<string, ForwardStatus>>((resolve) => {
        resolveOlder = resolve;
      });
      const latestStatuses: Record<string, ForwardStatus> = {
        rule_a: { state: "Stopped" },
      };
      vi.mocked(forwardList).mockResolvedValue([healthy]);
      vi.mocked(forwardListStatuses)
        .mockReturnValueOnce(olderStatuses)
        .mockResolvedValueOnce(latestStatuses);

      const olderRead = olderReader === "rules"
        ? state().loadRules("sess_1")
        : state().loadStatuses();
      await (olderReader === "rules"
        ? state().loadStatuses()
        : state().loadRules("sess_1"));
      resolveOlder({ rule_a: { state: "Listening", details: { bound_addr: "127.0.0.1:1080" } } });
      await olderRead;

      expect(state().statuses).toEqual(latestStatuses);
      expect(state().rules).toEqual([healthy]);
      expect(state().loading).toBe(false);
      expect(state().activeSessionId).toBe("sess_1");
    },
  );
});
