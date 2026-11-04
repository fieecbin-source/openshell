use crate::auth::{
    create_access_token, generate_refresh_token, hash_password, hash_token, verify_password,
};
use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use openshell_sync_protocol::{
    AccountResponse, AccountSummaryDto, ApiErrorCode, AuthResponse, ChangePasswordRequest,
    LoginRequest, LogoutRequest, QuotaDto, RefreshRequest, RegisterRequest, ServerFeaturesDto,
    TokenResponse,
};
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const ACCESS_TOKEN_TTL_SEC: u64 = 900; // 15 mins
const REFRESH_TOKEN_TTL_SEC: u64 = 30 * 86400; // 30 days
const MAX_DEVICES_PER_ACCOUNT: u64 = 10;
const MIN_PASSWORD_LEN: usize = 8;

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(client_addr): ConnectInfo<SocketAddr>,
    Json(req): Json<RegisterRequest>,
) -> Result<Response, crate::middleware::ApiError> {
    if !is_password_acceptable(&req.password) {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            format!("Password must be {MIN_PASSWORD_LEN} to 128 characters long"),
        ));
    }

    // Validate email format
    if !req.email.contains('@') || req.email.len() > 254 {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            "Invalid email format",
        ));
    }

    // Check single-user mode or invite code
    if state.config.sync_username.is_some() {
        return Err(make_error(
            ApiErrorCode::RegistrationClosed,
            "Registration is closed on single-user deployment",
        ));
    }

    state
        .db
        .with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
            let account_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0))
                .unwrap_or(0);

            if account_count == 0
                && !first_registration_allowed(
                    client_addr.ip().is_loopback(),
                    req.invite_code.as_deref(),
                    state.config.bootstrap_token.as_deref(),
                )
            {
                return Err(make_error(
                    ApiErrorCode::Forbidden,
                    "First account registration requires BOOTSTRAP_TOKEN or loopback access",
                ));
            }

            if !state.config.allow_multi_user
                && account_count > 0
                && !token_matches(
                    state.config.bootstrap_token.as_deref(),
                    req.invite_code.as_deref(),
                )
            {
                return Err(make_error(
                    ApiErrorCode::RegistrationClosed,
                    "Registration is closed on single-user deployment",
                ));
            }

            if state.config.require_invite {
                let valid = match (&state.config.invite_code, &req.invite_code) {
                    (Some(expected), Some(provided)) => expected == provided,
                    _ => false,
                };
                if !valid {
                    return Err(make_error(
                        ApiErrorCode::Forbidden,
                        "Invalid or missing invite code",
                    ));
                }
            }

            // Check if email already exists
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM account WHERE email = ?1)",
                    [&req.email],
                    |r| r.get(0),
                )
                .unwrap_or(false);

            if exists {
                return Err(make_error(
                    ApiErrorCode::AccountExists,
                    "An account with this email already exists",
                ));
            }

            Ok(())
        })?;

    let password_hash =
        hash_password(&req.password).map_err(|e| make_error(ApiErrorCode::Internal, e))?;

    let account_id = Ulid::new().to_string();
    let device_id = Ulid::new().to_string();
    let session_id = Ulid::new().to_string();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let raw_refresh = generate_refresh_token();
    let hashed_refresh = hash_token(&raw_refresh);

    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let refresh_exp = now_epoch + REFRESH_TOKEN_TTL_SEC;
    let refresh_exp_iso = time::OffsetDateTime::from_unix_timestamp(refresh_exp as i64)
        .unwrap_or(time::OffsetDateTime::now_utc())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let (access_token, access_exp_iso) = create_access_token(
        &account_id,
        &device_id,
        &session_id,
        1,
        &state.config.jwt_secret,
        ACCESS_TOKEN_TTL_SEC,
    )
    .map_err(|e| make_error(ApiErrorCode::Internal, e))?;

    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        let tx = conn
            .transaction()
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Insert account
        tx.execute(
            "INSERT INTO account (id, email, password_hash, token_epoch, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            [&account_id, &req.email, &password_hash, &now],
        )
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Insert device
        tx.execute(
            "INSERT INTO device (id, account_id, name, platform, arch, public_key, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            [&device_id, &account_id, &req.device_name, &req.device_platform, &req.device_arch, &req.device_public_key, &now],
        )
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Insert refresh token
        let token_id = Ulid::new().to_string();
        tx.execute(
            "INSERT INTO refresh_token (id, account_id, device_id, token_hash, family_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [&token_id, &account_id, &device_id, &hashed_refresh, &session_id, &refresh_exp_iso, &now],
        )
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        // Record audit event
        let audit_id = Ulid::new().to_string();
        let ip_hash = "local_ip_hash".to_string();
        tx.execute(
            "INSERT INTO audit_event (id, account_id, device_id, type, ip_hash, at) VALUES (?1, ?2, ?3, 'auth.register', ?4, ?5)",
            [&audit_id, &account_id, &device_id, &ip_hash, &now],
        )
        .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        tx.commit()
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        Ok(())
    })?;

    let masked_email = mask_email(&req.email);

    let resp = AuthResponse {
        account_id: account_id.clone(),
        access_token,
        access_expires_at: access_exp_iso,
        refresh_token: raw_refresh,
        refresh_expires_at: refresh_exp_iso,
        device_id,
        account: Some(AccountSummaryDto {
            id: account_id,
            email_masked: masked_email,
            created_at: now,
        }),
    };

    Ok((StatusCode::CREATED, Json(resp)).into_response())
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(client_addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, crate::middleware::ApiError> {
    let limiter_key = hash_token(&format!(
        "{}|{}",
        req.email.trim().to_lowercase(),
        client_addr.ip()
    ));
    let ip_hash = hash_token(&client_addr.ip().to_string());
    if let Some(remaining) = state.login_limiter.lock_remaining(&limiter_key) {
        return Err(make_error(
            ApiErrorCode::RateLimited,
            format!(
                "Too many failed login attempts; retry in {} seconds",
                remaining.as_secs().max(1)
            ),
        ));
    }

    if !state.config.allow_multi_user
        && state
            .config
            .sync_username
            .as_deref()
            .is_some_and(|username| username.trim() != req.email)
    {
        state.login_limiter.record_failure(&limiter_key);
        return Err(make_error(
            ApiErrorCode::Unauthenticated,
            "Invalid credentials",
        ));
    }
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let credentials = state.db.with_conn(|conn| -> Result<(String, u64, String), crate::middleware::ApiError> {
        let mut stmt = conn
            .prepare("SELECT id, password_hash, token_epoch, disabled_at FROM account WHERE email = ?1")
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut rows = stmt
            .query([&req.email])
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let (acc_id, pass_hash, epoch, disabled_at): (String, String, i64, Option<String>) = match rows.next() {
            Ok(Some(row)) => (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?),
            _ => return Err(make_error(ApiErrorCode::Unauthenticated, "Invalid credentials")),
        };

        let record_failure = |conn: &rusqlite::Connection, account_id: &str| {
            let audit_id = Ulid::new().to_string();
            let _ = conn.execute(
                "INSERT INTO audit_event (id, account_id, device_id, type, ip_hash, at) VALUES (?1, ?2, ?3, 'auth.login.failed', ?4, ?5)",
                rusqlite::params![
                    &audit_id,
                    account_id,
                    req.device.id.as_deref(),
                    &ip_hash,
                    &now
                ],
            );
        };

        if disabled_at.is_some() {
            record_failure(conn, &acc_id);
            return Err(make_error(ApiErrorCode::Forbidden, "Account is disabled"));
        }

        if !verify_password(&req.password, &pass_hash) {
            record_failure(conn, &acc_id);
            return Err(make_error(ApiErrorCode::Unauthenticated, "Invalid credentials"));
        }

        Ok((acc_id, epoch as u64, mask_email(&req.email)))
    });

    let (account_id, token_epoch, masked_email) = match credentials {
        Ok(values) => {
            state.login_limiter.clear(&limiter_key);
            values
        }
        Err(err) => {
            state.login_limiter.record_failure(&limiter_key);
            return Err(err);
        }
    };

    // Determine or register device
    let device_id = state.db.with_conn(|conn| -> Result<String, crate::middleware::ApiError> {
        if let Some(id) = &req.device.id {
            // Check if device already exists
            let mut stmt = conn
                .prepare("SELECT revoked_at FROM device WHERE id = ?1 AND account_id = ?2")
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
            let mut rows = stmt
                .query([id, &account_id])
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            if let Ok(Some(row)) = rows.next() {
                let revoked_at: Option<String> = row.get(0)?;
                if revoked_at.is_some() {
                    return Err(make_error(ApiErrorCode::DeviceRevoked, "Device has been revoked"));
                }
                // Update device last_seen and public key
                let _ = conn.execute(
                    "UPDATE device SET last_seen_at = ?1, app_version = ?2, public_key = ?3 WHERE id = ?4",
                    rusqlite::params![&now, &req.device.app_version, &req.device.public_key, id],
                );
                return Ok(id.clone());
            }
        }

        // New device: check device quota
        let dev_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM device WHERE account_id = ?1 AND revoked_at IS NULL",
                [&account_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if dev_count as u64 >= MAX_DEVICES_PER_ACCOUNT {
            return Err(make_error(ApiErrorCode::QuotaExceeded, "Device quota exceeded (max 10)"));
        }

        let new_dev_id = req.device.id.clone().unwrap_or_else(|| Ulid::new().to_string());
        conn.execute(
            "INSERT INTO device (id, account_id, name, platform, arch, app_version, public_key, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            rusqlite::params![&new_dev_id, &account_id, &req.device.name, &req.device.platform, &req.device.arch, &req.device.app_version, &req.device.public_key, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        Ok(new_dev_id)
    })?;

    let session_id = Ulid::new().to_string();
    let raw_refresh = generate_refresh_token();
    let hashed_refresh = hash_token(&raw_refresh);

    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let refresh_exp = now_epoch + REFRESH_TOKEN_TTL_SEC;
    let refresh_exp_iso = time::OffsetDateTime::from_unix_timestamp(refresh_exp as i64)
        .unwrap_or(time::OffsetDateTime::now_utc())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let (access_token, access_exp_iso) = create_access_token(
        &account_id,
        &device_id,
        &session_id,
        token_epoch,
        &state.config.jwt_secret,
        ACCESS_TOKEN_TTL_SEC,
    )
    .map_err(|e| make_error(ApiErrorCode::Internal, e))?;

    // Store refresh token & record audit
    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        let token_id = Ulid::new().to_string();
        conn.execute(
            "INSERT INTO refresh_token (id, account_id, device_id, token_hash, family_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [&token_id, &account_id, &device_id, &hashed_refresh, &session_id, &refresh_exp_iso, &now],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let audit_id = Ulid::new().to_string();
        let _ = conn.execute(
            "INSERT INTO audit_event (id, account_id, device_id, type, ip_hash, at) VALUES (?1, ?2, ?3, 'auth.login', 'local_ip_hash', ?4)",
            [&audit_id, &account_id, &device_id, &now],
        );
        Ok(())
    })?;

    Ok(Json(AuthResponse {
        account_id: account_id.clone(),
        access_token,
        access_expires_at: access_exp_iso,
        refresh_token: raw_refresh,
        refresh_expires_at: refresh_exp_iso,
        device_id,
        account: Some(AccountSummaryDto {
            id: account_id,
            email_masked: masked_email,
            created_at: now,
        }),
    }))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<TokenResponse>, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let hashed_refresh = hash_token(&req.refresh_token);

    let (account_id, device_id, family_id, token_epoch) = state.db.with_conn(|conn| -> Result<(String, String, String, u64), crate::middleware::ApiError> {
        let mut stmt = conn
            .prepare("SELECT account_id, device_id, family_id, expires_at, revoked_at FROM refresh_token WHERE token_hash = ?1")
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut rows = stmt
            .query([&hashed_refresh])
            .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let (acc_id, dev_id, fam_id, exp_at, revoked_at): (String, String, String, String, Option<String>) = match rows.next() {
            Ok(Some(row)) => (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?),
            _ => return Err(make_error(ApiErrorCode::TokenExpired, "Invalid refresh token")),
        };

        if dev_id != req.device_id {
            return Err(make_error(ApiErrorCode::DeviceMismatch, "Device ID mismatch"));
        }

        // Token reuse detection! If already revoked, revoke whole family
        if revoked_at.is_some() {
            let _ = conn.execute(
                "UPDATE refresh_token SET revoked_at = ?1 WHERE family_id = ?2",
                [&now, &fam_id],
            );
            return Err(make_error(ApiErrorCode::TokenRevoked, "Refresh token reuse detected; session revoked"));
        }

        // Check if expired
        let now_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        if let Ok(exp_time) = time::OffsetDateTime::parse(&exp_at, &time::format_description::well_known::Rfc3339) {
            if (exp_time.unix_timestamp() as u64) < now_epoch {
                return Err(make_error(ApiErrorCode::TokenExpired, "Refresh token expired"));
            }
        }

        // Get account epoch
        let epoch: i64 = conn.query_row(
            "SELECT token_epoch FROM account WHERE id = ?1 AND disabled_at IS NULL",
            [&acc_id],
            |r| r.get(0),
        ).map_err(|_| make_error(ApiErrorCode::Unauthenticated, "Account inactive"))?;

        // Mark current token revoked (rotation)
        let _ = conn.execute(
            "UPDATE refresh_token SET revoked_at = ?1 WHERE token_hash = ?2",
            [&now, &hashed_refresh],
        );

        Ok((acc_id, dev_id, fam_id, epoch as u64))
    })?;

    // Issue new pair
    let new_raw_refresh = generate_refresh_token();
    let new_hashed_refresh = hash_token(&new_raw_refresh);

    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let refresh_exp = now_epoch + REFRESH_TOKEN_TTL_SEC;
    let refresh_exp_iso = time::OffsetDateTime::from_unix_timestamp(refresh_exp as i64)
        .unwrap_or(time::OffsetDateTime::now_utc())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let (access_token, access_exp_iso) = create_access_token(
        &account_id,
        &device_id,
        &family_id,
        token_epoch,
        &state.config.jwt_secret,
        ACCESS_TOKEN_TTL_SEC,
    )
    .map_err(|e| make_error(ApiErrorCode::Internal, e))?;

    state.db.with_conn(|conn| {
        let token_id = Ulid::new().to_string();
        let _ = conn.execute(
            "INSERT INTO refresh_token (id, account_id, device_id, token_hash, family_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [&token_id, &account_id, &device_id, &new_hashed_refresh, &family_id, &refresh_exp_iso, &now],
        );
    });

    Ok(Json(TokenResponse {
        access_token,
        access_expires_at: access_exp_iso,
        refresh_token: new_raw_refresh,
        refresh_expires_at: refresh_exp_iso,
    }))
}

pub async fn logout(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<LogoutRequest>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    state.db.with_conn(|conn| {
        if req.all_devices {
            let _ = conn.execute(
                "UPDATE account SET token_epoch = token_epoch + 1 WHERE id = ?1",
                [&user.account_id],
            );
            let _ = conn.execute(
                "UPDATE refresh_token SET revoked_at = ?1 WHERE account_id = ?2",
                [&now, &user.account_id],
            );
        } else {
            let _ = conn.execute(
                "UPDATE refresh_token SET revoked_at = ?1 WHERE device_id = ?2",
                [&now, &user.device_id],
            );
        }
    });

    Ok(StatusCode::NO_CONTENT)
}

pub async fn change_password(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    if !is_password_acceptable(&req.new_password) {
        return Err(make_error(
            ApiErrorCode::ValidationFailed,
            format!("New password must be {MIN_PASSWORD_LEN} to 128 characters long"),
        ));
    }

    state
        .db
        .with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
            let hash: String = conn
                .query_row(
                    "SELECT password_hash FROM account WHERE id = ?1",
                    [&user.account_id],
                    |r| r.get(0),
                )
                .map_err(|_| make_error(ApiErrorCode::Unauthenticated, "Account not found"))?;

            if !verify_password(&req.current_password, &hash) {
                return Err(make_error(
                    ApiErrorCode::Unauthenticated,
                    "Current password incorrect",
                ));
            }

            let new_hash = hash_password(&req.new_password)
                .map_err(|e| make_error(ApiErrorCode::Internal, e))?;

            // Increment token epoch and update hash
            conn.execute(
            "UPDATE account SET password_hash = ?1, token_epoch = token_epoch + 1 WHERE id = ?2",
            [&new_hash, &user.account_id],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            // Revoke all existing refresh tokens
            let now = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
            let _ = conn.execute(
                "UPDATE refresh_token SET revoked_at = ?1 WHERE account_id = ?2",
                [&now, &user.account_id],
            );

            Ok(())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_account(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<AccountResponse>, crate::middleware::ApiError> {
    let resp = state.db.with_conn(|conn| -> Result<AccountResponse, crate::middleware::ApiError> {
        let (email, created_at): (String, String) = conn.query_row(
            "SELECT email, created_at FROM account WHERE id = ?1",
            [&user.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| make_error(ApiErrorCode::NotFound, "Account not found"))?;

        let dev_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM device WHERE account_id = ?1 AND revoked_at IS NULL",
            [&user.account_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let rec_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM record r JOIN vault v ON r.vault_id = v.vault_id WHERE v.account_id = ?1 AND r.deleted = 0",
            [&user.account_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let bytes_used: i64 = conn.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM record r JOIN vault v ON r.vault_id = v.vault_id WHERE v.account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let snp_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snapshot s JOIN vault v ON s.vault_id = v.vault_id WHERE v.account_id = ?1",
            [&user.account_id],
            |r| r.get(0),
        ).unwrap_or(0);

        Ok(AccountResponse {
            account_id: user.account_id,
            email_masked: mask_email(&email),
            created_at,
            last_login_at: None,
            quota: QuotaDto {
                bytes_used: bytes_used as u64,
                bytes_limit: 512 * 1024 * 1024, // 512 MiB
                records_used: rec_count as u64,
                records_limit: 100_000,
                devices_used: dev_count as u64,
                devices_limit: MAX_DEVICES_PER_ACCOUNT,
                snapshots_used: snp_count as u64,
                snapshots_limit: 20,
            },
            features: ServerFeaturesDto {
                relay_enabled: state.config.relay_enabled,
                multi_user: state.config.allow_multi_user,
                registration_open: state.config.allow_multi_user,
            },
        })
    })?;

    Ok(Json(resp))
}

fn is_password_acceptable(password: &str) -> bool {
    let len = password.chars().count();
    (MIN_PASSWORD_LEN..=128).contains(&len)
}

fn token_matches(expected: Option<&str>, provided: Option<&str>) -> bool {
    match (expected, provided) {
        (Some(expected), Some(provided)) if !expected.is_empty() => expected == provided,
        _ => false,
    }
}

fn first_registration_allowed(
    is_loopback: bool,
    provided: Option<&str>,
    expected: Option<&str>,
) -> bool {
    // 配置了 BOOTSTRAP_TOKEN 时必须出示令牌；未配置时才允许本机初始化。
    // 这样即使 HTTPS 反代把远端请求表现为 loopback，也无法绕过已配置的令牌。
    match expected {
        Some(expected) if !expected.is_empty() => token_matches(Some(expected), provided),
        _ => is_loopback,
    }
}

fn mask_email(email: &str) -> String {
    let parts: Vec<&str> = email.split('@').collect();
    if parts.len() != 2 {
        return "***".to_string();
    }
    let name = parts[0];
    let domain = parts[1];
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return format!("***@{domain}");
    };
    if name.chars().count() <= 2 {
        format!("{first}*@{domain}")
    } else {
        let second = chars.next().unwrap_or(first);
        format!("{first}{second}*@{domain}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_length_is_enforced() {
        assert!(!is_password_acceptable("short"));
        assert!(is_password_acceptable("12345678"));
        assert!(is_password_acceptable(&"a".repeat(128)));
        assert!(!is_password_acceptable(&"a".repeat(129)));
    }

    #[test]
    fn first_registration_requires_token_or_loopback() {
        // 未配置令牌：仅 loopback 可初始化。
        assert!(first_registration_allowed(true, None, None));
        assert!(!first_registration_allowed(false, Some("anything"), None));

        // 配置令牌后，即使来自 loopback 也必须出示正确令牌。
        assert!(first_registration_allowed(
            false,
            Some("expected"),
            Some("expected")
        ));
        assert!(first_registration_allowed(
            true,
            Some("expected"),
            Some("expected")
        ));
        assert!(!first_registration_allowed(true, None, Some("expected")));
        assert!(!first_registration_allowed(
            true,
            Some("wrong"),
            Some("expected")
        ));
        assert!(!token_matches(Some(""), Some("")));
    }

    #[test]
    fn mask_email_handles_empty_and_wide_characters() {
        assert_eq!(mask_email("@example.com"), "***@example.com");
        assert_eq!(mask_email("张三@example.com"), "张*@example.com");
        assert_eq!(mask_email("ab@example.com"), "a*@example.com");
        assert_eq!(mask_email("abc@example.com"), "ab*@example.com");
        assert_eq!(mask_email("not-an-email"), "***");
    }
}
