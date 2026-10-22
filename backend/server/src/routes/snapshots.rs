use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, CreateSnapshotRequest, RollbackRequest, RollbackResponse, SnapshotDetailResponse,
    SnapshotHeaderDto, SnapshotListResponse, SnapshotRecordDto,
};
use ulid::Ulid;

const MAX_SNAPSHOTS_PER_VAULT: u64 = 20;

pub async fn create_snapshot(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateSnapshotRequest>,
) -> Result<Response, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let (is_new, snap_header) = state.db.with_conn(|conn| -> Result<(bool, SnapshotHeaderDto), crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        // Check quota
        let current_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snapshot WHERE vault_id = ?1",
            [&vault_id],
            |r| r.get(0),
        ).unwrap_or(0);

        // Check if existing snapshot with this id
        let existing: Option<(String, String)> = conn.query_row(
            "SELECT manifest_checksum, created_at FROM snapshot WHERE snapshot_id = ?1",
            [&req.snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();

        if let Some((checksum, created_at)) = existing {
            if checksum == req.manifest.checksum {
                return Ok((false, SnapshotHeaderDto {
                    snapshot_id: req.snapshot_id,
                    label: req.label,
                    record_count: req.manifest.record_count,
                    bytes: req.manifest.bytes,
                    created_at,
                    device_id: user.device_id,
                }));
            } else {
                return Err(make_error(ApiErrorCode::SnapshotExists, "Snapshot ID exists with different checksum"));
            }
        }

        if current_count as u64 >= MAX_SNAPSHOTS_PER_VAULT {
            return Err(make_error(ApiErrorCode::QuotaExceeded, "Snapshot limit reached (max 20)"));
        }

        let tx = conn.transaction().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        tx.execute(
            "INSERT INTO snapshot (snapshot_id, vault_id, label, record_count, bytes, manifest_checksum, created_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![&req.snapshot_id, &vault_id, &req.label, req.manifest.record_count, req.manifest.bytes, &req.manifest.checksum, &now, &user.device_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        for rec in req.records {
            let del_int = if rec.deleted { 1 } else { 0 };
            tx.execute(
                "INSERT INTO snapshot_record (snapshot_id, record_id, ciphertext, checksum, deleted) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![&req.snapshot_id, &rec.record_id, &rec.ciphertext_b64, &rec.checksum, del_int],
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        }

        tx.commit().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok((true, SnapshotHeaderDto {
            snapshot_id: req.snapshot_id,
            label: req.label,
            record_count: req.manifest.record_count,
            bytes: req.manifest.bytes,
            created_at: now,
            device_id: user.device_id,
        }))
    })?;

    let status = if is_new {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(snap_header)).into_response())
}

