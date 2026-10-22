use crate::middleware::make_error;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, ChannelSummary, ChannelsResponse, RevocationsResponse, UpdateManifest,
    HEADER_CHANNEL, HEADER_INSTALL_ID,
};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub async fn get_update(
    State(state): State<AppState>,
    Path((target, version)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, crate::middleware::ApiError> {
    let channel = headers
        .get(HEADER_CHANNEL)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("stable")
        .to_string();

    let install_id = headers
        .get(HEADER_INSTALL_ID)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("anonymous_install_id")
        .to_string();

    let (latest_json, latest_ver) = match state.db.with_conn(|conn| {
        conn.query_row(
            "SELECT manifest_json, version FROM update_manifest WHERE target = ?1 AND channel = ?2 AND revoked = 0 ORDER BY published_at DESC LIMIT 1",
            [&target, &channel],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
    }) {
        Ok(v) => v,
        Err(_) => return Err(make_error(ApiErrorCode::NotFound, "No updates available for target and channel")),
    };

    if version != "latest" && version == latest_ver {
        // Client already on latest version: Tauri updater expects 204 No Content
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let manifest: UpdateManifest = serde_json::from_str(&latest_json)
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

    // Check rollout percentage
    if manifest.rollout.percent < 100 {
        let mut hasher = Sha256::new();
        hasher.update(format!("{}:{}", install_id, manifest.version).as_bytes());
        let digest = hasher.finalize();
        let bucket = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 100;
        if bucket >= manifest.rollout.percent {
            // Not eligible for gradual rollout yet
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }

    Ok((StatusCode::OK, Json(manifest)).into_response())
}

pub async fn get_revocations(
    State(state): State<AppState>,
    Path(target): Path<String>,
) -> Result<Json<RevocationsResponse>, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let resp = state.db.with_conn(
        |conn| -> Result<RevocationsResponse, crate::middleware::ApiError> {
            let mut stmt = conn
                .prepare("SELECT version FROM update_manifest WHERE target = ?1 AND revoked = 1")
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let rows = stmt
                .query_map([&target], |r| r.get(0))
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let revoked: Vec<String> = rows.flatten().collect();

            Ok(RevocationsResponse {
                revoked_versions: revoked,
                min_supported_version: "1.0.0".to_string(),
                updated_at: now,
            })
        },
    )?;

    Ok(Json(resp))
}

pub async fn get_channels(
    State(state): State<AppState>,
    Path(target): Path<String>,
) -> Result<Json<ChannelsResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<ChannelsResponse, crate::middleware::ApiError> {
        let mut stmt = conn.prepare(
            "SELECT channel, version, 100 FROM update_manifest WHERE target = ?1 AND revoked = 0 GROUP BY channel ORDER BY published_at DESC",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let rows = stmt.query_map([&target], |r| {
            Ok(ChannelSummary {
                name: r.get(0)?,
                latest_version: r.get(1)?,
                rollout_percent: r.get(2)?,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let channels: Vec<ChannelSummary> = rows.flatten().collect();

        Ok(ChannelsResponse { channels })
    })?;

    Ok(Json(resp))
}

pub async fn download_artifact(
    State(state): State<AppState>,
    Path(artifact_id): Path<String>,
) -> Result<Response, crate::middleware::ApiError> {
    // Sanitize artifact_id against directory traversal
    if artifact_id.contains("..") || artifact_id.contains('/') || artifact_id.contains('\\') {
        return Err(make_error(
            ApiErrorCode::InvalidRequest,
            "Invalid artifact ID",
        ));
    }

    let file_path = PathBuf::from(&state.config.artifacts_dir).join(&artifact_id);
    if !file_path.exists() {
        return Err(make_error(
            ApiErrorCode::NotFound,
            "Artifact file not found",
        ));
    }

    let bytes = std::fs::read(&file_path).map_err(|e| {
        make_error(
            ApiErrorCode::Internal,
            format!("Failed to read artifact: {e}"),
        )
    })?;

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact.bin");

    let disp = format!("attachment; filename=\"{filename}\"");

    Ok((
        StatusCode::OK,
        [
            ("content-type", "application/octet-stream"),
            ("content-disposition", &disp),
        ],
        bytes,
    )
        .into_response())
}
