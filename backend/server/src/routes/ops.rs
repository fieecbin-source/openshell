use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{
    ApiErrorCode, AuditEventDto, AuditEventListResponse, HealthResponse, ReadyResponse,
};
use serde::Deserialize;

pub async fn healthz(State(state): State<AppState>) -> Json<HealthResponse> {
    let uptime = state.start_time.elapsed().as_secs();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    Json(HealthResponse {
        status: "ok".to_string(),
        version: "0.1.0".to_string(),
        uptime_sec: uptime,
        time: now,
    })
}

pub async fn readyz(State(state): State<AppState>) -> Response {
    let db_ok = state
        .db
        .with_conn(|conn| conn.query_row("SELECT 1", [], |_| Ok(())).is_ok());

    if db_ok {
        let relay_status = if state.config.relay_enabled {
            "on".to_string()
        } else {
            "off".to_string()
        };

        (
            StatusCode::OK,
            Json(ReadyResponse {
                status: "ready".to_string(),
                db: "ok".to_string(),
                migrations: "ok".to_string(),
                relay: relay_status,
            }),
        )
            .into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"status": "unavailable", "db": "error"})),
        )
            .into_response()
    }
}

pub async fn metrics(State(state): State<AppState>) -> Response {
    let uptime = state.start_time.elapsed().as_secs();
    let (accounts, devices, records, snapshots) = state.db.with_conn(|conn| {
        let a: i64 = conn
            .query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0))
            .unwrap_or(0);
        let d: i64 = conn
            .query_row("SELECT COUNT(*) FROM device", [], |r| r.get(0))
            .unwrap_or(0);
        let r_cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM record", [], |r| r.get(0))
            .unwrap_or(0);
        let s: i64 = conn
            .query_row("SELECT COUNT(*) FROM snapshot", [], |r| r.get(0))
            .unwrap_or(0);
        (a, d, r_cnt, s)
    });

    let body = format!(
        "# HELP openshell_uptime_seconds OpenShell server uptime in seconds\n\
         # TYPE openshell_uptime_seconds gauge\n\
         openshell_uptime_seconds {}\n\
         # HELP openshell_accounts_total Total registered accounts\n\
         # TYPE openshell_accounts_total gauge\n\
         openshell_accounts_total {}\n\
         # HELP openshell_devices_total Total registered devices\n\
         # TYPE openshell_devices_total gauge\n\
         openshell_devices_total {}\n\
         # HELP openshell_records_total Total current records in vault\n\
         # TYPE openshell_records_total gauge\n\
         openshell_records_total {}\n\
         # HELP openshell_snapshots_total Total snapshots stored\n\
         # TYPE openshell_snapshots_total gauge\n\
         openshell_snapshots_total {}\n",
        uptime, accounts, devices, records, snapshots
    );

    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<usize>,
    pub before: Option<String>,
    #[serde(rename = "type")]
    pub event_type: Option<String>,
}

pub async fn get_audit_events(
    user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<AuditEventListResponse>, crate::middleware::ApiError> {
    let limit = query.limit.unwrap_or(50).min(200);

    let events = state.db.with_conn(|conn| -> Result<Vec<AuditEventDto>, crate::middleware::ApiError> {
        let mut sql = "SELECT id, type, device_id, at, ip_hash, metadata_json FROM audit_event WHERE account_id = ?1".to_string();
        if let Some(before) = &query.before {
            sql.push_str(&format!(" AND at < '{before}'"));
        }
        if let Some(t) = &query.event_type {
            sql.push_str(&format!(" AND type = '{t}'"));
        }
        sql.push_str(" ORDER BY at DESC LIMIT ?2");

        let mut stmt = conn.prepare(&sql).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        let rows = stmt.query_map([&user.account_id, &limit.to_string()], |row| {
            let meta_str: Option<String> = row.get(5)?;
            let metadata = meta_str.and_then(|s| serde_json::from_str(&s).ok());
            Ok(AuditEventDto {
                id: row.get(0)?,
                event_type: row.get(1)?,
                device_id: row.get(2)?,
                at: row.get(3)?,
                ip_hash: row.get(4)?,
                metadata,
            })
        }).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let list: Vec<AuditEventDto> = rows.flatten().collect();
        Ok(list)
    })?;

    Ok(Json(AuditEventListResponse {
        has_more: events.len() >= limit,
        events,
    }))
}
