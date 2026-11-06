use openshell_app_core::AppServices;
use openshell_core_domain::{
    CredentialKind, GroupKind, Protocol, SessionInput, SessionPatch, SessionQuery,
};
use openshell_server::{AppState, Config, DbPool};
use openshell_store::SecretRepo;
use std::net::SocketAddr;

const ACCOUNT: &str = "isolated-sync-user";
const PASSWORD: &str = "isolated-sync-password-12345";

#[tokio::test]
async fn resolving_a_snapshot_requires_its_proxy_dependency() {
    use openshell_app_core::sync_codec::{self, ConflictBackupInput};
    let app = AppServices::new_in_memory().unwrap();
    let session = app
        .session
        .create_session(SessionInput {
            host: Some("proxy.invalid".into()),
            proxy_id: Some("missing-proxy".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let record = sync_codec::collect_dirty_records(&app.store)
        .unwrap()
        .into_iter()
        .find(|record| record.record_id == session.id.as_str())
        .unwrap();
    let conflict = sync_codec::backup_conflict(
        &app.store,
        ConflictBackupInput {
            record_id: record.record_id.clone(),
            record_type: record.record_type,
            local_snapshot: Some(serde_json::to_value(&record).unwrap()),
            remote_ciphertext_b64: String::new(),
            remote_checksum: String::new(),
            remote_revision: 1,
            remote_device_id: None,
            remote_deleted: false,
            remote_updated_at: 1,
        },
    )
    .unwrap();
    assert!(sync_codec::resolve_conflict_record(&app.store, &conflict, true, &record).is_err());
    assert_eq!(app.sync.list_conflicts().unwrap().len(), 1);
    app.network_secrets.save_proxies(vec![serde_json::from_value(serde_json::json!({
        "id":"missing-proxy","name":"restored proxy","proxy_type":"socks5","host":"127.0.0.1","port":1080
    })).unwrap()]).unwrap();
    let mut proxies = app
        .settings_repo
        .get("global", None, "proxy_list")
        .unwrap()
        .unwrap()
        .value_json;
    proxies[0]["password_ref"] = serde_json::json!(openshell_core_domain::SecretId::new());
    app.settings_repo
        .set("global", None, "proxy_list", proxies.clone(), false)
        .unwrap();
    assert!(sync_codec::resolve_conflict_record(&app.store, &conflict, true, &record).is_err());
    assert_eq!(app.sync.list_conflicts().unwrap().len(), 1);
    proxies[0]["password_ref"] = serde_json::Value::Null;
    app.settings_repo
        .set("global", None, "proxy_list", proxies, false)
        .unwrap();
    sync_codec::resolve_conflict_record(&app.store, &conflict, true, &record).unwrap();
    assert!(app.sync.list_conflicts().unwrap().is_empty());
}

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

    let conflicts = b.sync.list_conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0].has_local_snapshot);
    b.store
        .with_conn(|conn| {
            conn.execute(
                "UPDATE credential SET deleted_at=1 WHERE id=?1",
                [credential.id.as_str()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(
        b.sync
            .resolve_conflict(
                &conflicts[0].id,
                openshell_app_core::sync_service::SyncConflictChoice::Local
            )
            .await
            .is_err(),
        "must not restore a session whose credential was deleted"
    );
    assert_eq!(b.sync.list_conflicts().unwrap().len(), 1);
    assert!(b
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .is_empty());
    b.store
        .with_conn(|conn| {
            conn.execute(
                "UPDATE credential SET deleted_at=NULL WHERE id=?1",
                [credential.id.as_str()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    b.sync
        .resolve_conflict(
            &conflicts[0].id,
            openshell_app_core::sync_service::SyncConflictChoice::Local,
        )
        .await
        .unwrap();
    assert_eq!(
        b.session.get_session(&session.id).await.unwrap().name,
        "Offline edit"
    );
    assert!(b.sync.list_conflicts().unwrap().is_empty());
    b.sync.sync_now().await.unwrap();
    a.sync.sync_now().await.unwrap();
    assert_eq!(
        a.session.get_session(&session.id).await.unwrap().name,
        "Offline edit"
    );
    b.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("edit after resolve".into()),
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
        "edit after resolve"
    );

    a.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("remote choice".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    b.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("local choice".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    a.sync.sync_now().await.unwrap();
    assert_eq!(b.sync.sync_now().await.unwrap().conflict_count, 1);
    let conflict = b.sync.list_conflicts().unwrap().remove(0);
    b.sync
        .resolve_conflict(
            &conflict.id,
            openshell_app_core::sync_service::SyncConflictChoice::Remote,
        )
        .await
        .unwrap();
    assert_eq!(
        b.session.get_session(&session.id).await.unwrap().name,
        "remote choice"
    );
    b.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("after remote resolve".into()),
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
        "after remote resolve"
    );

    let persisted_auth: i64 = a.store.with_conn(|conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM setting WHERE scope='sync' AND key IN ('auth','access_token','refresh_token','password')", [], |r| r.get(0)).unwrap())
    }).unwrap();
    assert_eq!(
        persisted_auth, 0,
        "login material must remain in memory only"
    );
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
    reopened.vault.unlock(Some(PASSWORD), false).unwrap();
    assert!(
        !reopened.sync.get_config().unwrap().is_logged_in,
        "unlock must not restore a login session"
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
async fn lost_upload_acknowledgement_keeps_own_echo_resolvable() {
    use openshell_app_core::sync_service::SyncConflictChoice;
    let (url, server_db, _dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let session = a
        .session
        .create_session(SessionInput {
            name: Some("before acknowledgement".into()),
            host: Some("echo.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    // Fail only the local acknowledgement after the real server has committed the upload.
    a.store.with_conn(|conn| {
        conn.execute_batch("CREATE TRIGGER reject_ack BEFORE UPDATE OF dirty ON session WHEN NEW.dirty=0 BEGIN SELECT RAISE(ABORT,'synthetic acknowledgement failure'); END").unwrap();
        Ok(())
    }).unwrap();
    assert!(a.sync.sync_now().await.is_err());
    let committed: i64 = server_db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM record WHERE record_id=?1 AND device_id=?2",
                rusqlite::params![session.id.as_str(), a.sync.get_or_create_device_id()],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        committed, 1,
        "the server must have accepted this device's upload"
    );
    a.store
        .with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER reject_ack").unwrap();
            Ok(())
        })
        .unwrap();
    a.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("edit after lost acknowledgement".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

    let result = a
        .sync
        .sync_now()
        .await
        .expect("own echo must not permanently block pull");
    assert_eq!(result.conflict_count, 1);
    assert_eq!(result.pushed_count, 0);
    let conflicts = a.sync.list_conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].record_id, session.id.as_str());
    assert!(conflicts[0].has_local_snapshot);
    a.sync
        .resolve_conflict(&conflicts[0].id, SyncConflictChoice::Local)
        .await
        .unwrap();
    assert_eq!(
        a.session.get_session(&session.id).await.unwrap().name,
        "edit after lost acknowledgement"
    );
    assert!(a.sync.list_conflicts().unwrap().is_empty());
    assert_eq!(a.sync.sync_now().await.unwrap().pushed_count, 1);
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    assert_eq!(
        b.session.get_session(&session.id).await.unwrap().name,
        "edit after lost acknowledgement"
    );
    task.abort();
}

#[tokio::test]
async fn changed_conflicts_refresh_without_losing_the_original_local_snapshot() {
    use openshell_app_core::sync_service::SyncConflictChoice;
    let (url, _db, _dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let session = a
        .session
        .create_session(SessionInput {
            name: Some("initial".into()),
            host: Some("refresh.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    a.sync.sync_now().await.unwrap();
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    for local_edit in [true, false] {
        for (app, name) in [(&b, "original local"), (&a, "first remote")] {
            app.session
                .update_session(
                    &session.id,
                    SessionPatch {
                        name: Some(name.into()),
                        ..Default::default()
                    },
                    None,
                )
                .await
                .unwrap();
        }
        a.sync.sync_now().await.unwrap();
        assert_eq!(b.sync.sync_now().await.unwrap().conflict_count, 1);
        let old = b.sync.list_conflicts().unwrap().remove(0);
        let (editor, name) = if local_edit {
            (&b, "later local")
        } else {
            (&a, "later remote")
        };
        editor
            .session
            .update_session(
                &session.id,
                SessionPatch {
                    name: Some(name.into()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        if !local_edit {
            a.sync.sync_now().await.unwrap();
        }
        b.sync.sync_now().await.unwrap();
        let latest = b
            .sync
            .list_conflicts()
            .unwrap()
            .into_iter()
            .find(|c| c.id != old.id)
            .expect("sync must refresh a changed conflict");
        let old_snapshot: String = b
            .store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT local_snapshot_json FROM sync_conflict WHERE id=?1",
                    [&old.id],
                    |row| row.get(0),
                )
                .map_err(|e| openshell_core_domain::DomainError::internal(e.to_string()))
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&old_snapshot).unwrap()["payload"]["name"],
            "original local"
        );
        let choice = if local_edit {
            SyncConflictChoice::Local
        } else {
            SyncConflictChoice::Remote
        };
        b.sync.resolve_conflict(&latest.id, choice).await.unwrap();
        assert_eq!(b.session.get_session(&session.id).await.unwrap().name, name);
        assert!(b.sync.list_conflicts().unwrap().is_empty());
        b.sync.sync_now().await.unwrap();
        a.sync.sync_now().await.unwrap();
        assert_eq!(a.session.get_session(&session.id).await.unwrap().name, name);
    }
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
