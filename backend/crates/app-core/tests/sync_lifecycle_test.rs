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

/// R01/S01：同步本应能拉回缺失 secret，不应被与本次操作无关的 SOCKS 全库预检卡死。
#[tokio::test]
async fn broken_forward_reference_does_not_block_sync() {
    use openshell_core_domain::{PortForwardId, SecretId};

    let (url, _server_db, _server_dir, task) = server().await;
    let dir = tempfile::tempdir().unwrap();
    let app = AppServices::new(dir.path().into()).unwrap();
    app.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();

    let broken_ref = SecretId::new().to_string();
    app.store
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_auth,socks_password_ref,created_at,updated_at) \
                 VALUES(?1,'broken','dynamic','127.0.0.1',1081,'userpass',?2,1,1)",
                rusqlite::params![PortForwardId::new().to_string(), broken_ref],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();

    let result = app.sync.sync_now().await;
    assert!(result.is_ok(), "无关的坏引用不得阻断整体同步: {result:?}");
    task.abort();
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
async fn history_catch_up_keeps_latest_forward_and_matching_conflict_envelope() {
    use openshell_app_core::sync_service::SyncConflictChoice;
    use openshell_core_domain::{
        PortForwardRepository, PortForwardRuleInput, PortForwardType, SecretId, SocksAuth,
    };

    let (url, db, _server_dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let input = |name: &str, password: Option<&str>| PortForwardRuleInput {
        name: name.into(),
        bind_port: 1080,
        rule_type: Some(PortForwardType::Dynamic),
        socks_auth: Some(SocksAuth::Userpass),
        socks_username: Some("synthetic-user".into()),
        socks_password: password.map(str::to_owned),
        ..Default::default()
    };
    let prepared = a
        .network_secrets
        .prepare_forward(input("initial", Some("synthetic-first")), None)
        .await
        .unwrap();
    let initial = a.port_forward_repo.create(prepared).await.unwrap();
    a.store
        .with_conn(|conn| {
            conn.execute(
                "UPDATE port_forward SET updated_at=1 WHERE id=?1",
                [initial.id.as_str()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    a.sync.sync_now().await.unwrap();
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    let local = b
        .network_secrets
        .prepare_forward(input("offline-local", None), Some(&initial.id))
        .await
        .unwrap();
    b.port_forward_repo
        .update(&initial.id, local)
        .await
        .unwrap();

    // Keep successive forward versions on opposite sides of the 500-change page boundary.
    a.store.with_conn(|conn| {
        let tx = conn.transaction().unwrap();
        for i in 0..501 {
            tx.execute("INSERT INTO session(id,name,protocol,host,created_at,updated_at,dirty) VALUES(?1,?2,'ssh','history.invalid',1,1,1)",
                rusqlite::params![ulid::Ulid::new().to_string(), format!("history-{i}")]).unwrap();
        }
        tx.commit().unwrap();
        Ok(())
    }).unwrap();
    let mut previous = initial.socks_password_ref.clone().unwrap();
    let mut removed = Vec::new();
    for (name, password, timestamp) in [
        ("second", "synthetic-second", 20_i64),
        ("latest", "synthetic-third", 10_i64),
    ] {
        let prepared = a
            .network_secrets
            .prepare_forward(input(name, Some(password)), Some(&initial.id))
            .await
            .unwrap();
        let saved = a
            .port_forward_repo
            .update(&initial.id, prepared)
            .await
            .unwrap();
        a.store
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE port_forward SET updated_at=?1 WHERE id=?2",
                    rusqlite::params![timestamp, initial.id.as_str()],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
        a.sync.sync_now().await.unwrap();
        let old = SecretId::from_string(&previous).unwrap();
        SecretRepo::new(a.store.clone()).delete(&old).unwrap();
        a.sync.sync_now().await.unwrap();
        removed.push(previous);
        previous = saved.socks_password_ref.unwrap();
    }
    let (count, versions): (i64, i64) = db
        .with_conn(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row("SELECT COUNT(*) FROM record_history", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM record_history WHERE record_id=?1",
                    [initial.id.as_str()],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert!(count > 500);
    assert_eq!(
        versions, 3,
        "fixture must retain all actual server history versions"
    );

    // A new device must recover the current graph without replaying obsolete dependencies.
    let c = AppServices::new_in_memory().unwrap();
    c.sync
        .login(&url, ACCOUNT, PASSWORD)
        .await
        .expect("history catch-up must restore the newest forward");
    let restored = c.port_forward_repo.get(&initial.id).await.unwrap();
    assert_eq!(restored.name, "latest");
    assert_eq!(
        restored.socks_password_ref.as_deref(),
        Some(previous.as_str())
    );
    assert_eq!(restored.updated_at, 10);
    assert_eq!(
        c.network_secrets
            .resolve(&previous, "socks_password")
            .unwrap()
            .as_str(),
        "synthetic-third"
    );
    assert_eq!(
        c.session
            .list_sessions(&SessionQuery::default())
            .await
            .unwrap()
            .len(),
        501
    );
    for id in &removed {
        c.store
            .with_conn(|conn| {
                let tombstone: (u64, bool) = conn
                    .query_row(
                        "SELECT revision,deleted FROM sync_record WHERE record_id=?1",
                        [id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(tombstone, (2, true));
                Ok(())
            })
            .unwrap();
    }

    let cursor: u64 = b
        .store
        .with_conn(|conn| {
            Ok(conn
                .query_row("SELECT last_cursor FROM sync_meta", [], |row| row.get(0))
                .unwrap())
        })
        .unwrap();
    // Cursor persistence is part of the graph/conflict transaction, including an UPSERT update.
    for operation in ["INSERT", "UPDATE OF last_cursor"] {
        b.store
            .with_conn(|conn| {
                conn.execute_batch(&format!("CREATE TRIGGER reject_history_cursor BEFORE {operation} ON sync_meta BEGIN SELECT RAISE(ABORT,'synthetic cursor failure'); END")).unwrap();
                Ok(())
            })
            .unwrap();
        let error = b.sync.sync_now().await.unwrap_err();
        assert!(
            error.message.contains("synthetic cursor failure"),
            "{}",
            error.message
        );
        let unchanged = b.port_forward_repo.get(&initial.id).await.unwrap();
        assert_eq!(unchanged.name, "offline-local");
        assert_eq!(unchanged.socks_password_ref, initial.socks_password_ref);
        assert!(b.sync.list_conflicts().unwrap().is_empty());
        assert!(b
            .session
            .list_sessions(&SessionQuery::default())
            .await
            .unwrap()
            .is_empty());
        assert!(SecretRepo::new(b.store.clone())
            .get(&SecretId::from_string(removed[0].clone()).unwrap())
            .unwrap()
            .is_some());
        assert!(SecretRepo::new(b.store.clone())
            .get(&SecretId::from_string(previous.clone()).unwrap())
            .unwrap()
            .is_none());
        b.store.with_conn(|conn| {
            let state: (u64, bool) = conn.query_row("SELECT revision,(SELECT dirty FROM port_forward WHERE id=?1) FROM sync_record WHERE record_id=?1", [initial.id.as_str()], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
            assert_eq!(state, (1, true));
            assert_eq!(conn.query_row("SELECT last_cursor FROM sync_meta", [], |row| row.get::<_, u64>(0)).unwrap(), cursor);
            conn.execute_batch("DROP TRIGGER reject_history_cursor").unwrap();
            Ok(())
        }).unwrap();
    }

    // Failure to retain a dirty local copy must roll back the graph, revision and cursor together.
    b.store.with_conn(|conn| {
        conn.execute_batch("CREATE TRIGGER reject_history_conflict BEFORE INSERT ON sync_conflict BEGIN SELECT RAISE(ABORT,'synthetic history conflict failure'); END").unwrap();
        Ok(())
    }).unwrap();
    assert!(b.sync.sync_now().await.is_err());
    assert_eq!(
        b.port_forward_repo.get(&initial.id).await.unwrap().name,
        "offline-local"
    );
    assert!(b.sync.list_conflicts().unwrap().is_empty());
    b.store.with_conn(|conn| {
        let state: (u64, bool) = conn.query_row("SELECT revision,(SELECT dirty FROM port_forward WHERE id=?1) FROM sync_record WHERE record_id=?1", [initial.id.as_str()], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(state, (1, true));
        assert_eq!(conn.query_row("SELECT last_cursor FROM sync_meta", [], |row| row.get::<_, u64>(0)).unwrap(), cursor);
        conn.execute_batch("DROP TRIGGER reject_history_conflict").unwrap();
        Ok(())
    }).unwrap();
    assert_eq!(b.sync.sync_now().await.unwrap().conflict_count, 1);
    assert_eq!(
        b.port_forward_repo.get(&initial.id).await.unwrap().name,
        "latest"
    );
    let conflicts = b.sync.list_conflicts().unwrap();
    assert_eq!(
        conflicts.len(),
        1,
        "only the latest remote version needs a conflict backup"
    );
    b.store.with_conn(|conn| {
        let conflict: (u64, i64, String) = conn.query_row("SELECT remote_revision,remote_updated_at,local_snapshot_json FROM sync_conflict WHERE id=?1", [&conflicts[0].id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!((conflict.0, conflict.1), (3, 10));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&conflict.2).unwrap()["payload"]["name"], "offline-local");
        Ok(())
    }).unwrap();
    b.sync
        .resolve_conflict(&conflicts[0].id, SyncConflictChoice::Remote)
        .await
        .unwrap();
    assert_eq!(
        b.port_forward_repo.get(&initial.id).await.unwrap().name,
        "latest"
    );
    assert!(b.sync.list_conflicts().unwrap().is_empty());
    assert_eq!(b.sync.sync_now().await.unwrap().pushed_count, 0);

    // Obsolete history is still authenticated and checked before selecting the latest revision.
    let history_row: i64 = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT rowid FROM record_history WHERE record_id=?1 AND revision=1",
                [initial.id.as_str()],
                |row| row.get(0),
            )
        })
        .unwrap();
    for (column, corrupt, expected) in [
        ("ciphertext", "tampered-history-ciphertext", "checksum"),
        ("checksum", "", "metadata mismatch"),
        (
            "client_updated_at",
            "1970-01-01T00:00:00.099Z",
            "metadata mismatch",
        ),
        ("device_id", "tampered-device", "metadata mismatch"),
        ("record_id", "tampered-id", "vault error"),
        ("record_type", "secret", "vault error"),
        ("revision", "99", "metadata mismatch"),
        ("deleted", "1", "metadata mismatch"),
        ("schema_version", "3", "unsupported"),
        ("key_version", "2", "unsupported"),
        ("size", "1", "metadata mismatch"),
    ] {
        let original: String = db
            .with_conn(|conn| {
                conn.query_row(
                    &format!("SELECT CAST({column} AS TEXT) FROM record_history WHERE rowid=?1"),
                    [history_row],
                    |row| row.get(0),
                )
            })
            .unwrap();
        let corrupt = if column == "ciphertext" {
            format!(
                "{}{}",
                if original.starts_with('A') { 'B' } else { 'A' },
                &original[1..]
            )
        } else {
            corrupt.to_owned()
        };
        db.with_conn(|conn| {
            conn.execute(
                &format!("UPDATE record_history SET {column}=?1 WHERE rowid=?2"),
                rusqlite::params![corrupt, history_row],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        c.store
            .with_conn(|conn| {
                conn.execute("UPDATE sync_meta SET last_cursor=0", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let error = c.sync.sync_now().await.unwrap_err();
        assert!(
            error.message.to_lowercase().contains(expected),
            "{}",
            error.message
        );
        assert_eq!(
            c.port_forward_repo.get(&initial.id).await.unwrap().name,
            "latest"
        );
        c.store
            .with_conn(|conn| {
                assert_eq!(
                    conn.query_row("SELECT last_cursor FROM sync_meta", [], |row| row
                        .get::<_, u64>(0))
                        .unwrap(),
                    0
                );
                Ok(())
            })
            .unwrap();
        db.with_conn(|conn| {
            conn.execute(
                &format!("UPDATE record_history SET {column}=?1 WHERE rowid=?2"),
                rusqlite::params![original, history_row],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }
    c.sync.sync_now().await.unwrap();
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

/// Task8：真实 HTTP 同步 fixture —— 服务器确实提供有效加密 secret/history，
/// 客户端确实缺该 secret，同步后拉回并让规则口令可 resolve，cursor 与服务器 head 一致。
/// 不只证明「无关坏行不阻断空同步」，也不跳过历史认证与图事务断言。
#[tokio::test]
async fn sync_pulls_back_missing_secret_and_makes_rule_password_resolvable() {
    use openshell_core_domain::{
        PortForwardRepository, PortForwardRuleInput, PortForwardType, SocksAuth,
    };

    let (url, server_db, _server_dir, task) = server().await;
    let a = AppServices::new_in_memory().unwrap();
    a.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();

    let prepared = a
        .network_secrets
        .prepare_forward(
            PortForwardRuleInput {
                name: "synced-socks".into(),
                bind_port: 1080,
                rule_type: Some(PortForwardType::Dynamic),
                socks_auth: Some(SocksAuth::Userpass),
                socks_username: Some("synthetic-user".into()),
                socks_password: Some("synthetic-synced-socks-password".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let rule = a.port_forward_repo.create(prepared).await.unwrap();
    let secret_id = rule.socks_password_ref.clone().unwrap();
    let first = a.sync.sync_now().await.unwrap();
    assert!(
        first.pushed_count >= 2,
        "服务器必须收到 secret 与规则两条记录: {first:?}"
    );

    // 服务器确实留有该 secret 的加密 history 版本，而不是空同步。
    let (history_count, encrypted_history_count): (i64, i64) = server_db
        .with_conn(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM record_history WHERE record_id=?1",
                    [&secret_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM record_history WHERE record_id=?1 AND length(ciphertext)>0",
                    [&secret_id],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert!(history_count >= 1, "服务器必须提供该 secret 的历史版本");
    assert_eq!(
        history_count, encrypted_history_count,
        "每个历史版本都必须是非空加密密文"
    );

    // 另一台设备经真实 HTTP 拉回完整图，确认该口令可解析。
    let b = AppServices::new_in_memory().unwrap();
    b.sync.login(&url, ACCOUNT, PASSWORD).await.unwrap();
    assert_eq!(
        b.network_secrets
            .resolve(&secret_id, "socks_password")
            .unwrap()
            .as_str(),
        "synthetic-synced-socks-password"
    );

    // 模拟客户端确实缺该 secret（连同其同步元数据），但规则引用仍在。
    b.store
        .with_conn(|conn| {
            conn.execute("DELETE FROM secret WHERE id=?1", [&secret_id])
                .unwrap();
            conn.execute("DELETE FROM sync_record WHERE record_id=?1", [&secret_id])
                .unwrap();
            conn.execute("UPDATE sync_meta SET last_cursor=0", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(b
        .network_secrets
        .resolve(&secret_id, "socks_password")
        .is_err());
    assert!(
        b.network_secrets.forwards_strict(None).await.is_err(),
        "缺 secret 时严格读取必须拒绝该规则"
    );

    let result = b
        .sync
        .sync_now()
        .await
        .expect("真实 HTTP 同步必须从历史中拉回缺失 secret");
    assert!(
        result.pulled_count >= 1,
        "必须从服务器拉回至少一条记录: {result:?}"
    );
    assert_eq!(
        b.network_secrets
            .resolve(&secret_id, "socks_password")
            .unwrap()
            .as_str(),
        "synthetic-synced-socks-password",
        "拉回的 secret 必须能让规则口令正确 resolve"
    );

    let cursor: u64 = b
        .store
        .with_conn(|conn| {
            Ok(conn
                .query_row("SELECT last_cursor FROM sync_meta", [], |row| row.get(0))
                .unwrap())
        })
        .unwrap();
    let server_head: i64 = server_db
        .with_conn(|conn| {
            Ok::<_, rusqlite::Error>(conn.query_row(
                "SELECT MAX(head_seq) FROM vault",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(
        cursor, server_head as u64,
        "同步后 cursor 必须推进到服务器 head"
    );
    assert_eq!(result.head_seq, server_head as u64);

    // 图事务：规则引用与拉回的 secret 一致，且没有留下冲突或半提交状态。
    let restored = b.port_forward_repo.get(&rule.id).await.unwrap();
    assert_eq!(
        restored.socks_password_ref.as_deref(),
        Some(secret_id.as_str())
    );
    assert_eq!(result.conflict_count, 0);
    assert!(b.sync.list_conflicts().unwrap().is_empty());
    task.abort();
}
