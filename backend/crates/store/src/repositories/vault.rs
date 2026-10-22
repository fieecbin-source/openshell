//! 保险库元数据仓储（首版单 Vault）。

use crate::models::{ensure_id, map_sql_error, vault_from_row, VAULT_COLUMNS};
use crate::Store;
use openshell_core_domain::{now_ms, DomainError, DomainResult, VaultId, VaultRecord};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// 保险库仓储。
pub struct VaultRepo {
    store: Store,
}

impl VaultRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// 读取保险库记录；未初始化时返回 `None`。
    pub fn load(&self) -> DomainResult<Option<VaultRecord>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {VAULT_COLUMNS} FROM vault ORDER BY created_at LIMIT 1"),
                [],
                vault_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    /// 写入或覆盖保险库记录。
    pub fn save(&self, vault: &VaultRecord) -> DomainResult<()> {
        ensure_id::<VaultId>(vault.id.as_str())?;
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            tx.execute(
                "INSERT INTO vault(id, name, schema_version, crypto_suite, kdf_alg, kdf_mem_kib, \
                 kdf_time, kdf_parallelism, kdf_salt, wrapped_vault_key, key_check, keychain_ref, \
                 created_at, updated_at, last_opened_at, sync_enabled, server_url, account_id, \
                 quota_bytes) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
                 ?15, ?16, ?17, ?18, ?19) ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
                 schema_version = excluded.schema_version, crypto_suite = excluded.crypto_suite, \
                 kdf_alg = excluded.kdf_alg, kdf_mem_kib = excluded.kdf_mem_kib, \
                 kdf_time = excluded.kdf_time, kdf_parallelism = excluded.kdf_parallelism, \
                 kdf_salt = excluded.kdf_salt, wrapped_vault_key = excluded.wrapped_vault_key, \
                 key_check = excluded.key_check, keychain_ref = excluded.keychain_ref, \
                 created_at = excluded.created_at, updated_at = excluded.updated_at, \
                 last_opened_at = excluded.last_opened_at, sync_enabled = excluded.sync_enabled, \
                 server_url = excluded.server_url, account_id = excluded.account_id, \
                 quota_bytes = excluded.quota_bytes",
                params![
                    vault.id.as_str(),
                    vault.name,
                    vault.schema_version,
                    vault.crypto_suite,
                    vault.kdf_alg,
                    vault.kdf_mem_kib,
                    vault.kdf_time,
                    vault.kdf_parallelism,
                    vault.kdf_salt,
                    vault.wrapped_vault_key,
                    vault.key_check,
                    vault.keychain_ref,
                    vault.created_at,
                    vault.updated_at,
                    vault.last_opened_at,
                    vault.sync_enabled,
                    vault.server_url,
                    vault.account_id,
                    vault.quota_bytes,
                ],
            )
            .map_err(map_sql_error)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }

    /// 更新最近解锁时间。
    pub fn set_last_opened(&self, id: &VaultId, at: i64) -> DomainResult<()> {
        ensure_id::<VaultId>(id.as_str())?;
        self.store.with_conn(|conn| {
            let affected = conn
                .execute(
                    "UPDATE vault SET last_opened_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![at, id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("vault not found"));
            }
            Ok(())
        })
    }

    /// 更新同步配置。
    pub fn set_sync_config(
        &self,
        id: &VaultId,
        enabled: bool,
        server_url: Option<&str>,
        account_id: Option<&str>,
    ) -> DomainResult<()> {
        ensure_id::<VaultId>(id.as_str())?;
        self.store.with_conn(|conn| {
            let affected = conn
                .execute(
                    "UPDATE vault SET sync_enabled = ?1, server_url = ?2, account_id = ?3, \
                     updated_at = ?4 WHERE id = ?5",
                    params![enabled, server_url, account_id, now_ms(), id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("vault not found"));
            }
            Ok(())
        })
    }

    /// 列出所有保险库（首版通常只有一条）。
    pub fn list(&self) -> DomainResult<Vec<VaultRecord>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {VAULT_COLUMNS} FROM vault ORDER BY created_at"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt.query_map([], vault_from_row).map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }
}
