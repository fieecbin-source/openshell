use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, CreateDeviceRequest, DeviceDto, DeviceListResponse, RevokeDeviceRequest,
    UpdateDeviceRequest,
};
use ulid::Ulid;

pub async fn list_devices(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<DeviceListResponse>, crate::middleware::ApiError> {
    let devices = state.db.with_conn(|conn| -> Result<Vec<DeviceDto>, crate::middleware::ApiError> {
        let mut stmt = conn
            .prepare("SELECT id, name, platform, arch, app_version, created_at, last_seen_at, last_sync_at, revoked_at FROM device WHERE account_id = ?1 ORDER BY created_at ASC")
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map([&user.account_id], |row| {
            let id: String = row.get(0)?;
            let current = id == user.device_id;
            Ok(DeviceDto {
                id,
                name: row.get(1)?,
                platform: row.get(2)?,
                arch: row.get(3)?,
                app_version: row.get(4)?,
                created_at: row.get(5)?,
                last_seen_at: row.get(6)?,
                last_sync_at: row.get(7)?,
                revoked_at: row.get(8)?,
                current,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let list: Vec<DeviceDto> = rows.flatten().collect();
        Ok(list)
    })?;

    Ok(Json(DeviceListResponse { devices }))
}

pub async fn create_device(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateDeviceRequest>,
) -> Result<(StatusCode, Json<DeviceDto>), crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let dev_id = req.id.unwrap_or_else(|| Ulid::new().to_string());

    let device = state.db.with_conn(|conn| -> Result<DeviceDto, crate::middleware::ApiError> {
        // Check if exists
        let existing: Option<(String, String)> = conn.query_row(
            "SELECT id, public_key FROM device WHERE id = ?1 AND account_id = ?2",
            [&dev_id, &user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();

        if let Some((id, pk)) = existing {
            if pk == req.public_key {
                return Ok(DeviceDto {
                    id,
                    name: req.name,
                    platform: req.platform,
                    arch: req.arch,
                    app_version: req.app_version,
                    created_at: now.clone(),
                    last_seen_at: now,
                    last_sync_at: None,
                    revoked_at: None,
                    current: dev_id == user.device_id,
                });
            } else {
                return Err(make_error(ApiErrorCode::DeviceNameConflict, "Device ID exists with different public key"));
            }
        }

        conn.execute(
            "INSERT INTO device (id, account_id, name, platform, arch, app_version, public_key, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            rusqlite::params![&dev_id, &user.account_id, &req.name, &req.platform, &req.arch, &req.app_version, &req.public_key, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok(DeviceDto {
            id: dev_id.clone(),
            name: req.name,
            platform: req.platform,
            arch: req.arch,
            app_version: req.app_version,
            created_at: now.clone(),
            last_seen_at: now,
            last_sync_at: None,
            revoked_at: None,
            current: dev_id == user.device_id,
        })
    })?;

    Ok((StatusCode::CREATED, Json(device)))
}

pub async fn update_device(
    user: AuthUser,
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    Json(req): Json<UpdateDeviceRequest>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    state
        .db
        .with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
            let updated = conn
                .execute(
                    "UPDATE device SET name = ?1 WHERE id = ?2 AND account_id = ?3",
                    [&req.name, &device_id, &user.account_id],
                )
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            if updated == 0 {
                return Err(make_error(ApiErrorCode::NotFound, "Device not found"));
            }
            Ok(())
        })?;

    Ok(StatusCode::OK)
}

pub async fn delete_device(
    user: AuthUser,
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    if device_id == user.device_id {
        return Err(make_error(
            ApiErrorCode::Forbidden,
            "Cannot delete current device",
        ));
    }

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        let updated = conn.execute(
            "UPDATE device SET revoked_at = ?1, revoke_reason = 'deleted' WHERE id = ?2 AND account_id = ?3",
            [&now, &device_id, &user.account_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        if updated == 0 {
            return Err(make_error(ApiErrorCode::NotFound, "Device not found"));
        }

        let _ = conn.execute(
            "UPDATE refresh_token SET revoked_at = ?1 WHERE device_id = ?2",
            [&now, &device_id],
        );

        Ok(())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_device(
    user: AuthUser,
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    Json(req): Json<RevokeDeviceRequest>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    if device_id == user.device_id {
        return Err(make_error(
            ApiErrorCode::Forbidden,
            "Cannot revoke current device",
        ));
    }

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let reason = req.reason.unwrap_or_else(|| "manual".to_string());

    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        let updated = conn.execute(
            "UPDATE device SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3 AND account_id = ?4",
            [&now, &reason, &device_id, &user.account_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        if updated == 0 {
            return Err(make_error(ApiErrorCode::NotFound, "Device not found"));
        }

        let _ = conn.execute(
            "UPDATE refresh_token SET revoked_at = ?1 WHERE device_id = ?2",
            [&now, &device_id],
        );

        Ok(())
    })?;

    Ok(StatusCode::NO_CONTENT)
}
