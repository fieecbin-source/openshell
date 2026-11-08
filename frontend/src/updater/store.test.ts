import { afterEach, expect, it, vi } from "vitest";
import * as api from "./ipc";
import { useUpdaterStore } from "./store";
import type { UpdateCheckResult } from "./types";
import { settingsGet, settingsSet, getAppInfo } from "../lib/ipc";

vi.mock("./ipc", () => ({
  installUpdate: vi.fn(),
  backupNow: vi.fn(),
  fetchUpdaterState: vi.fn(),
  openBackupDir: vi.fn(),
  openLogDir: vi.fn(),
  openDownloadDir: vi.fn(),
  openReleasePage: vi.fn(),
  listBackups: vi.fn(),
  checkForUpdate: vi.fn(),
  downloadInstaller: vi.fn(),
  cancelDownload: vi.fn(),
  skipVersion: vi.fn(),
  remindLater: vi.fn(),
  clearSkippedVersions: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  getAppInfo: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  useUpdaterStore.setState({ state: { kind: "idle" }, installHint: null, installing: false, bootstrapped: false });
});

it("does not launch a second update while preparing or waiting for app exit", async () => {
  const result: UpdateCheckResult = {
    has_update: true, current_version: "1.1.1", latest_version: "1.1.4", tag: "v1.1.4",
    release_name: "OpenShell 1.1.4", release_notes: "", notes_html: "",
    asset: { name: "OpenShell-1.1.4-windows-x86_64-portable.zip", url: "https://github.com/a/b/x.zip",
      size: 1, sha256: "0".repeat(64), manifest: "{}", signature: "{}" },
    mandatory: false, channel: "stable", from_cache: false,
    release_page_url: "https://github.com/a/b/releases", source: "github", checked_at_ms: 1,
  };
  let complete!: (value: { strategy: "self_install"; launched: boolean }) => void;
  vi.mocked(api.installUpdate).mockResolvedValue({ strategy: "self_install", launched: true })
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  useUpdaterStore.setState({ state: { kind: "ready", result, path: "C:/Downloads/update.zip" } });
  const first = useUpdaterStore.getState().install();
  const second = useUpdaterStore.getState().install();
  expect(api.installUpdate).toHaveBeenCalledTimes(1);
  complete({ strategy: "self_install", launched: true });
  await Promise.all([first, second]);
  await useUpdaterStore.getState().install();
  expect(api.installUpdate).toHaveBeenCalledTimes(1);
  expect(useUpdaterStore.getState().installHint).toBeNull();
});

it("retries the downloaded installer after a launch failure", async () => {
  const result: UpdateCheckResult = {
    has_update: true,
    current_version: "1.1.1",
    latest_version: "1.1.4",
    tag: "v1.1.4",
    release_name: "OpenShell 1.1.4",
    release_notes: "",
    notes_html: "",
    asset: {
      name: "OpenShell.exe",
      url: "https://github.com/a/b/x.exe",
      size: 1,
      sha256: "0".repeat(64),
    },
    mandatory: false,
    channel: "stable",
    from_cache: false,
    release_page_url: "https://github.com/a/b/releases",
    source: "github",
    checked_at_ms: 1,
  };
  const error = { code: "UPDATE_INSTALL_FAILED", message: "cancelled", retryable: true };
  vi.spyOn(console, "error").mockImplementation(() => { });
  vi.mocked(api.installUpdate)
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({
      strategy: "self_install",
      launched: true,
    });
  useUpdaterStore.setState({
    state: { kind: "ready", result, path: "C:/Downloads/OpenShell.exe" },
  });

  await useUpdaterStore.getState().install();
  expect(useUpdaterStore.getState().state).toMatchObject({ kind: "install_failed" });
  await useUpdaterStore.getState().install();
  expect(api.installUpdate).toHaveBeenCalledTimes(2);
  expect(api.installUpdate).toHaveBeenLastCalledWith(
    "C:/Downloads/OpenShell.exe",
    result.asset,
    "1.1.4"
  );
});

it("propagates backupNow rejection up to caller without swallowing", async () => {
  vi.mocked(api.backupNow).mockRejectedValueOnce(new Error("Disk full: unable to write snapshot"));

  await expect(useUpdaterStore.getState().backupNow()).rejects.toThrow("Disk full");
});

it("returns BackupInfo from backupNow on success and refreshes runtime", async () => {
  const mockBackup = {
    file_name: "openshell_backup_20261106.db",
    path: "C:/data/backups/openshell_backup_20261106.db",
    size_bytes: 1048576,
    created_at_ms: Date.now(),
    reason: "manual" as const,
    app_version: "1.0.0",
  };
  vi.mocked(api.backupNow).mockResolvedValueOnce(mockBackup);
  vi.mocked(api.fetchUpdaterState).mockResolvedValueOnce({
    backups_dir: "C:/data/backups",
  } as any);

  const res = await useUpdaterStore.getState().backupNow();

  expect(res).toEqual(mockBackup);
  expect(api.backupNow).toHaveBeenCalledWith("manual");
  expect(api.fetchUpdaterState).toHaveBeenCalled();
});

it("reads canonical update.backup_keep and prioritizes it over legacy update.backupKeep", async () => {
  vi.mocked(settingsGet).mockImplementation(async (_scope, key) => {
    if (key === "update.backup_keep") return { value_json: 20 } as any;
    if (key === "update.backupKeep") return { value_json: 10 } as any;
    return null;
  });
  vi.mocked(getAppInfo).mockResolvedValueOnce(null as any);
  vi.mocked(api.fetchUpdaterState).mockResolvedValueOnce(null as any);

  await useUpdaterStore.getState().bootstrap();

  expect(useUpdaterStore.getState().config.backup_keep).toBe(20);
});

it("falls back to legacy update.backupKeep if canonical key is not present", async () => {
  vi.mocked(settingsGet).mockImplementation(async (_scope, key) => {
    if (key === "update.backup_keep") return null;
    if (key === "update.backupKeep") return { value_json: 15 } as any;
    return null;
  });
  vi.mocked(getAppInfo).mockResolvedValueOnce(null as any);
  vi.mocked(api.fetchUpdaterState).mockResolvedValueOnce(null as any);

  await useUpdaterStore.getState().bootstrap();

  expect(useUpdaterStore.getState().config.backup_keep).toBe(15);
});

it("writes only canonical update.backup_keep on patchConfig", async () => {
  vi.mocked(settingsSet).mockResolvedValue({} as any);

  await useUpdaterStore.getState().patchConfig({ backup_keep: 25 });

  expect(settingsSet).toHaveBeenCalledWith("user", "update.backup_keep", 25);
  expect(settingsSet).not.toHaveBeenCalledWith("user", "update.backupKeep", 25);
  expect(useUpdaterStore.getState().config.backup_keep).toBe(25);
});
