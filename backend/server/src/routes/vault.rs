use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{
    AddKeySlotRequest, ApiErrorCode, KdfParamsDto, KeySlotDto, KeySlotListResponse,
    PutVaultRequest, VaultResponse,
};

pub async fn put_vault(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<PutVaultRequest>,
) -> Result<Response, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let kdf_json = serde_json::to_string(&req.kdf)
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

    let (is_new, head_seq, created_at) = state.db.with_conn(|conn| -> Result<(bool, u64, String), crate::middleware::ApiError> {
        let existing: Option<(String, String, i64, String)> = conn.query_row(
            "SELECT vault_id, wrapped_key, head_seq, created_at FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).ok();

        if let Some((existing_vid, _existing_key, seq, cat)) = existing {
            if existing_vid == req.vault_id {
                // Idempotent update
                return Ok((false, seq as u64, cat));
            } else {
                return Err(make_error(ApiErrorCode::VaultExists, "Vault already exists with a different ID"));
            }
        }

        // Insert new vault
        conn.execute(
            "INSERT INTO vault (vault_id, account_id, schema_version, crypto_suite, kdf_json, wrapped_key, key_check, key_version, head_seq, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
            rusqlite::params![&req.vault_id, &user.account_id, req.schema_version, &req.crypto_suite, &kdf_json, &req.wrapped_key_b64, &req.key_check_b64, req.key_version, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Also insert initial key slot
        conn.execute(
            "INSERT INTO key_slot (vault_id, key_version, kdf_json, wrapped_key, key_check, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![&req.vault_id, req.key_version, &kdf_json, &req.wrapped_key_b64, &req.key_check_b64, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok((true, 0, now))
    })?;

    let resp = VaultResponse {
        vault_id: req.vault_id,
        schema_version: req.schema_version,
        key_version: req.key_version,
        kdf: req.kdf,
        wrapped_key_b64: req.wrapped_key_b64,
        key_check_b64: req.key_check_b64,
        head_seq,
        record_count: 0,
        bytes_used: 0,
        quota: 512 * 1024 * 1024,
        created_at,
    };

    let status = if is_new {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(resp)).into_response())
}

pub async fn get_vault(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<VaultResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<VaultResponse, crate::middleware::ApiError> {
        let mut stmt = conn
            .prepare("SELECT vault_id, schema_version, key_version, kdf_json, wrapped_key, key_check, head_seq, created_at FROM vault WHERE account_id = ?1")
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut rows = stmt
            .query([&user.account_id])
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let row = match rows.next() {
            Ok(Some(r)) => r,
            _ => return Err(make_error(ApiErrorCode::NotFound, "Vault not found")),
        };

        let vault_id: String = row.get(0)?;
        let schema_version: u32 = row.get(1)?;
        let key_version: u32 = row.get(2)?;
        let kdf_json: String = row.get(3)?;
        let wrapped_key_b64: String = row.get(4)?;
        let key_check_b64: String = row.get(5)?;
        let head_seq: i64 = row.get(6)?;
        let created_at: String = row.get(7)?;

        let kdf: KdfParamsDto = serde_json::from_str(&kdf_json)
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let record_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM record WHERE vault_id = ?1 AND deleted = 0",
            [&vault_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let bytes_used: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM record WHERE vault_id = ?1",
            [&vault_id],
            |r| r.get(0),
        ).unwrap_or(0);

        Ok(VaultResponse {
            vault_id,
            schema_version,
            key_version,
            kdf,
            wrapped_key_b64,
            key_check_b64,
            head_seq: head_seq as u64,
            record_count: record_count as u64,
            bytes_used: bytes_used as u64,
            quota: 512 * 1024 * 1024,
            created_at,
        })
    })?;

    Ok(Json(resp))
}

pub async fn add_key_slot(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<AddKeySlotRequest>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let kdf_json = serde_json::to_string(&req.kdf)
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        let (vault_id, cur_version): (String, u32) = conn.query_row(
            "SELECT vault_id, key_version FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        if req.key_version != cur_version + 1 {
            return Err(make_error(ApiErrorCode::VersionConflict, "Key version must be current + 1"));
        }

        let tx = conn.transaction().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Update vault
        tx.execute(
            "UPDATE vault SET key_version = ?1, wrapped_key = ?2, key_check = ?3, kdf_json = ?4 WHERE vault_id = ?5",
            rusqlite::params![req.key_version, &req.wrapped_key_b64, &req.key_check_b64, &kdf_json, &vault_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Insert slot
        tx.execute(
            "INSERT INTO key_slot (vault_id, key_version, kdf_json, wrapped_key, key_check, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![&vault_id, req.key_version, &kdf_json, &req.wrapped_key_b64, &req.key_check_b64, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        tx.commit().map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        Ok(())
    })?;

    Ok(StatusCode::OK)
}

pub async fn list_key_slots(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<KeySlotListResponse>, crate::middleware::ApiError> {
    let slots = state.db.with_conn(|conn| -> Result<Vec<KeySlotDto>, crate::middleware::ApiError> {
        let vault_id: String = conn.query_row(
            "SELECT vault_id FROM vault WHERE account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Vault not found"))?;

        let mut stmt = conn
            .prepare("SELECT key_version, kdf_json, wrapped_key, key_check, created_at, retired_at FROM key_slot WHERE vault_id = ?1 ORDER BY key_version ASC")
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map([&vault_id], |row| {
            let kdf_json: String = row.get(1)?;
            let kdf = serde_json::from_str(&kdf_json).unwrap_or(KdfParamsDto {
                alg: "argon2id".to_string(),
                salt_b64: "".to_string(),
                mem_kib: 65536,
                time: 3,
                parallelism: 1,
            });
            Ok(KeySlotDto {
                key_version: row.get(0)?,
                kdf,
                wrapped_key_b64: row.get(2)?,
                key_check_b64: row.get(3)?,
                created_at: row.get(4)?,
                retired_at: row.get(5)?,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let list: Vec<KeySlotDto> = rows.flatten().collect();
        Ok(list)
    })?;

    Ok(Json(KeySlotListResponse { slots }))
}
