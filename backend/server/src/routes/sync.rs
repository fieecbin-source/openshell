use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, AppliedChange, ChangeRecordDto, ChangesPageResponse, CommitRequest,
    CommitResponse, ConflictDetail, RecordHistoryDto, RecordHistoryListResponse,
    RecordVersionDetailResponse, SyncHeadResponse, SyncStatusResponse,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub async fn commit(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, crate::middleware::ApiError> {
    if req.changes.len() > 500 {
        return Err(make_error(
            ApiErrorCode::PayloadTooLarge,
            "Cannot commit more than 500 changes per request",
        ));
    }

    // Check duplicate record_id in changes
    let mut seen_ids = HashSet::new();
    for c in &req.changes {
        if !seen_ids.insert(&c.record_id) {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!("Duplicate record_id in commit: {}", c.record_id),
            ));
        }

        // Verify checksum
        let mut hasher = Sha256::new();
        hasher.update(c.ciphertext_b64.as_bytes());
        let computed = hex_encode(hasher.finalize());
        if !c.deleted && computed != c.checksum {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!("Checksum mismatch for record_id {}", c.record_id),
            ));
        }
    }

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let resp = state.db.with_conn(|conn| -> Result<CommitResponse, crate::middleware::ApiError> {
        let (vault_id, head_seq): (String, i64) = conn.query_row(
            "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found for account"))?;

        let tx = conn.transaction().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut applied = Vec::new();
        let mut conflicts = Vec::new();
        let mut cur_head_seq = head_seq as u64;

        for change in req.changes {
            // Check existing record
            let existing: Option<(u64, String, String, String)> = tx.query_row(
                "SELECT version, ciphertext, checksum, device_id FROM record WHERE vault_id = ?1 AND record_id = ?2",
                rusqlite::params![&vault_id, &change.record_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).ok();

            match (existing, change.base_version) {
                (None, None) | (None, Some(0)) => {
                    // Valid create!
                    cur_head_seq += 1;
                    let item_seq = cur_head_seq;
                    let new_ver = 1u64;
                    let size = change.ciphertext_b64.len();
                    let del_int = if change.deleted { 1 } else { 0 };
                    let del_at = if change.deleted { Some(&now) } else { None };

                    tx.execute(
                        "INSERT INTO record (vault_id, record_id, version, ciphertext, checksum, size, deleted, deleted_at, updated_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        rusqlite::params![&vault_id, &change.record_id, new_ver, &change.ciphertext_b64, &change.checksum, size, del_int, del_at, &now, &user.device_id],
                    ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                    tx.execute(
                        "INSERT INTO record_history (vault_id, record_id, version, seq, ciphertext, checksum, size, deleted, updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?4, NULL)",
                        rusqlite::params![&vault_id, &change.record_id, new_ver, item_seq, &change.ciphertext_b64, &change.checksum, size, del_int, &now, &user.device_id],
                    ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                    applied.push(AppliedChange {
                        record_id: change.record_id,
                        version: new_ver,
                        seq: item_seq,
                    });
                }
                (None, Some(_base_ver)) => {
                    // Record expected to exist, but not found
                    conflicts.push(ConflictDetail {
                        record_id: change.record_id,
                        server_version: 0,
                        server_ciphertext_b64: "".to_string(),
                        server_checksum: "".to_string(),
                        server_device_id: "".to_string(),
                    });
                }
                (Some((srv_ver, srv_cipher, srv_sum, srv_dev)), None) | (Some((srv_ver, srv_cipher, srv_sum, srv_dev)), Some(0)) => {
                    // Both created conflict!
                    conflicts.push(ConflictDetail {
                        record_id: change.record_id,
                        server_version: srv_ver,
                        server_ciphertext_b64: srv_cipher,
                        server_checksum: srv_sum,
                        server_device_id: srv_dev,
                    });
                }
                (Some((srv_ver, srv_cipher, srv_sum, srv_dev)), Some(base_ver)) => {
                    if base_ver == srv_ver {
                        // Optimistic lock match! Valid update
                        cur_head_seq += 1;
                        let item_seq = cur_head_seq;
                        let new_ver = srv_ver + 1;
                        let size = change.ciphertext_b64.len();
                        let del_int = if change.deleted { 1 } else { 0 };
                        let del_at = if change.deleted { Some(&now) } else { None };

                        tx.execute(
                            "UPDATE record SET version = ?1, ciphertext = ?2, checksum = ?3, size = ?4, deleted = ?5, deleted_at = ?6, updated_at = ?7, device_id = ?8 WHERE vault_id = ?9 AND record_id = ?10",
                            rusqlite::params![new_ver, &change.ciphertext_b64, &change.checksum, size, del_int, del_at, &now, &user.device_id, &vault_id, &change.record_id],
                        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                        // Close previous history record
                        let _ = tx.execute(
                            "UPDATE record_history SET valid_to_seq = ?1 WHERE vault_id = ?2 AND record_id = ?3 AND version = ?4",
                            rusqlite::params![item_seq, &vault_id, &change.record_id, srv_ver],
                        );

                        // Insert new history record
                        tx.execute(
                            "INSERT INTO record_history (vault_id, record_id, version, seq, ciphertext, checksum, size, deleted, updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?4, NULL)",
                            rusqlite::params![&vault_id, &change.record_id, new_ver, item_seq, &change.ciphertext_b64, &change.checksum, size, del_int, &now, &user.device_id],
                        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                        applied.push(AppliedChange {
                            record_id: change.record_id,
                            version: new_ver,
                            seq: item_seq,
                        });
                    } else {
                        // Version mismatch conflict!
                        conflicts.push(ConflictDetail {
                            record_id: change.record_id,
                            server_version: srv_ver,
                            server_ciphertext_b64: srv_cipher,
                            server_checksum: srv_sum,
                            server_device_id: srv_dev,
                        });
                    }
                }
            }
        }

        let (final_cursor, final_head) = if !applied.is_empty() {
            // Commit log
            tx.execute(
                "INSERT INTO commit_log (vault_id, seq, device_id, change_count, created_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, 'normal')",
                rusqlite::params![&vault_id, cur_head_seq, &user.device_id, applied.len(), &now],
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            // Update vault head_seq
            tx.execute(
                "UPDATE vault SET head_seq = ?1 WHERE vault_id = ?2",
                rusqlite::params![cur_head_seq, &vault_id],
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            (cur_head_seq, cur_head_seq)
        } else {
            (head_seq as u64, head_seq as u64)
        };

        tx.commit().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok(CommitResponse {
            applied,
            conflicts,
            new_cursor: final_cursor,
            head_seq: final_head,
        })
    })?;

    Ok(Json(resp))
}

#[derive(Debug, Deserialize)]
pub struct ChangesQuery {
    pub cursor: Option<u64>,
    pub limit: Option<usize>,
    pub include_deleted: Option<bool>,
}

pub async fn get_changes(
    user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<ChangesPageResponse>, crate::middleware::ApiError> {
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let include_deleted = query.include_deleted.unwrap_or(true);

    let resp = state.db.with_conn(|conn| -> Result<ChangesPageResponse, crate::middleware::ApiError> {
        let (vault_id, head_seq): (String, i64) = conn.query_row(
            "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let mut sql = "SELECT seq, record_id, version, ciphertext, checksum, size, deleted, updated_at, device_id FROM record_history WHERE vault_id = ?1 AND seq > ?2".to_string();
        if !include_deleted {
            sql.push_str(" AND deleted = 0");
        }
        sql.push_str(" ORDER BY seq ASC, version ASC LIMIT ?3");

        let mut stmt = conn.prepare(&sql).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        let rows = stmt.query_map(rusqlite::params![&vault_id, cursor, (limit + 1) as i64], |row| {
            let del_int: i32 = row.get(6)?;
            let del = del_int != 0;
            let updated_at: String = row.get(7)?;
            Ok(ChangeRecordDto {
                seq: row.get(0)?,
                record_id: row.get(1)?,
                version: row.get(2)?,
                ciphertext_b64: row.get(3)?,
                checksum: row.get(4)?,
                size: row.get(5)?,
                deleted: del,
                deleted_at: if del { Some(updated_at.clone()) } else { None },
                updated_at,
                device_id: row.get(8)?,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut items: Vec<_> = rows.flatten().collect();

        let has_more = items.len() > limit;
        if has_more {
            items.pop();
        }

        let next_cursor = items.last().map(|c| c.seq).unwrap_or(cursor);

        Ok(ChangesPageResponse {
            changes: items,
            next_cursor,
            has_more,
            head_seq: head_seq as u64,
        })
    })?;

    Ok(Json(resp))
}

pub async fn get_sync_head(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<SyncHeadResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(
        |conn| -> Result<SyncHeadResponse, crate::middleware::ApiError> {
            let (vault_id, head_seq): (String, i64) = conn
                .query_row(
                    "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
                    [&user.account_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

            let record_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM record WHERE vault_id = ?1 AND deleted = 0",
                    [&vault_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let bytes_used: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(size), 0) FROM record WHERE vault_id = ?1",
                    [&vault_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let last_commit_at: Option<String> = conn.query_row(
            "SELECT created_at FROM commit_log WHERE vault_id = ?1 ORDER BY seq DESC LIMIT 1",
            [&vault_id],
            |r| r.get(0),
        ).ok();

            Ok(SyncHeadResponse {
                head_seq: head_seq as u64,
                record_count: record_count as u64,
                bytes_used: bytes_used as u64,
                last_commit_at,
            })
        },
    )?;

    Ok(Json(resp))
}

pub async fn get_sync_status(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<SyncStatusResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(
        |conn| -> Result<SyncStatusResponse, crate::middleware::ApiError> {
            let (vault_id, head_seq): (String, i64) = conn
                .query_row(
                    "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
                    [&user.account_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

            let record_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM record WHERE vault_id = ?1 AND deleted = 0",
                    [&vault_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let bytes_used: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(size), 0) FROM record WHERE vault_id = ?1",
                    [&vault_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let snp_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM snapshot WHERE vault_id = ?1",
                    [&vault_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(SyncStatusResponse {
                head_seq: head_seq as u64,
                record_count: record_count as u64,
                bytes_used: bytes_used as u64,
                quota: 512 * 1024 * 1024,
                conflict_retention_days: 90,
                snapshot_count: snp_count as u64,
            })
        },
    )?;

    Ok(Json(resp))
}

pub async fn get_record_history(
    user: AuthUser,
    State(state): State<AppState>,
    Path(record_id): Path<String>,
) -> Result<Json<RecordHistoryListResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<RecordHistoryListResponse, crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let mut stmt = conn.prepare(
            "SELECT version, seq, checksum, size, deleted, updated_at, device_id FROM record_history WHERE vault_id = ?1 AND record_id = ?2 ORDER BY version DESC LIMIT 50",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map(rusqlite::params![&vault_id, &record_id], |row| {
            let del_int: i32 = row.get(4)?;
            Ok(RecordHistoryDto {
                version: row.get(0)?,
                seq: row.get(1)?,
                checksum: row.get(2)?,
                size: row.get(3)?,
                deleted: del_int != 0,
                updated_at: row.get(5)?,
                device_id: row.get(6)?,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let versions: Vec<_> = rows.flatten().collect();

        if versions.is_empty() {
            return Err(make_error(ApiErrorCode::NotFound, "Record not found"));
        }

        Ok(RecordHistoryListResponse {
            versions,
            has_more: false,
        })
    })?;

    Ok(Json(resp))
}

pub async fn get_record_history_version(
    user: AuthUser,
    State(state): State<AppState>,
    Path((record_id, version)): Path<(String, u64)>,
) -> Result<Json<RecordVersionDetailResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<RecordVersionDetailResponse, crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let mut stmt = conn.prepare(
            "SELECT ciphertext, checksum, deleted, updated_at FROM record_history WHERE vault_id = ?1 AND record_id = ?2 AND version = ?3",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut rows = stmt.query(rusqlite::params![&vault_id, &record_id, version])
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        if let Ok(Some(row)) = rows.next() {
            let del_int: i32 = row.get(2)?;
            Ok(RecordVersionDetailResponse {
                record_id,
                version,
                ciphertext_b64: row.get(0)?,
                checksum: row.get(1)?,
                deleted: del_int != 0,
                updated_at: row.get(3)?,
            })
        } else {
            Err(make_error(ApiErrorCode::NotFound, "Version not found"))
        }
    })?;

    Ok(Json(resp))
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    let mut s = String::with_capacity(bytes.as_ref().len() * 2);
    for b in bytes.as_ref() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}
