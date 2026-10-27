//! `PRAGMA user_version` 驱动的内嵌迁移，配套「迁移前快照 + 失败自动恢复」。
//!
//! 安全承诺（对应 docs/UPDATE.md 的数据保护章节）：
//! 1. 每一步迁移都在 `IMMEDIATE` 事务中执行，失败即整体回滚，不会留下半成品 schema。
//! 2. 有数据的库在迁移前先用 `VACUUM INTO` 打一份一致快照。
//! 3. 迁移失败时关闭连接 → 用快照覆盖主库（原库改名留档）→ 以旧 schema 重新打开，
//!    返回带 `recovered_from` 的报告，让 UI 提示用户「数据已从备份恢复」。
//! 4. 数据库版本高于当前程序时直接拒绝启动写入（`SCHEMA_NEWER_THAN_APP`），绝不降级覆盖。

use crate::backup::{self, BackupInfo, BackupReason, DEFAULT_KEEP_BACKUPS};
use crate::models::map_sql_error;
use crate::Store;
use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use rusqlite::TransactionBehavior;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// 当前程序支持的 schema 版本。
pub const SCHEMA_VERSION: u32 = 2;

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("../migrations/002_app_meta.sql");

/// 迁移脚本清单：`(目标版本, SQL)`，必须按版本升序。
const MIGRATIONS: &[(u32, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002)];

/// 测试注入点：命中该版本时在提交前抛错，用于验证回滚与快照恢复。0 表示不注入。
static FAIL_MIGRATION_AT: AtomicU32 = AtomicU32::new(0);

/// 仅供测试：让指定目标版本的迁移必定失败；传 `None` 取消注入。
#[doc(hidden)]
pub fn force_migration_failure(target: Option<u32>) {
    FAIL_MIGRATION_AT.store(target.unwrap_or(0), Ordering::SeqCst);
}

fn injected_failure(target: u32) -> bool {
    FAIL_MIGRATION_AT.load(Ordering::SeqCst) == target
}

/// 打开数据库时需要的数据安全参数。
#[derive(Debug, Clone)]
pub struct MigrationOptions {
    /// 客户端版本号，写进快照文件名，便于用户辨认。
    pub app_version: String,
    /// 快照目录（`<app_data_dir>/backups`）。
    pub backups_dir: PathBuf,
    /// 自动快照保留份数（1..=20）。
    pub keep_backups: usize,
}

impl MigrationOptions {
    pub fn new(app_version: impl Into<String>, backups_dir: impl Into<PathBuf>) -> Self {
        Self {
            app_version: app_version.into(),
            backups_dir: backups_dir.into(),
            keep_backups: DEFAULT_KEEP_BACKUPS,
        }
    }
}

/// 一次启动时的迁移结果，序列化后可通过 IPC 交给前端做提示。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MigrationReport {
    /// 本次启动时数据库的版本（恢复场景下即恢复后的版本）。
    pub from_version: u32,
    /// 当前数据库实际版本（等于 `SCHEMA_VERSION` 表示完全升级成功）。
    pub schema_version: u32,
    /// 迁移前自动创建的快照。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_migration_backup: Option<BackupInfo>,
    /// 若迁移失败并已从快照恢复，这里是所用快照。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<BackupInfo>,
    /// 恢复原因（面向用户的脱敏文本）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_reason: Option<String>,
}

impl MigrationReport {
    /// 是否发生了「迁移失败 → 从备份恢复」。
    pub fn was_recovered(&self) -> bool {
        self.recovered_from.is_some()
    }
}

