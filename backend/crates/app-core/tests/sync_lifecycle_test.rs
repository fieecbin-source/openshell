use openshell_app_core::AppServices;
use openshell_core_domain::{
    CredentialKind, GroupKind, Protocol, SessionInput, SessionPatch, SessionQuery,
};
use openshell_server::{AppState, Config, DbPool};
use openshell_store::SecretRepo;
use std::net::SocketAddr;

const ACCOUNT: &str = "isolated-sync-user";
const PASSWORD: &str = "isolated-sync-password-12345";

async fn server() -> (
    String,
    DbPool,
    tempfile::TempDir,
    tokio::task::JoinHandle<()>,
) {
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        database_url: temp.path().join("server.db").to_string_lossy().into_owned(),
        sync_username: Some(ACCOUNT.into()),
        sync_password: Some(PASSWORD.into()),
        jwt_secret: "isolated-integration-jwt-secret-1234567890".into(),
        allow_multi_user: false,
        ..Config::default()
    };
    let db = DbPool::open(&config.database_url).unwrap();
    openshell_server::bootstrap_single_user(&db, &config).unwrap();
    let app = openshell_server::create_router(AppState::new(db.clone(), config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (url, db, temp, task)
}

#[tokio::test]
async fn three_field_login_restores_credentials_and_bidirectional_changes() {
    let (url, server_db, _server_dir, task) = server().await;
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let a = AppServices::new(a_dir.path().into()).unwrap();
    a.sync
        .login(&url, ACCOUNT, PASSWORD)
        .await
        .expect("three-field login initializes vault A");
    assert_eq!(a.vault.status().unwrap().state, "unlocked");
    let group = a
        .session
        .create_group(None, "Synced group".into(), GroupKind::Session)
        .await
        .unwrap();
    let credential = a
        .session
        .create_credential(
            "Synced credential".into(),
            CredentialKind::Password,
            Some("tester".into()),
            "connection-secret-never-plaintext",
            None,
            None,
        )
        .await
        .unwrap();
    let session = a
        .session
        .create_session(SessionInput {
            name: Some("Synced host".into()),
            protocol: Some(Protocol::Ssh),
            host: Some("203.0.113.77".into()),
            port: Some(22),
            username: Some("tester".into()),
            group_id: Some(group.id.clone()),
            credential_id: Some(credential.id.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(a.sync.sync_now().await.unwrap().pushed_count >= 4);

    let b = AppServices::new(b_dir.path().into()).unwrap();
    b.sync
        .login(&url, ACCOUNT, PASSWORD)
        .await
        .expect("three-field login imports and applies remote vault B");
    let restored = b.session.get_session(&session.id).await.unwrap();
    assert_eq!(restored.host.as_deref(), Some("203.0.113.77"));
    assert_eq!(restored.credential_id, Some(credential.id.clone()));
    assert_eq!(restored.group_id, Some(group.id));
    let restored_credential = b.session.get_credential(&credential.id).await.unwrap();
    let secret = SecretRepo::new(b.store.clone())
        .get(&restored_credential.secret_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        b.vault.manager().decrypt_secret(&secret).unwrap(),
        b"connection-secret-never-plaintext"
    );

    b.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("Updated on B".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    b.sync.sync_now().await.unwrap();
    a.sync.sync_now().await.unwrap();
    assert_eq!(
        a.session.get_session(&session.id).await.unwrap().name,
        "Updated on B"
    );

    // B edits while offline; A deletes the same record. Retain a conflict backup and the deletion.
    b.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("Offline edit".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    a.session.delete_session(&session.id).await.unwrap();
    a.sync.sync_now().await.unwrap();
    let result = b.sync.sync_now().await.unwrap();
    assert_eq!(result.conflict_count, 1);
    assert!(b
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .is_empty());
    b.sync.sync_now().await.unwrap();
    a.sync.sync_now().await.unwrap();
    assert!(a
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .is_empty());

    let auth = a
        .store
        .with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value_json FROM setting WHERE scope='sync' AND key='auth'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap())
        })
        .unwrap();
    assert!(!auth.contains(PASSWORD));
    assert!(!auth.contains("access_token"));
    server_db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT ciphertext FROM record").unwrap();
            for value in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
                let value = value.unwrap();
                assert!(!value.contains("203.0.113.77"));
                assert!(!value.contains("connection-secret-never-plaintext"));
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();

    drop(b);
    let reopened = AppServices::new(b_dir.path().into()).unwrap();
    assert!(
        !reopened.sync.get_config().unwrap().is_logged_in,
        "an account ID alone is not a login session"
    );
    reopened
        .sync
        .login(&url, ACCOUNT, PASSWORD)
        .await
        .expect("login unlocks the imported vault after restart");
    assert_eq!(reopened.vault.status().unwrap().state, "unlocked");
    reopened.sync.logout().unwrap();
    reopened
        .sync
        .login(&url, ACCOUNT, PASSWORD)
        .await
        .expect("repeated login does not violate NULL setting uniqueness");
    task.abort();
}

#[tokio::test]
async fn sync_downloads_all_pages_before_applying_foreign_keys() {
    let (url, _db, _server_dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    a.store.with_conn(|conn| {
        let tx = conn.transaction().unwrap();
        for i in 0..510 {
            tx.execute("INSERT INTO session(id,name,protocol,host,created_at,updated_at,dirty) VALUES (?1,?2,'ssh','203.0.113.1',1,1,1)",
                rusqlite::params![ulid::Ulid::new().to_string(), format!("host-{i}")]).unwrap();
        }
        tx.commit().unwrap();
        Ok(())
    }).unwrap();
    assert_eq!(a.sync.sync_now().await.unwrap().pushed_count, 510);
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    assert_eq!(
        b.session
            .list_sessions(&SessionQuery::default())
            .await
            .unwrap()
            .len(),
        510
    );
    task.abort();
}

#[tokio::test]
async fn personal_server_rejects_an_old_second_account() {
    let (url, db, _dir, task) = server().await;
    let hash = openshell_server::auth::hash_password(PASSWORD).unwrap();
    db.with_conn(|conn| {
        conn.execute("INSERT INTO account(id,email,password_hash,token_epoch,created_at) VALUES ('old-account','other-user',?1,1,'2026-01-01T00:00:00Z')", [hash])?;
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
    let client = AppServices::new_in_memory().unwrap();
    assert!(client
        .sync
        .login(&url, "other-user", PASSWORD)
        .await
        .is_err());
    assert_eq!(client.vault.status().unwrap().state, "uninitialized");
    task.abort();
}

#[tokio::test]
async fn first_sync_preserves_an_existing_vault_with_a_different_local_password() {
    let (url, _db, _dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.vault
        .init("original-local-password", false, None)
        .unwrap();
    let credential = a
        .session
        .create_credential(
            "Existing credential".into(),
            CredentialKind::Password,
            Some("tester".into()),
            "existing-connection-secret",
            None,
            None,
        )
        .await
        .unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let credential = b.session.get_credential(&credential.id).await.unwrap();
    let secret = SecretRepo::new(b.store.clone())
        .get(&credential.secret_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        b.vault.manager().decrypt_secret(&secret).unwrap(),
        b"existing-connection-secret"
    );
    a.vault.lock().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    a.vault.lock().unwrap();
    a.vault
        .unlock(Some("original-local-password"), false)
        .unwrap();
    assert_eq!(
        a.vault.status().unwrap().state,
        "unlocked",
        "sync must not change the original local password"
    );
    task.abort();
}
