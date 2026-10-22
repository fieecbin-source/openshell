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

            Ok(SCHEMA_VERSION)
        })
    }
}
