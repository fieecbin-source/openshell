use crate::auth::verify_access_token;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{ApiErrorCode, ApiErrorEnvelope, HEADER_DEVICE_ID};

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub account_id: String,
    pub device_id: String,
    pub session_id: String,
}

pub struct ApiError(pub StatusCode, pub ApiErrorEnvelope);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        make_error(ApiErrorCode::Internal, err.to_string())
    }
}

pub fn make_error(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    let status = StatusCode::from_u16(code.http_status()).unwrap_or(StatusCode::BAD_REQUEST);
    ApiError(status, ApiErrorEnvelope::new(code, message))
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Extract Authorization header
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| {
                make_error(
                    ApiErrorCode::Unauthenticated,
                    "Missing Authorization header",
                )
            })?;

        if !auth_header.starts_with("Bearer ") {
            return Err(make_error(
                ApiErrorCode::Unauthenticated,
                "Authorization header must be Bearer token",
            ));
        }

        let token = &auth_header[7..];
        let claims = verify_access_token(token, &state.config.jwt_secret).map_err(|e| {
            if e.contains("expired") {
                make_error(ApiErrorCode::TokenExpired, e)
            } else {
                make_error(ApiErrorCode::Unauthenticated, e)
            }
        })?;

        // Extract X-Device-Id header
        let device_id_header = parts
            .headers
            .get(HEADER_DEVICE_ID)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| {
                make_error(ApiErrorCode::InvalidRequest, "Missing X-Device-Id header")
            })?;

        if device_id_header != claims.did {
            return Err(make_error(
                ApiErrorCode::DeviceMismatch,
                "X-Device-Id does not match token claim",
            ));
        }

        // Validate account epoch and device status in DB
        let account_id = claims.sub.clone();
        let device_id = claims.did.clone();
        let token_epoch = claims.ver;

        let validation = state.db.with_conn(|conn| -> Result<(), ApiError> {
            // Check account
            let mut stmt = conn
                .prepare("SELECT token_epoch, disabled_at FROM account WHERE id = ?1")
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            let mut rows = stmt
                .query([&account_id])
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let (db_epoch, disabled_at): (i64, Option<String>) = match rows.next() {
                Ok(Some(row)) => (row.get(0).unwrap_or(1), row.get(1).unwrap_or(None)),
                _ => {
                    return Err(make_error(
                        ApiErrorCode::Unauthenticated,
                        "Account not found",
                    ))
                }
            };

            if disabled_at.is_some() {
                return Err(make_error(ApiErrorCode::Forbidden, "Account is disabled"));
            }

            if db_epoch as u64 != token_epoch {
                return Err(make_error(
                    ApiErrorCode::TokenRevoked,
                    "Token revoked due to account epoch change",
                ));
            }

            // Check device
            let mut dev_stmt = conn
                .prepare("SELECT revoked_at FROM device WHERE id = ?1 AND account_id = ?2")
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            let mut dev_rows = dev_stmt
                .query([&device_id, &account_id])
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            let revoked_at: Option<String> = match dev_rows.next() {
                Ok(Some(row)) => row.get(0).unwrap_or(None),
                _ => {
                    return Err(make_error(
                        ApiErrorCode::DeviceMismatch,
                        "Device not found for account",
                    ))
                }
            };

            if revoked_at.is_some() {
                return Err(make_error(
                    ApiErrorCode::DeviceRevoked,
                    "Device has been revoked",
                ));
            }

            // Update last_seen_at
            let now = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
            let _ = conn.execute(
                "UPDATE device SET last_seen_at = ?1 WHERE id = ?2",
                [&now, &device_id],
            );

            Ok(())
        })?;

        let _ = validation;

        Ok(AuthUser {
            account_id,
            device_id,
            session_id: claims.sid,
        })
    }
}
