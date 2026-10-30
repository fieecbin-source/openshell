pub mod auth;
pub mod config;
pub mod db;
pub mod middleware;
pub mod routes;
pub mod state;

pub use config::Config;
pub use db::DbPool;
pub use routes::create_router;
pub use state::AppState;

pub fn bootstrap_single_user(db: &DbPool, config: &Config) -> Result<(), String> {
    let (username, password) = match (&config.sync_username, &config.sync_password) {
        (Some(u), Some(p)) if !u.trim().is_empty() && !p.is_empty() => (u.trim(), p),
        _ => return Ok(()),
    };

    let password_hash = auth::hash_password(password)
        .map_err(|e| format!("Failed to hash sync password: {e}"))?;

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    db.with_conn(|conn| -> Result<(), rusqlite::Error> {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, password_hash FROM account WHERE email = ?1",
                [username],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        if let Some((_id, _old_hash)) = existing {
            conn.execute(
                "UPDATE account SET password_hash = ?1 WHERE email = ?2",
                rusqlite::params![&password_hash, username],
            )?;
            tracing::info!("Single-user account '{}' verified and updated", username);
        } else {
            let account_id = ulid::Ulid::new().to_string();
            conn.execute(
                "INSERT INTO account (id, email, password_hash, token_epoch, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
                rusqlite::params![&account_id, username, &password_hash, &now],
            )?;
            tracing::info!("Single-user account '{}' created successfully", username);
        }
        Ok(())
    }).map_err(|e| format!("Failed to bootstrap single user in database: {e}"))?;

    Ok(())
}
