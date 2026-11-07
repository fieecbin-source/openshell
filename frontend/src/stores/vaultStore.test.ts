import { describe, it, expect, vi, beforeEach } from "vitest";
import { useVaultStore } from "./vaultStore";
import * as ipcModule from "../lib/ipc";
import type { VaultStatus } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  getVaultStatus: vi.fn(),
  initVault: vi.fn(),
  unlockVault: vi.fn(),
  lockVault: vi.fn(),
  changeVaultPassword: vi.fn(),
}));

const mockStatus: VaultStatus = {
  state: "unlocked",
  vault_id: "vault_1",
  auto_lock_minutes: 15,
  keychain_enabled: true,
  last_opened_at: 1000,
};

describe("vaultStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({
      status: null,
      isLoading: true,
      error: null,
    });
  });

  it.each(["resolve", "reject"])("ignores an older status read's late %s after a retry", async (outcome) => {
    let resolve!: (value: VaultStatus) => void;
    let reject!: (reason: Error) => void;
    const oldRead = new Promise<VaultStatus>((yes, no) => { resolve = yes; reject = no; });
    const fresh: VaultStatus = { ...mockStatus, state: "locked" };
    vi.mocked(ipcModule.getVaultStatus).mockReturnValueOnce(oldRead).mockResolvedValueOnce(fresh);
    const pending = useVaultStore.getState().checkStatus({ throwOnError: true }).catch(() => {});
    await useVaultStore.getState().checkStatus({ throwOnError: true });
    if (outcome === "resolve") resolve(mockStatus);
    else reject(new Error("obsolete read failure"));
    await pending;
    expect(useVaultStore.getState().status).toEqual(fresh);
    expect(useVaultStore.getState().error).toBeNull();
    expect(useVaultStore.getState().isLoading).toBe(false);
  });

  it("does not let a pending status read overwrite a completed lock", async () => {
    let resolve!: (value: VaultStatus) => void;
    vi.mocked(ipcModule.getVaultStatus).mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    const locked: VaultStatus = { ...mockStatus, state: "locked" };
    vi.mocked(ipcModule.lockVault).mockResolvedValueOnce(locked);
    const pending = useVaultStore.getState().checkStatus();
    await useVaultStore.getState().lock();
    resolve(mockStatus);
    await pending;
    expect(useVaultStore.getState().status).toEqual(locked);
  });

  it("checks vault status successfully and clears error", async () => {
    vi.mocked(ipcModule.getVaultStatus).mockResolvedValueOnce(mockStatus);
    useVaultStore.setState({ error: "Previous vault error" });

    await useVaultStore.getState().checkStatus();

    const state = useVaultStore.getState();
    expect(state.status).toEqual(mockStatus);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("preserves status and records friendly error when getVaultStatus fails without throwing by default", async () => {
    useVaultStore.setState({ status: mockStatus });
    vi.mocked(ipcModule.getVaultStatus).mockRejectedValueOnce(new Error("Vault disk corrupt"));

    await expect(useVaultStore.getState().checkStatus()).resolves.toBeUndefined();

    const state = useVaultStore.getState();
    expect(state.status).toEqual(mockStatus);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeTruthy();
  });

  it("re-throws error when throwOnError is true on getVaultStatus failure", async () => {
    vi.mocked(ipcModule.getVaultStatus).mockRejectedValueOnce(new Error("Vault read error"));

    await expect(
      useVaultStore.getState().checkStatus({ throwOnError: true })
    ).rejects.toThrow("Vault read error");

    expect(useVaultStore.getState().error).toBeTruthy();
  });

  it("updates status on lock", async () => {
    const lockedStatus: VaultStatus = { ...mockStatus, state: "locked" };
    vi.mocked(ipcModule.lockVault).mockResolvedValueOnce(lockedStatus);

    await useVaultStore.getState().lock();

    expect(useVaultStore.getState().status).toEqual(lockedStatus);
    expect(useVaultStore.getState().isLoading).toBe(false);
  });
});
