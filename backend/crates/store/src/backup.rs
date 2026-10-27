//! 数据快照备份：更新/迁移前的一致性快照、列表、裁剪与恢复。
//!
//! 设计要点：
//! * 快照用 SQLite 官方 `VACUUM INTO` 生成——在 WAL 模式下也能得到**事务一致**的单文件副本，
//!   不需要停写、不依赖文件复制时序（直接复制 `.db` 会漏掉 `-wal` 里的已提交数据）。
//! * 快照文件名格式固定为 `openshell_<版本>_<原因>_<UTC时间戳>.db`，解析靠下划线分隔，
//!   因此版本号里的 `-`（预发布标识）不会破坏解析。
//! * 裁剪**只**删除本模块自己产出的自动快照（`pre-migration` / `pre-install` / `post-upgrade`），
//!   用户手动触发的快照（`manual`）与用户自己导出的 `.osvault` 永不自动删除。
//! * 恢复前会把当前数据库改名留档为 `openshell.db.broken-<时间戳>`，绝不静默丢弃数据。

use crate::models::map_sql_error;
use crate::Store;
use openshell_core_domain::{now_ms, DomainError, DomainResult, ErrorCode};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

/// 自动快照文件前缀。
pub const BACKUP_PREFIX: &str = "openshell_";

/// 默认保留的自动快照份数（用户可配置 1..=20）。
pub const DEFAULT_KEEP_BACKUPS: usize = 5;

/// 自动快照份数的合法上限，避免用户把保留数调到无限大。
pub const MAX_KEEP_BACKUPS: usize = 20;

const TS_FORMAT: &[FormatItem<'static>] =
    format_description!("[year][month][day]T[hour][minute][second][subsecond digits:3]Z");

/// 生成快照的原因；决定文件名与「是否参与自动裁剪」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupReason {
    /// schema 迁移前。
    PreMigration,
    /// 安装更新包前（`InstallStrategy` 调用）。
    PreInstall,
    /// 升级后首次启动（迁移已成功，作为回退锚点）。
    PostUpgrade,
    /// 用户在设置页手动触发。
    Manual,
}

impl BackupReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreMigration => "pre-migration",
            Self::PreInstall => "pre-install",
            Self::PostUpgrade => "post-upgrade",
            Self::Manual => "manual",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pre-migration" => Some(Self::PreMigration),
            "pre-install" => Some(Self::PreInstall),
            "post-upgrade" => Some(Self::PostUpgrade),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    /// 是否允许被保留策略自动删除。手动快照永不删除。
    pub fn is_prunable(&self) -> bool {
        !matches!(self, Self::Manual)
    }
}

/// 一份快照的描述，序列化后直接给前端展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    /// 绝对路径。
    pub path: String,
    /// 纯文件名。
    pub file_name: String,
    /// 文件字节数。
    pub size_bytes: u64,
    /// 生成时间（Unix 毫秒）。
    pub created_at_ms: i64,
    /// 生成原因。
    pub reason: BackupReason,
    /// 生成快照时客户端的版本号。
    pub app_version: String,
}

/// 创建一份快照。
///
/// * `backups_dir`：快照目录（通常为 `<app_data_dir>/backups`）。
/// * `app_version`：写入文件名与描述，方便用户与支持人员辨认。
/// * `reason`：见 [`BackupReason`]。
///
/// 错误：磁盘不可写 / 空间不足 / 数据库不可读时返回 `IO` 错误；不会改动现有数据。
pub fn create(
    store: &Store,
    backups_dir: &Path,
    app_version: &str,
    reason: BackupReason,
) -> DomainResult<BackupInfo> {
    std::fs::create_dir_all(backups_dir).map_err(DomainError::from)?;
    // 快照是**明文** SQLite（与主库同级敏感），目录收紧到仅当前用户可读写
    tighten_dir(backups_dir);

    let stamp = utc_stamp();
    let file_name = format!(
        "{BACKUP_PREFIX}{}_{}_{}.db",
        sanitize_version(app_version),
        reason.as_str(),
        stamp
    );
    let path = backups_dir.join(&file_name);

    // 同一秒内重复调用（例如测试）时覆盖同名文件，避免 VACUUM INTO 因目标存在而失败。
    if path.exists() {
        std::fs::remove_file(&path).map_err(DomainError::from)?;
    }

    let target = path.to_string_lossy().to_string();
    store.with_conn(|conn| {
        conn.execute("VACUUM INTO ?1", params![target])
            .map_err(map_sql_error)
    })?;

    tighten_file(&path);
    let size_bytes = std::fs::metadata(&path).map_err(DomainError::from)?.len();
    let created_at_ms = file_modified_ms(&path).unwrap_or_else(now_ms);

    tracing::info!(
        file = %file_name,
        reason = reason.as_str(),
        size_bytes,
        "database snapshot created"
    );

    Ok(BackupInfo {
        path: path.to_string_lossy().to_string(),
        file_name,
        size_bytes,
        created_at_ms,
        reason,
        app_version: app_version.to_string(),
    })
}

/// 列出目录下的全部快照，按生成时间从新到旧排序。目录不存在时返回空列表。
pub fn list(backups_dir: &Path) -> DomainResult<Vec<BackupInfo>> {
    let entries = match std::fs::read_dir(backups_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(DomainError::from(err)),
    };

    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(DomainError::from)?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some((app_version, reason)) = parse_backup_name(name) else {
            continue;
        };
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let created_at_ms = file_modified_ms(&path).unwrap_or(0);
        items.push(BackupInfo {
            path: path.to_string_lossy().to_string(),
            file_name: name.to_string(),
            size_bytes,
            created_at_ms,
            reason,
            app_version,
        });
    }

    items.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    Ok(items)
}

