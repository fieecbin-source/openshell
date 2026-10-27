/**
 * 与 Rust 侧 `openshell-updater` 的 DTO 一一对应。
 *
 * 注意字段命名：Tauri 命令的**顶层参数**是 camelCase，
 * 而结构体内部字段按 serde 默认的 snake_case 传输，这里刻意保持与后端一致。
 */

export type UpdateChannel = "stable" | "beta";

/** 代理模式（Rust 端用 `#[serde(tag = "mode")]` 的标签枚举）。 */
export type UpdateProxyMode =
  | { mode: "off" }
  | { mode: "env" }
  | { mode: "system" }
  | { mode: "custom"; url: string };

export interface UpdateConfig {
  owner: string;
  repo: string;
  channel: UpdateChannel;
  auto_check: boolean;
  interval_hours: number;
  backup_keep: number;
  fallback_source: string | null;
  mirror_prefix: string | null;
  proxy: UpdateProxyMode;
  allow_downgrade: boolean;
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  owner: "fieecbin-source",
  repo: "openshell",
  channel: "stable",
  auto_check: true,
  interval_hours: 6,
  backup_keep: 5,
  fallback_source: null,
  mirror_prefix: null,
  proxy: { mode: "system" },
  allow_downgrade: false,
};

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  tag: string;
  release_name: string;
  release_notes: string;
  notes_html: string;
  published_at?: string;
  asset?: UpdateAsset;
  mandatory: boolean;
  min_supported_version?: string;
  channel: UpdateChannel;
  from_cache: boolean;
  release_page_url: string;
  source: string;
  checked_at_ms: number;
}

/** 自动检查时是否应该打扰用户。 */
export type NotifyDecision = "notify" | "skipped" | "remind_later" | "up_to_date";

export interface CheckView {
  result: UpdateCheckResult;
  decision: NotifyDecision;
  from_cache: boolean;
}

export interface DownloadProgress {
  received: number;
  total?: number;
  percent: number;
  bytes_per_sec: number;
  phase: "downloading" | "verifying" | "done" | string;
}

export interface DownloadOutcome {
  path: string;
  bytes: number;
  resumed_from: number;
}

export interface RecoveryView {
  backup_path: string;
  created_at_ms: number;
  reason?: string;
}

export interface UpdaterStateView {
  current_version: string;
  target: string;
  arch: string;
  schema_version: number;
  data_dir: string;
  updater_dir: string;
  backups_dir: string;
  skipped_versions: string[];
  last_check_at_ms?: number | null;
  remind_after_ms?: number | null;
  last_error?: string | null;
  pending_install_path?: string | null;
  recovery?: RecoveryView | null;
}

export interface InstallView {
  strategy: string;
  launched: boolean;
  backup_path?: string;
  manual_hint?: string;
}

export type BackupReason = "pre_migration" | "pre_install" | "post_upgrade" | "manual";

export interface BackupInfo {
  path: string;
  file_name: string;
  size_bytes: number;
  created_at_ms: number;
  reason: BackupReason;
  app_version: string;
}
