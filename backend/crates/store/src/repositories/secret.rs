//! 加密秘密载荷仓储。仅存储 AEAD 信封，不进行加解密。

use crate::models::{
    bump_sync, ensure_id, map_sql_error, mark_sync_deleted, secret_from_row, SECRET_COLUMNS,
};
use crate::Store;
use openshell_core_domain::{now_ms, DomainError, DomainResult, SecretId, SecretRecord};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

/// 秘密仓储。
pub struct SecretRepo {
    store: Store,
}

impl SecretRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// 写入秘密行（调用方需保证在同一事务内完成引用它的实体写入）。
    pub fn insert(&self, secret: SecretRecord) -> DomainResult<SecretRecord> {
        ensure_id::<SecretId>(secret.id.as_str())?;
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            insert_secret_row(&tx, &secret)?;
            bump_sync(&tx, secret.id.as_str(), "secret", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(secret)
        })
    }

    /// 写入或恢复秘密行。
    ///
    /// 历史版本曾把 `deleted_at` 写成 `0`（表示未删除），导致原有记录既取不到也插不进；
    /// 这里用 UPSERT 覆盖密文并把 `deleted_at` 归零为 NULL，使重复导入可自愈。
    pub fn save_or_restore(&self, secret: SecretRecord) -> DomainResult<SecretRecord> {
        ensure_id::<SecretId>(secret.id.as_str())?;
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            tx.execute(
                "INSERT INTO secret(id, record_type, ciphertext, nonce, aad, crypto_suite, \
                 key_version, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 0, NULL, 1) \
                 ON CONFLICT(id) DO UPDATE SET record_type = excluded.record_type, \
                 ciphertext = excluded.ciphertext, nonce = excluded.nonce, aad = excluded.aad, \
                 crypto_suite = excluded.crypto_suite, key_version = excluded.key_version, \
                 updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1",
                params![
                    secret.id.as_str(),
                    secret.record_type,
                    secret.ciphertext,
                    secret.nonce,
                    secret.aad,
                    secret.crypto_suite,
                    secret.key_version,
                    secret.created_at,
                    secret.updated_at,
                ],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, secret.id.as_str(), "secret", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(secret)
        })
    }

    /// 读取未删除的秘密行。
    ///
    /// 兼容历史数据中 `deleted_at = 0` 表示“未删除”的写法，避免密文存在却取不到。
    pub fn get(&self, id: &SecretId) -> DomainResult<Option<SecretRecord>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SECRET_COLUMNS} FROM secret WHERE id = ?1 \
                     AND (deleted_at IS NULL OR deleted_at = 0)"
                ),
                params![id.as_str()],
                secret_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    /// 恢复被软删除的秘密行（密文仍在，可直接复用）。
    ///
    /// 用于自愈历史状态：私钥/凭据被删除后又恢复，但其密文行仍处于软删除状态。
    /// 返回 `None` 表示该行不存在。
    pub fn restore_if_deleted(&self, id: &SecretId) -> DomainResult<Option<SecretRecord>> {
        ensure_id::<SecretId>(id.as_str())?;
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let row = tx
                .query_row(
                    &format!(
                        "SELECT {SECRET_COLUMNS} FROM secret WHERE id = ?1 AND deleted_at IS NOT NULL"
                    ),
                    params![id.as_str()],
                    secret_from_row,
                )
                .optional()
                .map_err(map_sql_error)?;
            let Some(record) = row else {
                tx.commit().map_err(map_sql_error)?;
                return Ok(None);
            };
            tx.execute(
                "UPDATE secret SET deleted_at = NULL, updated_at = ?1, dirty = 1 WHERE id = ?2",
                params![now_ms(), id.as_str()],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "secret", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(Some(record))
        })
    }

    /// 覆盖密文字段；`key_version` 等信封参数一并更新。
    pub fn update(&self, mut secret: SecretRecord) -> DomainResult<SecretRecord> {
        ensure_id::<SecretId>(secret.id.as_str())?;
        secret.updated_at = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let affected = tx
                .execute(
                    "UPDATE secret SET record_type = ?1, ciphertext = ?2, nonce = ?3, aad = ?4, \
                     crypto_suite = ?5, key_version = ?6, updated_at = ?7, dirty = 1 \
                     WHERE id = ?8 AND (deleted_at IS NULL OR deleted_at = 0)",
                    params![
                        secret.record_type,
                        secret.ciphertext,
                        secret.nonce,
                        secret.aad,
                        secret.crypto_suite,
                        secret.key_version,
                        secret.updated_at,
                        secret.id.as_str(),
                    ],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("secret not found"));
            }
            bump_sync(&tx, secret.id.as_str(), "secret", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(secret)
        })
    }

    /// 软删除秘密行。
    pub fn delete(&self, id: &SecretId) -> DomainResult<()> {
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            soft_delete_secret(&tx, id)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}

/// 事务内插入秘密行，不更新 `sync_record`。
pub(crate) fn insert_secret_row(tx: &Transaction<'_>, secret: &SecretRecord) -> DomainResult<()> {
    tx.execute(
        "INSERT INTO secret(id, record_type, ciphertext, nonce, aad, crypto_suite, key_version, \
         created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 0, NULL, 1)",
        params![
            secret.id.as_str(),
            secret.record_type,
            secret.ciphertext,
            secret.nonce,
            secret.aad,
            secret.crypto_suite,
            secret.key_version,
            secret.created_at,
            secret.updated_at,
        ],
    )
    .map_err(map_sql_error)?;
    Ok(())
}

/// 事务内软删除秘密行并标记同步墓碑。
pub(crate) fn soft_delete_secret(tx: &Transaction<'_>, id: &SecretId) -> DomainResult<()> {
    let now = now_ms();
    let affected = tx
        .execute(
            "UPDATE secret SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
             WHERE id = ?2 AND (deleted_at IS NULL OR deleted_at = 0)",
            params![now, id.as_str()],
        )
        .map_err(map_sql_error)?;
    if affected == 0 {
        return Err(DomainError::not_found("secret not found"));
    }
    mark_sync_deleted(tx, id.as_str(), "secret")?;
    Ok(())
}