/// 按保留策略裁剪自动快照，返回被删除的文件路径。
///
/// 只处理文件名可解析为 `openshell_<版本>_<原因>_<时间戳>.db` 且原因可裁剪的文件；
/// `keep` 会被夹到 `1..=MAX_KEEP_BACKUPS`。用户手动快照永远不会被删除。
pub fn prune(backups_dir: &Path, keep: usize) -> DomainResult<Vec<PathBuf>> {
    let keep = keep.clamp(1, MAX_KEEP_BACKUPS);
    let mut removed = Vec::new();

    let mut prunable: Vec<(i64, PathBuf)> = list(backups_dir)?
        .into_iter()
        .filter(|b| b.reason.is_prunable())
        .map(|b| (b.created_at_ms, PathBuf::from(b.path)))
        .collect();
    // 新的排在前面，skip(keep) 之后就是要删的旧快照
    prunable.sort_by_key(|(created_at, _)| std::cmp::Reverse(*created_at));

    for (_, path) in prunable.into_iter().skip(keep) {
        match std::fs::remove_file(&path) {
            Ok(()) => {
                tracing::info!(file = %path.display(), "old auto backup pruned");
                removed.push(path);
            }
            // 单个文件删除失败不应让启动/更新流程失败。
            Err(err) => {
                tracing::warn!(file = %path.display(), error = %err, "failed to prune backup")
            }
        }
    }
    Ok(removed)
}

/// 用快照覆盖当前数据库。
///
/// 调用方必须保证 `Store` 已经关闭（没有打开的连接），否则恢复结果不可预期。
/// 步骤：清理 `-wal`/`-shm` 边车文件 → 把当前库改名留档 → 复制快照到 `db_path`。
pub fn restore(snapshot_path: &Path, db_path: &Path) -> DomainResult<()> {
    if !snapshot_path.is_file() {
        return Err(DomainError::new(
            ErrorCode::NotFound,
            "backup snapshot is missing",
        ));
    }

    for suffix in ["-wal", "-shm"] {
        let sidecar = sidecar_path(db_path, suffix);
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).map_err(DomainError::from)?;
        }
    }

    if db_path.exists() {
        let quarantine = db_path.with_file_name(format!("openshell.db.broken-{}", utc_stamp()));
        std::fs::rename(db_path, &quarantine).map_err(DomainError::from)?;
        tracing::warn!(
            quarantined = %quarantine.display(),
            "current database kept aside before restore"
        );
    }

    std::fs::copy(snapshot_path, db_path).map_err(DomainError::from)?;
    tracing::warn!(
        snapshot = %snapshot_path.display(),
        "database restored from snapshot"
    );
    Ok(())
}

/// `<db>-wal` / `<db>-shm` 的拼装方式（不能用 `with_extension`，会吃掉 `.db`）。
pub fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut raw = db_path.as_os_str().to_os_string();
    raw.push(suffix);
    PathBuf::from(raw)
}

/// 解析快照文件名，返回（版本号, 原因）。
fn parse_backup_name(name: &str) -> Option<(String, BackupReason)> {
    let body = name.strip_prefix(BACKUP_PREFIX)?.strip_suffix(".db")?;
    let mut parts = body.split('_');
    let version = parts.next()?;
    let reason = parts.next()?;
    // 时间戳必须存在，避免把用户手工放进来的同类文件误判成自动快照。
    parts.next()?;
    if parts.next().is_some() || version.is_empty() {
        return None;
    }
    Some((version.to_string(), BackupReason::parse(reason)?))
}

/// 版本号只保留安全字符，保证文件名可解析（`1.1.0-rc.1` → `1.1.0-rc.1`）。
fn sanitize_version(version: &str) -> String {
    let cleaned: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn utc_stamp() -> String {
    OffsetDateTime::now_utc()
        .format(TS_FORMAT)
        .unwrap_or_else(|_| "19700101T000000Z".to_string())
}

fn file_modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

/// 收紧备份目录权限到 `0700`（Unix）。
///
/// 快照是明文 SQLite，里面等同主库的敏感内容（连接配置、加密后的密钥槽位）。
/// Windows 上用户数据目录（`%APPDATA%`）本身已按用户隔离，无需额外 ACL 修改，
/// 因此这里是 no-op —— 详见 `docs/UPDATE.md`「备份保护」。
///
/// 失败只记日志：权限收紧是加固手段，不应让备份直接失败。
#[cfg(unix)]
fn tighten_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(err) = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)) {
        tracing::warn!(dir = %dir.display(), error = %err, "failed to tighten backup dir permissions");
    }
}

#[cfg(not(unix))]
fn tighten_dir(_dir: &Path) {}

/// 收紧快照文件权限到 `0600`（Unix）；Windows 为 no-op，原因同上。
#[cfg(unix)]
fn tighten_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(err) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(file = %path.display(), error = %err, "failed to tighten backup file permissions");
    }
}

#[cfg(not(unix))]
fn tighten_file(_path: &Path) {}

#[cfg(all(test, unix))]
mod permission_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn tightens_backup_dir_to_owner_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backups = dir.path().join("backups");
        std::fs::create_dir_all(&backups).expect("mkdir");
        tighten_dir(&backups);
        let mode = std::fs::metadata(&backups)
            .expect("meta")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "backup dir must be owner-only, got {mode:o}");
    }

    #[test]
    fn tightens_snapshot_file_to_owner_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir
            .path()
            .join("openshell_1.0.1_pre-install_20260101T000000Z.db");
        std::fs::write(&file, b"sqlite").expect("write");
        tighten_file(&file);
        let mode = std::fs::metadata(&file).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "snapshot must be owner-only, got {mode:o}");
    }
}
