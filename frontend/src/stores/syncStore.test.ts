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
    expect(useSyncStore.getState().error).toBe("Network timeout");
    expect(useSyncStore.getState().syncing).toBe(false);
  });
});
