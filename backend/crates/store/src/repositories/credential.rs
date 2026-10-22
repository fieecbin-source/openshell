//! 凭据仓储：元数据与秘密行同事务写入。

use crate::models::{
    bump_sync, credential_from_row, ensure_id, map_sql_error, mark_sync_deleted, save_policy_str,
    CREDENTIAL_COLUMNS,
};
use crate::repositories::secret::{insert_secret_row, soft_delete_secret};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, Credential, CredentialId, CredentialRepository, DomainError, DomainResult,
    SecretMaterial, SecretRecord,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// 凭据仓储。
pub struct CredentialRepo {
    store: Store,
}

impl CredentialRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    fn get_sync(&self, id: &CredentialId) -> DomainResult<Credential> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {CREDENTIAL_COLUMNS} FROM credential WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id.as_str()],
                credential_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("credential not found"))
        })
    }
}

fn validate(cred: &Credential) -> DomainResult<()> {
    if cred.name.is_empty() || cred.name.chars().count() > 128 {
        return Err(DomainError::validation("invalid credential name"));
    }
    Ok(())
}

#[async_trait]
impl CredentialRepository for CredentialRepo {
    async fn list(&self) -> DomainResult<Vec<Credential>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {CREDENTIAL_COLUMNS} FROM credential WHERE deleted_at IS NULL \
                     ORDER BY name COLLATE NOCASE"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map([], credential_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn get(&self, id: &CredentialId) -> DomainResult<Credential> {
        self.get_sync(id)
    }

    async fn create(
        &self,
        cred: Credential,
        secret: SecretRecord,
        _material: SecretMaterial,
    ) -> DomainResult<Credential> {
        ensure_id::<CredentialId>(cred.id.as_str())?;
        ensure_id::<openshell_core_domain::SecretId>(secret.id.as_str())?;
        if cred.secret_id != secret.id {
            return Err(DomainError::validation("credential secret id mismatch"));
        }
        validate(&cred)?;

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            insert_secret_row(&tx, &secret)?;
            tx.execute(
                "INSERT INTO credential(id, name, kind, username, secret_id, hint, save_policy, \
                 expires_at, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, 1)",
                params![
                    cred.id.as_str(),
                    cred.name,
                    cred.kind.as_str(),
                    cred.username,
                    cred.secret_id.as_str(),
                    cred.hint,
                    save_policy_str(cred.save_policy),
                    cred.expires_at,
                    cred.created_at,
                    cred.updated_at,
                    cred.sync.version,
                    cred.sync.origin_device_id,
                ],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, secret.id.as_str(), "secret", None)?;
            bump_sync(&tx, cred.id.as_str(), "credential", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(cred)
        })
    }

    async fn delete(&self, id: &CredentialId) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let secret_id: String = tx
                .query_row(
                    "SELECT secret_id FROM credential WHERE id = ?1 AND deleted_at IS NULL",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("credential not found"))?;

            let references: i64 = tx
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM session WHERE credential_id = ?1 AND deleted_at IS NULL) \
                     + (SELECT COUNT(*) FROM ssh_key WHERE passphrase_credential_id = ?1 AND deleted_at IS NULL)",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .map_err(map_sql_error)?;
            if references > 0 {
                return Err(DomainError::conflict(
                    "credential is still referenced by a session or key",
                ));
            }

            tx.execute(
                "UPDATE credential SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            mark_sync_deleted(&tx, id.as_str(), "credential")?;

            let secret = openshell_core_domain::SecretId::from_string(secret_id)
                .map_err(|_| DomainError::internal("database error"))?;
            soft_delete_secret(&tx, &secret)?;

            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
