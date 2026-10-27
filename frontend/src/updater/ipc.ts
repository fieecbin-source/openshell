/** 更新相关 IPC 封装：只负责 invoke，不含任何状态或文案。 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  BackupInfo,
  BackupReason,
  CheckView,
  DownloadOutcome,
  DownloadProgress,
  InstallView,
  UpdateAsset,
  UpdateConfig,
  UpdaterStateView,
} from "./types";

export async function fetchUpdaterState(): Promise<UpdaterStateView> {
  return await invoke<UpdaterStateView>("updater_get_state");
}

export async function checkForUpdate(
  config: UpdateConfig,
  force: boolean
): Promise<CheckView> {
  return await invoke<CheckView>("updater_check", { config, force });
}

export async function downloadInstaller(
  config: UpdateConfig,
  asset: UpdateAsset,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadOutcome> {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;
  return await invoke<DownloadOutcome>("updater_download", {
    config,
    asset,
    onProgress: channel,
  });
}

export async function cancelDownload(): Promise<void> {
  await invoke("updater_cancel_download");
}

export async function installUpdate(
  path: string,
  asset: UpdateAsset,
  version: string
): Promise<InstallView> {
  return await invoke<InstallView>("updater_install", { path, asset, version });
}

export async function skipVersion(version: string): Promise<void> {
  await invoke("updater_skip_version", { version });
}

export async function remindLater(hours?: number): Promise<void> {
  await invoke("updater_remind_later", { hours: hours ?? null });
}

export async function clearSkippedVersions(): Promise<void> {
  await invoke("updater_clear_skipped");
}

export async function backupNow(reason?: BackupReason): Promise<BackupInfo> {
  return await invoke<BackupInfo>("updater_backup_now", { reason: reason ?? null });
}

export async function listBackups(): Promise<BackupInfo[]> {
  return await invoke<BackupInfo[]>("updater_list_backups");
}

export async function openReleasePage(config?: UpdateConfig): Promise<void> {
  await invoke("updater_open_release_page", { config: config ?? null });
}

export async function openLogDir(): Promise<void> {
  await invoke("updater_open_log_dir");
}

export async function openBackupDir(): Promise<void> {
  await invoke("updater_open_backup_dir");
}

/** 打开已下载安装包所在目录（安装失败或便携版时让用户手动替换）。 */
export async function openDownloadDir(): Promise<void> {
  await invoke("updater_open_download_dir");
}