pub async fn list_snapshots(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<SnapshotListResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<SnapshotListResponse, crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let mut stmt = conn.prepare(
            "SELECT snapshot_id, label, record_count, bytes, created_at, device_id FROM snapshot WHERE vault_id = ?1 ORDER BY created_at DESC",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map([&vault_id], |row| {
            Ok(SnapshotHeaderDto {
                snapshot_id: row.get(0)?,
                label: row.get(1)?,
                record_count: row.get(2)?,
                bytes: row.get(3)?,
                created_at: row.get(4)?,
                device_id: row.get(5)?,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let snapshots: Vec<_> = rows.flatten().collect();

        Ok(SnapshotListResponse {
            snapshots,
            has_more: false,
        })
    })?;

    Ok(Json(resp))
}

pub async fn get_snapshot(
    user: AuthUser,
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
) -> Result<Json<SnapshotDetailResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<SnapshotDetailResponse, crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let header = conn.query_row(
            "SELECT snapshot_id, label, record_count, bytes, created_at, device_id FROM snapshot WHERE snapshot_id = ?1 AND vault_id = ?2",
            rusqlite::params![&snapshot_id, &vault_id],
            |row| Ok(SnapshotHeaderDto {
                snapshot_id: row.get(0)?,
                label: row.get(1)?,
                record_count: row.get(2)?,
                bytes: row.get(3)?,
                created_at: row.get(4)?,
                device_id: row.get(5)?,
            }),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Snapshot not found"))?;

        let mut stmt = conn.prepare(
            "SELECT record_id, ciphertext, checksum, deleted FROM snapshot_record WHERE snapshot_id = ?1",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map([&snapshot_id], |row| {
            let del_int: i32 = row.get(3)?;
            Ok(SnapshotRecordDto {
                record_id: row.get(0)?,
                ciphertext_b64: row.get(1)?,
                checksum: row.get(2)?,
                deleted: del_int != 0,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let records: Vec<_> = rows.flatten().collect();

        Ok(SnapshotDetailResponse { header, records })
    })?;

    Ok(Json(resp))
}

pub async fn delete_snapshot(
    user: AuthUser,
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    state
        .db
        .with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
            let vault_id: String = conn
                .query_row(
                    "SELECT vault_id FROM vault WHERE account_id = ?1",
                    [&user.account_id],
                    |r| r.get(0),
                )
                .map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

            let tx = conn
                .transaction()
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            let deleted = tx
                .execute(
                    "DELETE FROM snapshot WHERE snapshot_id = ?1 AND vault_id = ?2",
                    rusqlite::params![&snapshot_id, &vault_id],
                )
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            if deleted == 0 {
                return Err(make_error(ApiErrorCode::NotFound, "Snapshot not found"));
            }

            let _ = tx.execute(
                "DELETE FROM snapshot_record WHERE snapshot_id = ?1",
                [&snapshot_id],
            );

            tx.commit()
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            Ok(())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn rollback(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<RollbackRequest>,
) -> Result<(StatusCode, Json<RollbackResponse>), crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let resp = state.db.with_conn(|conn| -> Result<RollbackResponse, crate::middleware::ApiError> {
        let (vault_id, head_seq): (String, i64) = conn.query_row(
            "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        // 1. Validate expected_head_seq
        if (head_seq as u64) != req.expected_head_seq {
            return Err(make_error(
                ApiErrorCode::VersionConflict,
                format!("Expected head seq {} does not match current {}", req.expected_head_seq, head_seq),
            ));
        }

        let tx = conn.transaction().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // 2. Optional pre-restore snapshot
        let mut pre_restore_id = None;
        if req.create_pre_restore_snapshot {
            let pid = Ulid::new().to_string();
            let label = format!("Pre-restore rollback auto-snapshot {}", &pid[..8]);

            // Read current records
            let (rec_count, total_bytes, rec_list) = {
                let mut cur_stmt = tx.prepare(
                    "SELECT record_id, ciphertext, checksum, deleted FROM record WHERE vault_id = ?1",
                ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                let cur_rows = cur_stmt
                    .query_map([&vault_id], |r| {
                        let record_id: String = r.get(0)?;
                        let ciphertext: String = r.get(1)?;
                        let checksum: String = r.get(2)?;
                        let del_int: i32 = r.get(3)?;
                        Ok((record_id, ciphertext, checksum, del_int))
                    })
                    .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                let mut count = 0u64;
                let mut bytes = 0u64;
                let mut list = Vec::new();
                for (rid, cipher, csum, del_int) in cur_rows.flatten() {
                    count += 1;
                    bytes += cipher.len() as u64;
                    list.push((rid, cipher, csum, del_int));
                }
                (count, bytes, list)
            };

            tx.execute(
                "INSERT INTO snapshot (snapshot_id, vault_id, label, record_count, bytes, manifest_checksum, created_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, 'auto_checksum', ?6, ?7)",
                rusqlite::params![&pid, &vault_id, &label, rec_count, total_bytes, &now, &user.device_id],
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            for (rid, cipher, csum, del_int) in rec_list {
                tx.execute(
                    "INSERT INTO snapshot_record (snapshot_id, record_id, ciphertext, checksum, deleted) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![&pid, &rid, &cipher, &csum, del_int],
                ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            }

            pre_restore_id = Some(pid);
        }

        // 3. Read target snapshot records
        let (snapshot_records, snapshot_ids) = {
            let mut snap_stmt = tx.prepare(
                "SELECT record_id, ciphertext, checksum, deleted FROM snapshot_record WHERE snapshot_id = ?1",
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let snap_rows = snap_stmt.query_map([&req.snapshot_id], |r| {
                let del_int: i32 = r.get(3)?;
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, del_int != 0))
            }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let mut records = Vec::new();
            let mut ids = std::collections::HashSet::new();
            for rec in snap_rows.flatten() {
                ids.insert(rec.0.clone());
                records.push(rec);
            }
            (records, ids)
        };

        if snapshot_records.is_empty() {
            return Err(make_error(ApiErrorCode::NotFound, "Target snapshot has no records or does not exist"));
        }

        let new_seq = (head_seq + 1) as u64;
        let mut restored = 0u64;
        let mut deleted_count = 0u64;

        // Apply snapshot records
        for (rid, cipher, csum, is_del) in snapshot_records {
            let existing: Option<(u64, String, bool)> = tx.query_row(
                "SELECT version, ciphertext, deleted FROM record WHERE vault_id = ?1 AND record_id = ?2",
                rusqlite::params![&vault_id, &rid],
                |r| {
                    let del: i32 = r.get(2)?;
                    Ok((r.get(0)?, r.get(1)?, del != 0))
                },
            ).ok();

            let del_int = if is_del { 1 } else { 0 };
            let size = cipher.len();

            match existing {
                None => {
                    // Create with version 1
                    tx.execute(
                        "INSERT INTO record (vault_id, record_id, version, ciphertext, checksum, size, deleted, deleted_at, updated_at, device_id) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        rusqlite::params![&vault_id, &rid, &cipher, &csum, size, del_int, if is_del { Some(&now) } else { None }, &now, &user.device_id],
                    ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                    tx.execute(
                        "INSERT INTO record_history (vault_id, record_id, version, seq, ciphertext, checksum, size, deleted, updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?3, NULL)",
                        rusqlite::params![&vault_id, &rid, new_seq, &cipher, &csum, size, del_int, &now, &user.device_id],
                    ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
                    restored += 1;
                }
                Some((cur_ver, cur_cipher, cur_del)) => {
                    if cur_cipher != cipher || cur_del != is_del {
                        let new_ver = cur_ver + 1;
                        tx.execute(
                            "UPDATE record SET version = ?1, ciphertext = ?2, checksum = ?3, size = ?4, deleted = ?5, deleted_at = ?6, updated_at = ?7, device_id = ?8 WHERE vault_id = ?9 AND record_id = ?10",
                            rusqlite::params![new_ver, &cipher, &csum, size, del_int, if is_del { Some(&now) } else { None }, &now, &user.device_id, &vault_id, &rid],
                        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                        tx.execute(
                            "INSERT INTO record_history (vault_id, record_id, version, seq, ciphertext, checksum, size, deleted, updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?4, NULL)",
                            rusqlite::params![&vault_id, &rid, new_ver, new_seq, &cipher, &csum, size, del_int, &now, &user.device_id],
                        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
                        restored += 1;
                    }
                }
            }
        }

        // For records currently active in record table but not in snapshot: mark deleted (tombstone)
        let cur_all: Vec<(String, u64)> = {
            let mut cur_all_stmt = tx.prepare(
                "SELECT record_id, version FROM record WHERE vault_id = ?1 AND deleted = 0",
            ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let rows = cur_all_stmt.query_map([&vault_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            rows.flatten().collect()
        };

        for (rid, cur_ver) in cur_all {
            if !snapshot_ids.contains(&rid) {
                let new_ver = cur_ver + 1;
                tx.execute(
                    "UPDATE record SET version = ?1, deleted = 1, deleted_at = ?2, updated_at = ?2, device_id = ?3 WHERE vault_id = ?4 AND record_id = ?5",
                    rusqlite::params![new_ver, &now, &user.device_id, &vault_id, &rid],
                ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

                tx.execute(
                    "INSERT INTO record_history (vault_id, record_id, version, seq, ciphertext, checksum, size, deleted, updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, '', '', 0, 1, ?5, ?6, ?4, NULL)",
                    rusqlite::params![&vault_id, &rid, new_ver, new_seq, &now, &user.device_id],
                ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
                deleted_count += 1;
            }
        }

        // Commit log with kind = 'snapshot_restore'
        tx.execute(
            "INSERT INTO commit_log (vault_id, seq, device_id, change_count, created_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, 'snapshot_restore')",
            rusqlite::params![&vault_id, new_seq, &user.device_id, (restored + deleted_count), &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        tx.execute(
            "UPDATE vault SET head_seq = ?1 WHERE vault_id = ?2",
            rusqlite::params![new_seq, &vault_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        tx.commit().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok(RollbackResponse {
            new_head_seq: new_seq,
            restored_records: restored,
            deleted_records: deleted_count,
            pre_restore_snapshot_id: pre_restore_id,
        })
    })?;

    Ok((StatusCode::ACCEPTED, Json(resp)))
}