/// 打开数据库并在需要时迁移；迁移失败会尝试从快照恢复后返回可用的旧库。
///
/// 返回的 `Store` 始终可用（要么是升级后的库，要么是恢复出来的旧库）。
/// 只有在「连旧库也打不开」或「库版本比程序新」时才返回 `Err`。
pub fn open_with_migration(
    db_path: &Path,
    opts: &MigrationOptions,
) -> DomainResult<(Store, MigrationReport)> {
    let existed = db_path.exists();
    let store = Store::open(db_path)?;
    let from_version = store.schema_version()?;

    if from_version > SCHEMA_VERSION {
        return Err(DomainError::new(
            ErrorCode::SchemaNewerThanApp,
            "local data was written by a newer OpenShell version",
        )
        .with_details(serde_json::json!({
            "db_schema": from_version,
            "app_schema": SCHEMA_VERSION,
        }))
        .with_retryable(false));
    }

    if from_version == SCHEMA_VERSION {
        return Ok((
            store,
            MigrationReport {
                from_version,
                schema_version: SCHEMA_VERSION,
                ..Default::default()
            },
        ));
    }

    // 有历史数据（版本 >= 1 且文件已存在）才值得打快照；全新库没有可丢的数据。
    let pre_migration_backup = if existed && from_version >= 1 {
        match backup::create(
            &store,
            &opts.backups_dir,
            &opts.app_version,
            BackupReason::PreMigration,
        ) {
            Ok(info) => Some(info),
            Err(err) => {
                // 备份失败时宁可放弃这次升级，也不能在没有退路的情况下改用户数据。
                return Err(DomainError::new(
                    ErrorCode::Io,
                    format!("failed to snapshot database before migration: {err}"),
                )
                .with_details(serde_json::json!({ "stage": "pre_migration_backup" })));
            }
        }
    } else {
        None
    };

    match store.run_migrations(from_version) {
        Ok(schema_version) => {
            if pre_migration_backup.is_some() {
                let _ = backup::prune(&opts.backups_dir, opts.keep_backups);
            }
            Ok((
                store,
                MigrationReport {
                    from_version,
                    schema_version,
                    pre_migration_backup,
                    ..Default::default()
                },
            ))
        }
        Err(err) => {
            tracing::error!(
                error = %err,
                from_version,
                target_version = SCHEMA_VERSION,
                "schema migration failed, trying to restore pre-migration snapshot"
            );

            let Some(snapshot) = pre_migration_backup else {
                return Err(err);
            };

            // 必须彻底关闭连接（释放 WAL）后再覆盖主库。
            drop(store);
            backup::restore(Path::new(&snapshot.path), db_path)?;

            let reopened = Store::open(db_path)?;
            let restored_version = reopened.schema_version()?;
            if restored_version != from_version {
                tracing::warn!(
                    expected = from_version,
                    actual = restored_version,
                    "restored database version differs from expected"
                );
            }

            Ok((
                reopened,
                MigrationReport {
                    from_version: restored_version,
                    schema_version: restored_version,
                    pre_migration_backup: Some(snapshot.clone()),
                    recovered_from: Some(snapshot),
                    recovery_reason: Some(format!(
                        "schema migration to v{SCHEMA_VERSION} failed and was rolled back"
                    )),
                },
            ))
        }
    }
}

impl Store {
    /// 读取数据库当前 schema 版本（`PRAGMA user_version`）。
    pub fn schema_version(&self) -> DomainResult<u32> {
        self.with_conn(|conn| {
            let raw: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(map_sql_error)?;
            u32::try_from(raw).map_err(|_| {
                DomainError::new(
                    ErrorCode::VaultCorrupt,
                    "database user_version is out of range",
                )
            })
        })
    }

    /// 执行未应用的迁移并返回当前 schema 版本；重复调用幂等。
    ///
    /// 若数据库版本高于程序支持版本，返回 `SCHEMA_NEWER_THAN_APP`（拒绝降级改写）。
    pub fn migrate(&self) -> DomainResult<u32> {
        let current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            return Err(DomainError::new(
                ErrorCode::SchemaNewerThanApp,
                "local data was written by a newer OpenShell version",
            ));
        }
        self.run_migrations(current)
    }

    /// 按版本顺序执行迁移；每一步独立事务，任一步失败即回滚该步。
    fn run_migrations(&self, from: u32) -> DomainResult<u32> {
        self.with_conn(|conn| {
            for (version, sql) in MIGRATIONS {
                if *version <= from {
                    continue;
                }
                let tx = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(map_sql_error)?;
                tx.execute_batch(sql).map_err(map_sql_error)?;
                if injected_failure(*version) {
                    // 事务未提交即返回：模拟真实迁移在提交前失败，SQLite 会整体回滚。
                    return Err(DomainError::internal("injected migration failure"));
                }
                tx.pragma_update(None, "user_version", i64::from(*version))
                    .map_err(map_sql_error)?;
                tx.commit().map_err(map_sql_error)?;
                tracing::info!(schema_version = version, "schema migration applied");
            }

            // 历史数据修补：早期版本把「未删除」写成了 deleted_at = 0，
            // 而查询统一按 IS NULL 判断，导致这些记录无法被读取。
            for table in [
                "secret",
                "credential",
                "ssh_key",
                "session",
                "session_group",
                "snippet",
                "port_forward",
                "known_host",
            ] {
                let _ = conn.execute(
                    &format!("UPDATE {table} SET deleted_at = NULL WHERE deleted_at = 0"),
                    [],
                );
            }

            Ok(SCHEMA_VERSION)
        })
    }
}
