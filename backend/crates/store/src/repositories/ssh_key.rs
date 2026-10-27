//! SSH 密钥仓储：公钥元数据与私钥秘密行同事务写入。

use crate::models::{
    bump_sync, ensure_id, map_sql_error, mark_sync_deleted, ssh_key_from_row, SSH_KEY_COLUMNS,
};
use crate::repositories::secret::{insert_secret_row, soft_delete_secret};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, CredentialId, DomainError, DomainResult, SecretId, SecretMaterial, SecretRecord,
    SshKey, SshKeyId, SshKeyRepository,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// SSH 密钥仓储。
pub struct SshKeyRepo {
    store: Store,
}

impl SshKeyRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    fn get_sync(&self, id: &SshKeyId) -> DomainResult<SshKey> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SSH_KEY_COLUMNS} FROM ssh_key WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id.as_str()],
                ssh_key_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("ssh key not found"))
        })
    }
}

fn validate(key: &SshKey) -> DomainResult<()> {
    if key.name.is_empty() || key.name.chars().count() > 128 {
        return Err(DomainError::validation("invalid ssh key name"));
    }
    if key.public_key.is_empty() || key.fingerprint_sha256.is_empty() {
        return Err(DomainError::validation("invalid ssh key material"));
    }
    Ok(())
}

#[async_trait]
impl SshKeyRepository for SshKeyRepo {
    async fn list(&self) -> DomainResult<Vec<SshKey>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SSH_KEY_COLUMNS} FROM ssh_key WHERE deleted_at IS NULL \
                     ORDER BY name COLLATE NOCASE"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map([], ssh_key_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn get(&self, id: &SshKeyId) -> DomainResult<SshKey> {
        self.get_sync(id)
    }

    async fn create(
        &self,
        key: SshKey,
        secret: SecretRecord,
        _material: SecretMaterial,
    ) -> DomainResult<SshKey> {
        ensure_id::<SshKeyId>(key.id.as_str())?;
        ensure_id::<SecretId>(secret.id.as_str())?;
        if key.secret_id != secret.id {
            return Err(DomainError::validation("ssh key secret id mismatch"));
        }
        validate(&key)?;

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            insert_secret_row(&tx, &secret)?;
            tx.execute(
                "INSERT INTO ssh_key(id, name, algorithm, key_size, public_key, fingerprint_sha256, \
                 secret_id, passphrase_credential_id, has_passphrase, comment, created_at, updated_at, \
                 deleted_at, version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14, 1)",
                params![
                    key.id.as_str(),
                    key.name,
                    key.algorithm,
                    key.key_size,
                    key.public_key,
                    key.fingerprint_sha256,
                    key.secret_id.as_str(),
                    key.passphrase_credential_id.as_ref().map(|c| c.as_str()),
                    key.has_passphrase,
                    key.comment,
                    key.created_at,
                    key.updated_at,
                    key.sync.version,
                    key.sync.origin_device_id,
                ],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, secret.id.as_str(), "secret", None)?;
            bump_sync(&tx, key.id.as_str(), "ssh_key", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(key)
        })
    }

    async fn find_by_fingerprint(&self, fingerprint: &str) -> DomainResult<Option<SshKey>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SSH_KEY_COLUMNS} FROM ssh_key WHERE fingerprint_sha256 = ?1 \
                     ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1"
                ),
                params![fingerprint],
                ssh_key_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    async fn update_passphrase(
        &self,
        id: &SshKeyId,
        credential_id: Option<&CredentialId>,
        has_passphrase: bool,
    ) -> DomainResult<SshKey> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE ssh_key SET passphrase_credential_id = ?1, has_passphrase = ?2, \
                 updated_at = ?3, dirty = 1 WHERE id = ?4 AND deleted_at IS NULL",
                params![
                    credential_id.map(|c| c.as_str()),
                    if has_passphrase { 1 } else { 0 },
                    now,
                    id.as_str(),
                ],
            )
            .map_err(map_sql_error)?;
            Ok(())
        })?;
        self.get_sync(id)
    }

    async fn restore(&self, id: &SshKeyId, name: &str) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE ssh_key SET deleted_at = NULL, name = ?1, updated_at = ?2, dirty = 1 \
                 WHERE id = ?3",
                params![name, now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            Ok(())
        })
    }

    async fn delete(&self, id: &SshKeyId) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let secret_id: String = tx
                .query_row(
                    "SELECT secret_id FROM ssh_key WHERE id = ?1 AND deleted_at IS NULL",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("ssh key not found"))?;

            // 自动解除关联会话的绑定引用（删除的是配置记录，不影响本地物理文件）
            tx.execute(
                "UPDATE session SET ssh_key_id = NULL, updated_at = ?1, dirty = 1 \
                 WHERE ssh_key_id = ?2 AND deleted_at IS NULL",
                params![now, id.as_str()],
            )
            .map_err(map_sql_error)?;

            tx.execute(
                "UPDATE ssh_key SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            mark_sync_deleted(&tx, id.as_str(), "ssh_key")?;

            let secret = SecretId::from_string(secret_id)
                .map_err(|_| DomainError::internal("database error"))?;
            soft_delete_secret(&tx, &secret)?;

            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
