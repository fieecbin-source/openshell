//! `PRAGMA user_version` 驱动的内嵌迁移。

use crate::models::map_sql_error;
use crate::Store;
use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use rusqlite::TransactionBehavior;

/// 当前程序支持的 schema 版本。
pub const SCHEMA_VERSION: u32 = 1;

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");

impl Store {
    /// 执行未应用的迁移并返回当前 schema 版本；重复调用幂等。
    ///
    /// 若数据库版本高于程序支持版本，返回 `VAULT_CORRUPT`（拒绝降级改写）。
    pub fn migrate(&self) -> DomainResult<u32> {
        self.with_conn(|conn| {
            let current: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(map_sql_error)?;

            if current > i64::from(SCHEMA_VERSION) {
                return Err(DomainError::new(
                    ErrorCode::VaultCorrupt,
                    "database schema is newer than this application",
                ));
            }

            if current < 1 {
                let tx = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(map_sql_error)?;
                tx.execute_batch(MIGRATION_001).map_err(map_sql_error)?;
                tx.pragma_update(None, "user_version", 1i64)
                    .map_err(map_sql_error)?;
                tx.commit().map_err(map_sql_error)?;
            }

            // 确保会话的 host_key_policy 统一为 accept_new，防止 strict 导致首次建连被未知主机公钥阻断
            let _ = conn.execute(
                "UPDATE session SET host_key_policy = 'accept_new' WHERE host_key_policy = 'strict'",
                [],
            );

            // 修正历史数据：早期版本把「未删除」写成了 deleted_at = 0，
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
