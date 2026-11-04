use std::net::SocketAddr;

use axum::Router;
use openshell_server::{create_router, AppState, Config, DbPool};
use openshell_sync_protocol::{
    AuditEventListResponse, AuthResponse, LoginDevicePayload, LoginRequest, RegisterRequest,
};
use serde_json::json;
use tempfile::TempDir;
use tokio::net::TcpListener;

fn local_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("loopback HTTP client")
}

async fn start_server(mut configure: impl FnMut(&mut Config)) -> (String, TempDir) {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let mut config = Config {
        database_url: temp_dir
            .path()
            .join("security.db")
            .to_string_lossy()
            .into_owned(),
        jwt_secret: "test-only-jwt-secret-for-security-regressions".to_string(),
        artifacts_dir: temp_dir.path().join("artifacts"),
        ..Config::default()
    };
    configure(&mut config);

    let state = AppState::new(
        DbPool::open(&config.database_url).expect("database"),
        config,
    );
    let app: Router = create_router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("server");
    });

    (format!("http://{address}"), temp_dir)
}

async fn register_user(
    http: &reqwest::Client,
    base_url: &str,
    email: &str,
    password: &str,
    device_id: &str,
) -> AuthResponse {
    let response = http
        .post(format!("{base_url}/v1/auth/register"))
        .json(&RegisterRequest {
            email: email.to_string(),
            password: password.to_string(),
            device_name: format!("device {device_id}"),
            device_platform: "windows".to_string(),
            device_arch: "x86_64".to_string(),
            device_public_key: "test-key".to_string(),
            invite_code: None,
        })
        .send()
        .await
        .expect("register request");
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    response.json().await.expect("register response")
}

fn login_body(email: &str, password: &str, device_id: &str) -> LoginRequest {
    LoginRequest {
        email: email.to_string(),
        password: password.to_string(),
        device: LoginDevicePayload {
            id: Some(device_id.to_string()),
            name: "test device".to_string(),
            platform: "windows".to_string(),
            arch: "x86_64".to_string(),
            public_key: "test-key".to_string(),
            app_version: None,
        },
    }
}

#[tokio::test]
async fn audit_events_query_binds_user_filters() {
    let (base_url, _dir) = start_server(|config| {
        config.allow_multi_user = true;
    })
    .await;
    let http = local_http_client();

    let alice = register_user(
        &http,
        &base_url,
        "alice@example.com",
        "StrongPass123!",
        "dev-a",
    )
    .await;
    let _bob = register_user(
        &http,
        &base_url,
        "bob@example.com",
        "StrongPass123!",
        "dev-b",
    )
    .await;

    let fetch = |before: Option<&str>, event_type: Option<&str>| {
        let mut request = http
            .get(format!("{base_url}/v1/audit/events"))
            .header("authorization", format!("Bearer {}", alice.access_token))
            .header("x-device-id", &alice.device_id);
        if let Some(before) = before {
            request = request.query(&[("before", before)]);
        }
        if let Some(event_type) = event_type {
            request = request.query(&[("type", event_type)]);
        }
        request.send()
    };

    let normal = fetch(None, None).await.expect("normal audit query");
    assert_eq!(normal.status(), reqwest::StatusCode::OK);
    let normal_body: AuditEventListResponse = normal.json().await.expect("normal body");
    assert_eq!(
        normal_body.events.len(),
        1,
        "account only sees its own event"
    );

    let injected_before = fetch(Some("2000-01-01' OR 1=1 --"), None)
        .await
        .expect("injected before query");
    assert_eq!(injected_before.status(), reqwest::StatusCode::OK);
    let injected_body: AuditEventListResponse =
        injected_before.json().await.expect("injected body");
    assert!(
        injected_body.events.is_empty(),
        "`before` must be bound as a value, not executed as SQL"
    );

    let injected_type = fetch(
        None,
        Some("x' UNION SELECT id, type, device_id, at, ip_hash, metadata_json FROM account --"),
    )
    .await
    .expect("injected type query");
    assert_eq!(injected_type.status(), reqwest::StatusCode::OK);
    let injected_type_body: AuditEventListResponse =
        injected_type.json().await.expect("injected type body");
    assert!(
        injected_type_body.events.is_empty(),
        "`type` must be bound as a value, not executed as SQL"
    );
}

#[tokio::test]
async fn short_passwords_are_rejected() {
    let (base_url, _dir) = start_server(|_| {}).await;
    let http = local_http_client();

    let response = http
        .post(format!("{base_url}/v1/auth/register"))
        .json(&json!({
            "email": "short@example.com",
            "password": "short",
            "device_name": "d",
            "device_platform": "windows",
            "device_arch": "x86_64",
            "device_public_key": "k"
        }))
        .send()
        .await
        .expect("short password request");
    assert_eq!(response.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn login_failures_lock_the_account() {
    let (base_url, _dir) = start_server(|_| {}).await;
    let http = local_http_client();
    let auth = register_user(
        &http,
        &base_url,
        "lock@example.com",
        "StrongPass123!",
        "dev-lock",
    )
    .await;

    for _ in 0..5 {
        let response = http
            .post(format!("{base_url}/v1/auth/login"))
            .json(&login_body(
                "lock@example.com",
                "WrongPassword!",
                &auth.device_id,
            ))
            .send()
            .await
            .expect("failed login request");
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    let locked = http
        .post(format!("{base_url}/v1/auth/login"))
        .json(&login_body(
            "lock@example.com",
            "StrongPass123!",
            &auth.device_id,
        ))
        .send()
        .await
        .expect("locked login request");
    assert_eq!(locked.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn cors_only_allows_configured_origins() {
    let (base_url, _dir) = start_server(|_| {}).await;
    let http = local_http_client();

    let blocked = http
        .request(reqwest::Method::OPTIONS, format!("{base_url}/v1/account"))
        .header("origin", "https://evil.example")
        .header("access-control-request-method", "GET")
        .header(
            "access-control-request-headers",
            "authorization,x-device-id",
        )
        .send()
        .await
        .expect("blocked preflight");
    assert!(
        blocked
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "unknown origins must not receive CORS approval"
    );

    let allowed = http
        .request(reqwest::Method::OPTIONS, format!("{base_url}/v1/account"))
        .header("origin", "tauri://localhost")
        .header("access-control-request-method", "GET")
        .header(
            "access-control-request-headers",
            "authorization,x-device-id",
        )
        .send()
        .await
        .expect("allowed preflight");
    assert_eq!(
        allowed
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("tauri://localhost")
    );
}

#[tokio::test]
async fn metrics_requires_configured_bearer_token() {
    let (base_url, _dir) = start_server(|config| {
        config.metrics_token = Some("metrics-secret".to_string());
    })
    .await;
    let http = local_http_client();

    let missing = http
        .get(format!("{base_url}/metrics"))
        .send()
        .await
        .expect("metrics without token");
    assert_eq!(missing.status(), reqwest::StatusCode::UNAUTHORIZED);

    let ok = http
        .get(format!("{base_url}/metrics"))
        .header("authorization", "Bearer metrics-secret")
        .send()
        .await
        .expect("metrics with token");
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn empty_metrics_token_keeps_the_default_network_only_policy() {
    let (base_url, _dir) = start_server(|config| {
        config.metrics_token = Some(String::new());
    })
    .await;
    let response = local_http_client()
        .get(format!("{base_url}/metrics"))
        .send()
        .await
        .expect("metrics with the compose default");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}
