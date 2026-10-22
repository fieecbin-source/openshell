//! 已知主机仓储（主机密钥信任库）。

use crate::models::{
    bump_sync, ensure_id, known_host_from_row, map_sql_error, mark_sync_deleted, KNOWN_HOST_COLUMNS,
};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, DomainError, DomainResult, KnownHost, KnownHostId, KnownHostRepository,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// 已知主机仓储。
pub struct KnownHostRepo {
    store: Store,
}

impl KnownHostRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }
}

fn validate(host: &KnownHost) -> DomainResult<()> {
    if host.host.is_empty() || host.key_type.is_empty() || host.fingerprint_sha256.is_empty() {
        return Err(DomainError::validation("invalid known host record"));
    }
    Ok(())
}

#[async_trait]
impl KnownHostRepository for KnownHostRepo {
    async fn find(&self, host: &str, port: u16, key_type: &str) -> DomainResult<Option<KnownHost>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {KNOWN_HOST_COLUMNS} FROM known_host \
                     WHERE host = ?1 AND port = ?2 AND key_type = ?3 AND deleted_at IS NULL"
                ),
                params![host, i64::from(port), key_type],
                known_host_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    async fn upsert_trusted(&self, host: KnownHost) -> DomainResult<KnownHost> {
        ensure_id::<KnownHostId>(host.id.as_str())?;
        validate(&host)?;
        let now = now_ms();

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let existing: Option<(String, Option<i64>)> = tx
                .query_row(
                    "SELECT id, deleted_at FROM known_host WHERE host = ?1 AND port = ?2 AND key_type = ?3",
                    params![host.host, i64::from(host.port), host.key_type],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(map_sql_error)?;

            let record_id = match existing {
                Some((id, _)) => {
                    tx.execute(
                        "UPDATE known_host SET public_key = ?1, fingerprint_sha256 = ?2, \
                         status = 'trusted', previous_fingerprint = NULL, changed_at = NULL, \
                         last_seen_at = ?3, source = ?4, updated_at = ?3, deleted_at = NULL, dirty = 1 \
                         WHERE id = ?5",
                        params![
                            host.public_key,
                            host.fingerprint_sha256,
                            now,
                            host.source,
                            id,
                        ],
                    )
                    .map_err(map_sql_error)?;
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO known_host(id, host, port, key_type, public_key, \
                         fingerprint_sha256, status, previous_fingerprint, first_seen_at, last_seen_at, \
                         changed_at, source, created_at, updated_at, deleted_at, version, \
                         origin_device_id, dirty) \
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'trusted', NULL, ?7, ?8, NULL, ?9, ?10, \
                         ?11, NULL, 0, NULL, 1)",
                        params![
                            host.id.as_str(),
                            host.host,
                            i64::from(host.port),
                            host.key_type,
                            host.public_key,
                            host.fingerprint_sha256,
                            host.first_seen_at,
                            now,
                            host.source,
                            host.created_at,
                            now,
                        ],
                    )
                    .map_err(map_sql_error)?;
                    host.id.as_str().to_string()
                }
            };

            bump_sync(&tx, &record_id, "known_host", None)?;
            let saved = tx
                .query_row(
                    &format!("SELECT {KNOWN_HOST_COLUMNS} FROM known_host WHERE id = ?1"),
                    params![record_id],
                    known_host_from_row,
                )
                .map_err(map_sql_error)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(saved)
        })
    }

    async fn mark_changed(&self, id: &KnownHostId, new_fingerprint: &str) -> DomainResult<()> {
        if new_fingerprint.is_empty() {
            return Err(DomainError::validation("invalid fingerprint"));
        }
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let current: Option<String> = tx
                .query_row(
                    "SELECT fingerprint_sha256 FROM known_host WHERE id = ?1 AND deleted_at IS NULL",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_error)?;
            let Some(previous) = current else {
                return Err(DomainError::not_found("known host not found"));
            };

            tx.execute(
                "UPDATE known_host SET status = 'changed', previous_fingerprint = ?1, \
                 fingerprint_sha256 = ?2, changed_at = ?3, updated_at = ?3, dirty = 1 \
                 WHERE id = ?4 AND deleted_at IS NULL",
                params![previous, new_fingerprint, now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "known_host", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }

    async fn list(&self) -> DomainResult<Vec<KnownHost>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {KNOWN_HOST_COLUMNS} FROM known_host WHERE deleted_at IS NULL \
                     ORDER BY host, port, key_type"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map([], known_host_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn delete(&self, id: &KnownHostId) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let affected = tx
                .execute(
                    "UPDATE known_host SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
                     WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("known host not found"));
            }
            mark_sync_deleted(&tx, id.as_str(), "known_host")?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
