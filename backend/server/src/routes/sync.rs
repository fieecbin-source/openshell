use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, AppliedChange, AppliedChangeV2, ChangeRecordDto, ChangeRecordV2,
    ChangesPageResponse, ChangesPageResponseV2, CommitRequest, CommitRequestV2, CommitResponse,
    CommitResponseV2, ConflictDetail, ConflictDetailV2, RecordHistoryDto,
    RecordHistoryListResponse, RecordVersionDetailResponse, SyncHeadResponse, SyncStatusResponse,
    HEADER_IDEMPOTENCY_KEY, SYNC_SCHEMA_VERSION_V2,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_SYNC_CIPHERTEXT_BYTES: usize = 8 * 1024 * 1024;
const IDEMPOTENCY_TTL_SECONDS: i64 = 24 * 60 * 60;

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
    if req
        .base_cursor
        .is_some_and(|cursor| cursor > i64::MAX as u64)
    {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            "base_cursor is out of range",
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
        if req
            .base_cursor
            .is_some_and(|cursor| cursor > cur_head_seq)
        {
            return Err(make_error(
                ApiErrorCode::SyncConflict,
                "base_cursor is ahead of the server head",
            ));
        }

        for change in req.changes {
            let existing_schema: Option<u32> = tx
                .query_row(
                    "SELECT schema_version FROM record WHERE vault_id = ?1 AND record_id = ?2",
                    rusqlite::params![&vault_id, &change.record_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            if existing_schema.is_some_and(|version| version >= SYNC_SCHEMA_VERSION_V2) {
                return Err(make_error(
                    ApiErrorCode::UpgradeRequired,
                    format!(
                        "Record {} requires the v2 sync endpoint",
                        change.record_id
                    ),
                ));
            }
            // Check existing record
            let existing: Option<(u64, String, String, String)> = tx.query_row(
                "SELECT version, ciphertext, checksum, device_id FROM record WHERE vault_id = ?1 AND record_id = ?2",
                rusqlite::params![&vault_id, &change.record_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;

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

pub async fn commit_v2(
    user: AuthUser,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CommitRequestV2>,
) -> Result<Json<CommitResponseV2>, crate::middleware::ApiError> {
    let idempotency_key = headers
        .get(HEADER_IDEMPOTENCY_KEY)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            make_error(
                ApiErrorCode::InvalidRequest,
                "Missing or invalid Idempotency-Key header",
            )
        })?
        .to_string();
    let request_hash = hash_json(&req)?;

    if req.schema_version != SYNC_SCHEMA_VERSION_V2 {
        return Err(make_error(
            ApiErrorCode::UpgradeRequired,
            format!(
                "Unsupported sync schema version {}; server supports {}",
                req.schema_version, SYNC_SCHEMA_VERSION_V2
            ),
        ));
    }
    if req.changes.len() > 500 {
        return Err(make_error(
            ApiErrorCode::PayloadTooLarge,
            "Cannot commit more than 500 changes per request",
        ));
    }
    if req
        .base_cursor
        .is_some_and(|cursor| cursor > i64::MAX as u64)
    {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            "base_cursor is out of range",
        ));
    }

    let mut seen_ids = HashSet::new();
    for change in &req.changes {
        if !seen_ids.insert(&change.record_id) {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!("Duplicate record_id in commit: {}", change.record_id),
            ));
        }
        if change.record_id.is_empty()
            || change.record_type.is_empty()
            || change.updated_at.is_empty()
            || change.key_version == 0
            || change.revision == 0
        {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                "v2 record metadata is incomplete",
            ));
        }
        if change.ciphertext_b64.len() > MAX_SYNC_CIPHERTEXT_BYTES {
            return Err(make_error(
                ApiErrorCode::PayloadTooLarge,
                format!(
                    "Record {} exceeds the 8 MiB ciphertext limit",
                    change.record_id
                ),
            ));
        }
        if change.key_version > i64::MAX as u64
            || change.revision > i64::MAX as u64
            || change
                .base_revision
                .is_some_and(|revision| revision > i64::MAX as u64)
        {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!(
                    "Record {} revision metadata is out of range",
                    change.record_id
                ),
            ));
        }
        if time::OffsetDateTime::parse(
            &change.updated_at,
            &time::format_description::well_known::Rfc3339,
        )
        .is_err()
        {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!(
                    "Record {} has an invalid updated_at timestamp",
                    change.record_id
                ),
            ));
        }
        if change.schema_version != SYNC_SCHEMA_VERSION_V2 {
            return Err(make_error(
                ApiErrorCode::UpgradeRequired,
                format!(
                    "Record {} uses unsupported schema version {}",
                    change.record_id, change.schema_version
                ),
            ));
        }
        if change.device_id != user.device_id {
            return Err(make_error(
                ApiErrorCode::DeviceMismatch,
                format!("Record {} belongs to another device", change.record_id),
            ));
        }

        let mut hasher = Sha256::new();
        hasher.update(change.ciphertext_b64.as_bytes());
        let computed = hex_encode(hasher.finalize());
        if !change.deleted && computed != change.checksum {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!("Checksum mismatch for record_id {}", change.record_id),
            ));
        }
        if change.deleted
            && (!change.ciphertext_b64.is_empty() || !change.checksum.is_empty())
            && computed != change.checksum
        {
            return Err(make_error(
                ApiErrorCode::ValidationFailed,
                format!(
                    "Checksum mismatch for tombstone record_id {}",
                    change.record_id
                ),
            ));
        }
    }

    let server_now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let response = state.db.with_conn(
        |conn| -> Result<CommitResponseV2, crate::middleware::ApiError> {
            let tx = conn
                .transaction()
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            let now_epoch = time::OffsetDateTime::now_utc().unix_timestamp();
            let cached: Option<(String, String, i64)> = tx
                .query_row(
                    "SELECT request_hash, response_json, expires_at FROM idempotency_key WHERE account_id = ?1 AND method = 'POST' AND path = '/v2/sync/commit' AND key = ?2",
                    rusqlite::params![&user.account_id, &idempotency_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;

            if let Some((cached_hash, response_json, expires_at)) = cached {
                if expires_at > now_epoch {
                    if cached_hash != request_hash {
                        return Err(make_error(
                            ApiErrorCode::IdempotencyKeyReused,
                            "Idempotency-Key was already used with a different request body",
                        ));
                    }
                    let response = serde_json::from_str(&response_json).map_err(|error| {
                        make_error(ApiErrorCode::Internal, error.to_string())
                    })?;
                    tx.commit().map_err(|error| {
                        make_error(ApiErrorCode::Internal, error.to_string())
                    })?;
                    return Ok(response);
                }
                tx.execute(
                    "DELETE FROM idempotency_key WHERE account_id = ?1 AND method = 'POST' AND path = '/v2/sync/commit' AND key = ?2",
                    rusqlite::params![&user.account_id, &idempotency_key],
                )
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            }

            let (vault_id, head_seq): (String, i64) = tx
                .query_row(
                    "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
                    [&user.account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found for account"))?;
            if req
                .base_cursor
                .is_some_and(|cursor| cursor > head_seq as u64)
            {
                return Err(make_error(
                    ApiErrorCode::SyncConflict,
                    "base_cursor is ahead of the server head",
                ));
            }
            let mut applied = Vec::new();
            let mut conflicts = Vec::new();
            let mut current_head = head_seq as u64;

            for change in req.changes {
                type ExistingRecordRow = (
                    u64,
                    String,
                    u32,
                    u64,
                    String,
                    String,
                    bool,
                    Option<String>,
                    String,
                    String,
                );
                let existing: Option<ExistingRecordRow> = tx
                    .query_row(
                        "SELECT revision, record_type, schema_version, key_version, ciphertext, checksum, deleted, deleted_at, device_id, client_updated_at FROM record WHERE vault_id = ?1 AND record_id = ?2",
                        rusqlite::params![&vault_id, &change.record_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get::<_, i64>(6)? != 0,
                                row.get(7)?,
                                row.get(8)?,
                                row.get(9)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;

                match (existing, change.base_revision) {
                    (None, None) | (None, Some(0)) => {
                        if change.revision != 1 {
                            return Err(make_error(
                                ApiErrorCode::ValidationFailed,
                                format!(
                                    "New record {} must start at revision 1",
                                    change.record_id
                                ),
                            ));
                        }
                        current_head += 1;
                        let deleted = if change.deleted { 1 } else { 0 };
                        let deleted_at = change.deleted.then_some(server_now.as_str());
                        let size = change.ciphertext_b64.len();

                        tx.execute(
                            "INSERT INTO record (vault_id, record_id, record_type, schema_version, key_version, version, revision, ciphertext, checksum, size, deleted, deleted_at, updated_at, client_updated_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                            rusqlite::params![
                                &vault_id,
                                &change.record_id,
                                &change.record_type,
                                change.schema_version,
                                change.key_version,
                                change.revision,
                                &change.ciphertext_b64,
                                &change.checksum,
                                size,
                                deleted,
                                deleted_at,
                                &server_now,
                                &change.updated_at,
                                &user.device_id,
                            ],
                        )
                        .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                        tx.execute(
                            "INSERT INTO record_history (vault_id, record_id, record_type, schema_version, key_version, version, revision, seq, ciphertext, checksum, size, deleted, updated_at, client_updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?7, NULL)",
                            rusqlite::params![
                                &vault_id,
                                &change.record_id,
                                &change.record_type,
                                change.schema_version,
                                change.key_version,
                                change.revision,
                                current_head,
                                &change.ciphertext_b64,
                                &change.checksum,
                                size,
                                deleted,
                                &server_now,
                                &change.updated_at,
                                &user.device_id,
                            ],
                        )
                        .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                        applied.push(AppliedChangeV2 {
                            record_id: change.record_id,
                            revision: change.revision,
                            seq: current_head,
                        });
                    }
                    (None, Some(_)) => conflicts.push(ConflictDetailV2 {
                        record_id: change.record_id,
                        server_record_type: String::new(),
                        server_schema_version: 0,
                        server_key_version: 0,
                        server_revision: 0,
                        server_ciphertext_b64: String::new(),
                        server_checksum: String::new(),
                        server_deleted: false,
                        server_deleted_at: None,
                        server_device_id: String::new(),
                        server_updated_at: String::new(),
                    }),
                    (
                        Some((
                            server_revision,
                            server_record_type,
                            server_schema_version,
                            server_key_version,
                            server_ciphertext,
                            server_checksum,
                            server_deleted,
                            server_deleted_at,
                            server_device_id,
                            server_updated_at,
                        )),
                        base_revision,
                    ) => {
                        if base_revision == Some(server_revision) {
                            if change.revision != server_revision + 1 {
                                return Err(make_error(
                                    ApiErrorCode::ValidationFailed,
                                    format!(
                                        "Record {} revision must advance from {} to {}",
                                        change.record_id,
                                        server_revision,
                                        server_revision + 1
                                    ),
                                ));
                            }
                            current_head += 1;
                            let deleted = if change.deleted { 1 } else { 0 };
                            let deleted_at = change.deleted.then_some(server_now.as_str());
                            let size = change.ciphertext_b64.len();

                            tx.execute(
                                "UPDATE record SET record_type = ?1, schema_version = ?2, key_version = ?3, version = ?4, revision = ?4, ciphertext = ?5, checksum = ?6, size = ?7, deleted = ?8, deleted_at = ?9, updated_at = ?10, client_updated_at = ?11, device_id = ?12 WHERE vault_id = ?13 AND record_id = ?14",
                                rusqlite::params![
                                    &change.record_type,
                                    change.schema_version,
                                    change.key_version,
                                    change.revision,
                                    &change.ciphertext_b64,
                                    &change.checksum,
                                    size,
                                    deleted,
                                    deleted_at,
                                    &server_now,
                                    &change.updated_at,
                                    &user.device_id,
                                    &vault_id,
                                    &change.record_id,
                                ],
                            )
                            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                            tx.execute(
                                "UPDATE record_history SET valid_to_seq = ?1 WHERE vault_id = ?2 AND record_id = ?3 AND revision = ?4",
                                rusqlite::params![current_head, &vault_id, &change.record_id, server_revision],
                            )
                            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                            tx.execute(
                                "INSERT INTO record_history (vault_id, record_id, record_type, schema_version, key_version, version, revision, seq, ciphertext, checksum, size, deleted, updated_at, client_updated_at, device_id, valid_from_seq, valid_to_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?7, NULL)",
                                rusqlite::params![
                                    &vault_id,
                                    &change.record_id,
                                    &change.record_type,
                                    change.schema_version,
                                    change.key_version,
                                    change.revision,
                                    current_head,
                                    &change.ciphertext_b64,
                                    &change.checksum,
                                    size,
                                    deleted,
                                    &server_now,
                                    &change.updated_at,
                                    &user.device_id,
                                ],
                            )
                            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                            applied.push(AppliedChangeV2 {
                                record_id: change.record_id,
                                revision: change.revision,
                                seq: current_head,
                            });
                        } else {
                            conflicts.push(ConflictDetailV2 {
                                record_id: change.record_id,
                                server_record_type,
                                server_schema_version,
                                server_key_version,
                                server_revision,
                                server_ciphertext_b64: server_ciphertext,
                                server_checksum,
                                server_deleted,
                                server_deleted_at,
                                server_device_id,
                                server_updated_at,
                            });
                        }
                    }
                }
            }

            if !applied.is_empty() {
                tx.execute(
                    "INSERT INTO commit_log (vault_id, seq, device_id, change_count, created_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, 'normal')",
                    rusqlite::params![&vault_id, current_head, &user.device_id, applied.len(), &server_now],
                )
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
                tx.execute(
                    "UPDATE vault SET head_seq = ?1 WHERE vault_id = ?2",
                    rusqlite::params![current_head, &vault_id],
                )
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            }
            let response = CommitResponseV2 {
                schema_version: SYNC_SCHEMA_VERSION_V2,
                applied,
                conflicts,
                new_cursor: current_head,
                head_seq: current_head,
            };
            let response_json = serde_json::to_string(&response)
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            tx.execute(
                "INSERT INTO idempotency_key (account_id, method, path, key, request_hash, status, response_json, expires_at) VALUES (?1, 'POST', '/v2/sync/commit', ?2, ?3, 200, ?4, ?5)",
                rusqlite::params![
                    &user.account_id,
                    &idempotency_key,
                    &request_hash,
                    &response_json,
                    now_epoch + IDEMPOTENCY_TTL_SECONDS,
                ],
            )
            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            tx.commit()
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;

            Ok(response)
        },
    )?;

    Ok(Json(response))
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
    if cursor > i64::MAX as u64 {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            "cursor is out of range",
        ));
    }
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

        let mut items = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;

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

pub async fn get_changes_v2(
    user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<ChangesPageResponseV2>, crate::middleware::ApiError> {
    let cursor = query.cursor.unwrap_or(0);
    if cursor > i64::MAX as u64 {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            "cursor is out of range",
        ));
    }
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let include_deleted = query.include_deleted.unwrap_or(true);

    let response = state.db.with_conn(
        |conn| -> Result<ChangesPageResponseV2, crate::middleware::ApiError> {
            let (vault_id, head_seq): (String, i64) = conn
                .query_row(
                    "SELECT vault_id, head_seq FROM vault WHERE account_id = ?1",
                    [&user.account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

            let mut sql = "SELECT seq, record_id, record_type, schema_version, key_version, revision, ciphertext, checksum, size, deleted, updated_at, client_updated_at, device_id FROM record_history WHERE vault_id = ?1 AND seq > ?2".to_string();
            if !include_deleted {
                sql.push_str(" AND deleted = 0");
            }
            sql.push_str(" ORDER BY seq ASC, revision ASC LIMIT ?3");

            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            let rows = statement
                .query_map(
                    rusqlite::params![&vault_id, cursor, (limit + 1) as i64],
                    |row| {
                        let deleted = row.get::<_, i32>(9)? != 0;
                        let deleted_at: String = row.get(10)?;
                        let updated_at: String = row.get(11)?;
                        Ok(ChangeRecordV2 {
                            seq: row.get(0)?,
                            record_id: row.get(1)?,
                            record_type: row.get(2)?,
                            schema_version: row.get(3)?,
                            key_version: row.get(4)?,
                            revision: row.get(5)?,
                            ciphertext_b64: row.get(6)?,
                            checksum: row.get(7)?,
                            size: row.get(8)?,
                            deleted,
                            deleted_at: deleted.then_some(deleted_at),
                            updated_at,
                            device_id: row.get(12)?,
                        })
                    },
                )
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            let mut changes = rows
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
            let has_more = changes.len() > limit;
            if has_more {
                changes.pop();
            }
            let next_cursor = changes.last().map(|change| change.seq).unwrap_or(cursor);

            Ok(ChangesPageResponseV2 {
                schema_version: SYNC_SCHEMA_VERSION_V2,
                changes,
                next_cursor,
                has_more,
                head_seq: head_seq as u64,
            })
        },
    )?;

    Ok(Json(response))
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

fn hash_json(value: &impl Serialize) -> Result<String, crate::middleware::ApiError> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| make_error(ApiErrorCode::Internal, error.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(encoded);
    Ok(hex_encode(hasher.finalize()))
}
