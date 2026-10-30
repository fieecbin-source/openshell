pub mod auth;
pub mod devices;
pub mod ops;
pub mod relay;
pub mod snapshots;
pub mod sync;
pub mod updates;
pub mod vault;

use crate::state::AppState;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Ops & metrics
        .route("/healthz", get(ops::healthz))
        .route("/readyz", get(ops::readyz))
        .route("/metrics", get(ops::metrics))
        .route("/v1/audit/events", get(ops::get_audit_events))
        // Auth
        .route("/v1/auth/register", post(auth::register))
        .route("/v1/auth/login", post(auth::login))
        .route("/v1/auth/refresh", post(auth::refresh))
        .route("/v1/auth/logout", post(auth::logout))
        .route("/v1/auth/password", post(auth::change_password))
        .route("/v1/account", get(auth::get_account))
        // Devices
        .route(
            "/v1/devices",
            get(devices::list_devices).post(devices::create_device),
        )
        .route(
            "/v1/devices/:id",
            patch(devices::update_device).delete(devices::delete_device),
        )
        .route("/v1/devices/:id/revoke", post(devices::revoke_device))
        // Vault
        .route("/v1/vault", put(vault::put_vault).get(vault::get_vault))
        .route("/v1/vault/key-slot", post(vault::add_key_slot))
        .route("/v1/vault/key-slots", get(vault::list_key_slots))
        // Sync
        .route("/v1/sync/commit", post(sync::commit))
        .route("/v1/sync/changes", get(sync::get_changes))
        .route("/v1/sync/head", get(sync::get_sync_head))
        .route("/v1/sync/status", get(sync::get_sync_status))
        .route("/v2/sync/commit", post(sync::commit_v2))
        .route("/v2/sync/changes", get(sync::get_changes_v2))
        .route(
            "/v1/vault/records/:record_id/history",
            get(sync::get_record_history),
        )
        .route(
            "/v1/vault/records/:record_id/history/:version",
            get(sync::get_record_history_version),
        )
        // Snapshots & Rollback
        .route(
            "/v1/vault/snapshots",
            post(snapshots::create_snapshot).get(snapshots::list_snapshots),
        )
        .route(
            "/v1/vault/snapshots/:id",
            get(snapshots::get_snapshot).delete(snapshots::delete_snapshot),
        )
        .route("/v1/vault/rollback", post(snapshots::rollback))
        // Updates
        .route("/updates/:target/:version", get(updates::get_update))
        .route(
            "/updates/revocations/:target",
            get(updates::get_revocations),
        )
        .route("/updates/channels/:target", get(updates::get_channels))
        .route("/downloads/:artifact_id", get(updates::download_artifact))
        // Relay
        .route("/v1/relay/tickets", post(relay::create_ticket))
        .route("/v1/relay/tickets/:id", delete(relay::delete_ticket))
        .route("/v1/relay/stream", get(relay::relay_stream))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
