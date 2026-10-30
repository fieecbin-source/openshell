use std::net::SocketAddr;
use tokio::net::TcpListener;

use openshell_server::{create_router, AppState, Config, DbPool};
use openshell_sync_client::{decrypt_entity_record, encrypt_entity_record, SyncClient};
use openshell_sync_protocol::*;
use openshell_vault::VaultKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct TestSession {
    name: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct TestCredential {
    username: String,
    auth_type: String,
}

async fn start_test_server() -> (String, DbPool, AppState) {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let db_path = temp_dir.path().join("test_server.db");

    let config = Config {
        database_url: db_path.to_str().unwrap().to_string(),
        relay_enabled: true,
        artifacts_dir: temp_dir.path().join("artifacts"),
        ..Config::default()
    };
    let _ = std::fs::create_dir_all(&config.artifacts_dir);

    let db_pool = DbPool::open(&config.database_url).expect("db pool");
    let app_state = AppState::new(db_pool.clone(), config);

    let app = create_router(app_state.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let local_addr = listener.local_addr().expect("local addr");
    let base_url = format!("http://{}", local_addr);

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    (base_url, db_pool, app_state)
}

#[tokio::test]
async fn test_full_server_and_e2ee_sync_lifecycle() {
    let (base_url, db_pool, _app_state) = start_test_server().await;
    let mut client = SyncClient::new(&base_url, "dev_macos_a");

    // 1. Health & Ops
    let client_http = reqwest::Client::new();
    let health_res = client_http
        .get(format!("{}/healthz", base_url))
        .send()
        .await
        .expect("healthz send");
    assert_eq!(health_res.status(), reqwest::StatusCode::OK);

    // 2. Auth: Register & Login
    let email = "alice@example.com";
    let password = "SuperSecretPassword123!";

    let register_resp = client
        .register(RegisterRequest {
            email: email.to_string(),
            password: password.to_string(),
            device_name: "Alice's MacBook Pro".to_string(),
            device_platform: "macos".to_string(),
            device_arch: "aarch64".to_string(),
            device_public_key: "pk_dev_macos_a_base64".to_string(),
            invite_code: None,
        })
        .await
        .expect("register should succeed");
    let dev_a_id = register_resp.device_id.clone();
    client.set_device_id(&dev_a_id);

    let login_resp = client
        .login(LoginRequest {
            email: email.to_string(),
            password: password.to_string(),
            device: LoginDevicePayload {
                id: Some(dev_a_id.clone()),
                name: "Alice's MacBook Pro".to_string(),
                platform: "macos".to_string(),
                arch: "aarch64".to_string(),
                public_key: "pk_dev_macos_a_base64".to_string(),
                app_version: Some("1.0.0".to_string()),
            },
        })
        .await
        .expect("login should succeed");
    assert_eq!(login_resp.account_id, register_resp.account_id);
    client.set_access_token(&login_resp.access_token);

    // 3. Register Second Device (Device B)
    let dev_b = client
        .register_device(CreateDeviceRequest {
            id: Some("dev_windows_b".to_string()),
            name: "Alice's Workstation".to_string(),
            platform: "windows".to_string(),
            arch: "x86_64".to_string(),
            app_version: Some("1.0.0".to_string()),
            public_key: "pk_dev_b_base64".to_string(),
        })
        .await
        .expect("register dev_b");
    assert_eq!(dev_b.id, "dev_windows_b");

    let devices = client.list_devices().await.expect("list devices");
    assert_eq!(devices.len(), 2);

    // 4. Vault Init & Key Slot Management
    let kdf = KdfParamsDto {
        alg: "argon2id".to_string(),
        salt_b64: "c2FsdF9leGFtcGxlXzEyMzQ1Njc4OTA=".to_string(),
        mem_kib: 65536,
        time: 3,
        parallelism: 1,
    };

    let put_vault_req = PutVaultRequest {
        vault_id: "vault_01".to_string(),
        schema_version: 1,
        crypto_suite: "XChaCha20-Poly1305".to_string(),
        kdf: kdf.clone(),
        wrapped_key_b64: "ZW5jX2tleV9leGFtcGxl".to_string(),
        key_check_b64: "a2V5X2NoZWNrX2V4YW1wbGU=".to_string(),
        key_version: 1,
    };

    let vault_resp = client.put_vault(put_vault_req).await.expect("init vault");
    assert_eq!(vault_resp.vault_id, "vault_01");

    let fetched_vault = client.get_vault().await.expect("get vault");
    assert_eq!(fetched_vault.vault_id, vault_resp.vault_id);

    // Add recovery key slot (version 2)
    let add_slot_req = AddKeySlotRequest {
        key_version: 2,
        wrapped_key_b64: "cmVjb3Zlcnlfa2V5".to_string(),
        key_check_b64: "Y2hlY2tfcmVjb3Zlcnk=".to_string(),
        kdf: kdf.clone(),
    };
    client
        .add_key_slot(add_slot_req)
        .await
        .expect("add recovery key slot");

    let slots = client.list_key_slots().await.expect("list key slots");
    assert_eq!(slots.len(), 2);

    // 5. E2EE Sync: Device A encrypts and commits records
    let vault_key = VaultKey::random();

    let session_data = TestSession {
        name: "Production Gateway".to_string(),
        host: "gw.internal.corp".to_string(),
        port: 22,
        username: "ops-admin".to_string(),
    };
    let (s_cipher, s_checksum) =
        encrypt_entity_record(&vault_key, "session", "sess_01", 1, &session_data)
            .expect("encrypt session");

    let cred_data = TestCredential {
        username: "ops-admin".to_string(),
        auth_type: "ed25519_key".to_string(),
    };
    let (c_cipher, c_checksum) =
        encrypt_entity_record(&vault_key, "credential", "cred_01", 1, &cred_data)
            .expect("encrypt credential");

    let commit_items = vec![
        CommitChange {
            record_id: "sess_01".to_string(),
            base_version: Some(0),
            ciphertext_b64: s_cipher.clone(),
            checksum: s_checksum.clone(),
            deleted: false,
            client_updated_at: "2026-10-22T08:00:00Z".to_string(),
        },
        CommitChange {
            record_id: "cred_01".to_string(),
            base_version: Some(0),
            ciphertext_b64: c_cipher.clone(),
            checksum: c_checksum.clone(),
            deleted: false,
            client_updated_at: "2026-10-22T08:00:00Z".to_string(),
        },
    ];

    let commit_res = client
        .commit(CommitRequest {
            base_cursor: None,
            changes: commit_items,
        })
        .await
        .expect("commit should succeed");

    assert_eq!(commit_res.applied.len(), 2);
    assert!(commit_res.conflicts.is_empty());
    assert_eq!(commit_res.head_seq, 2);

    // 6. Device B Pulls and Decrypts Records
    let changes_resp = client
        .get_changes(0, Some(50))
        .await
        .expect("get changes for dev_b");
    assert_eq!(changes_resp.changes.len(), 2);

    let sess_change = changes_resp
        .changes
        .iter()
        .find(|c| c.record_id == "sess_01")
        .expect("sess_01 found");
    assert_eq!(sess_change.version, 1);
    assert_eq!(sess_change.ciphertext_b64, s_cipher);

    // Decrypt on Device B
    let decrypted_session: TestSession = decrypt_entity_record(
        &vault_key,
        "session",
        &sess_change.record_id,
        1,
        &sess_change.ciphertext_b64,
        &sess_change.checksum,
    )
    .expect("dev_b decrypt session");
    assert_eq!(decrypted_session, session_data);

    let cred_change = changes_resp
        .changes
        .iter()
        .find(|c| c.record_id == "cred_01")
        .expect("cred_01 found");
    let decrypted_cred: TestCredential = decrypt_entity_record(
        &vault_key,
        "credential",
        &cred_change.record_id,
        1,
        &cred_change.ciphertext_b64,
        &cred_change.checksum,
    )
    .expect("dev_b decrypt credential");
    assert_eq!(decrypted_cred, cred_data);

    // 7. Optimistic Lock Conflict Handling
    // Device B attempts to push a modification with base_version: 0 (server is already at v1)
    let stale_commit_items = vec![CommitChange {
        record_id: "sess_01".to_string(),
        base_version: Some(0), // stale!
        ciphertext_b64: s_cipher.clone(),
        checksum: s_checksum.clone(),
        deleted: false,
        client_updated_at: "2026-10-22T08:05:00Z".to_string(),
    }];

    let conflict_commit_res = client
        .commit(CommitRequest {
            base_cursor: None,
            changes: stale_commit_items,
        })
        .await
        .expect("commit with conflicts returns HTTP 200");

    assert_eq!(conflict_commit_res.applied.len(), 0);
    assert_eq!(conflict_commit_res.conflicts.len(), 1);
    let conflict = &conflict_commit_res.conflicts[0];
    assert_eq!(conflict.record_id, "sess_01");
    assert_eq!(conflict.server_version, 1);
    assert_eq!(conflict.server_ciphertext_b64, s_cipher);

    // 8. Snapshots & Rollback
    let snapshot_res = client
        .create_snapshot(CreateSnapshotRequest {
            snapshot_id: "snap_01".to_string(),
            label: "pre_upgrade_snapshot".to_string(),
            manifest: SnapshotManifestDto {
                record_count: 2,
                bytes: (s_cipher.len() + c_cipher.len()) as u64,
                checksum: "manifest_chk".to_string(),
            },
            records: vec![
                SnapshotRecordDto {
                    record_id: "sess_01".to_string(),
                    ciphertext_b64: s_cipher.clone(),
                    checksum: s_checksum.clone(),
                    deleted: false,
                },
                SnapshotRecordDto {
                    record_id: "cred_01".to_string(),
                    ciphertext_b64: c_cipher.clone(),
                    checksum: c_checksum.clone(),
                    deleted: false,
                },
            ],
        })
        .await
        .expect("create snapshot");
    assert_eq!(snapshot_res.label, "pre_upgrade_snapshot");
    assert_eq!(snapshot_res.record_count, 2);

    let snapshot_list = client.list_snapshots().await.expect("list snapshots");
    assert_eq!(snapshot_list.len(), 1);

    // Modify sess_01 to v2
    let session_v2 = TestSession {
        name: "Production Gateway (Renamed)".to_string(),
        host: "gw2.internal.corp".to_string(),
        port: 2222,
        username: "ops-admin".to_string(),
    };
    let (s2_cipher, s2_checksum) =
        encrypt_entity_record(&vault_key, "session", "sess_01", 1, &session_v2)
            .expect("encrypt session v2");

    let v2_commit = client
        .commit(CommitRequest {
            base_cursor: None,
            changes: vec![CommitChange {
                record_id: "sess_01".to_string(),
                base_version: Some(1),
                ciphertext_b64: s2_cipher.clone(),
                checksum: s2_checksum.clone(),
                deleted: false,
                client_updated_at: "2026-10-22T08:10:00Z".to_string(),
            }],
        })
        .await
        .expect("v2 commit");
    assert_eq!(v2_commit.applied.len(), 1);
    assert_eq!(v2_commit.applied[0].version, 2);

    // Now Rollback to snapshot
    let rollback_res = client
        .rollback_snapshot(RollbackRequest {
            snapshot_id: "snap_01".to_string(),
            expected_head_seq: 3,
            mode: "restore".to_string(),
            create_pre_restore_snapshot: true,
        })
        .await
        .expect("rollback snapshot");
    assert_eq!(rollback_res.restored_records, 1);

    // Verify record is restored to v1 ciphertext (with incremented seq/version)
    let head = client.get_sync_head().await.expect("get sync head");
    let after_rollback_changes = client
        .get_changes(head.head_seq - 1, Some(10))
        .await
        .expect("get changes after rollback");
    let rolled_back_sess = after_rollback_changes
        .changes
        .iter()
        .find(|c| c.record_id == "sess_01")
        .expect("sess_01 restored");
    assert_eq!(rolled_back_sess.ciphertext_b64, s_cipher);

    // 9. Update Distribution API & Rollout Bucketing
    // Insert an update manifest directly into SQLite
    let manifest_dto = UpdateManifest {
        manifest_version: 1,
        target: "windows-x86_64".to_string(),
        channel: "stable".to_string(),
        version: "1.0.0".to_string(),
        previous_version: None,
        min_supported_version: "0.1.0".to_string(),
        min_os: None,
        released_at: "2026-10-22T08:00:00Z".to_string(),
        mandatory: false,
        rollout: RolloutPolicy {
            percent: 100,
            seed: "seed_val".to_string(),
        },
        notes_url: None,
        artifacts: vec![ArtifactDto {
            id: "art_win_01".to_string(),
            kind: "binary".to_string(),
            url: "https://dl.example.com/openshell-setup.exe".to_string(),
            size: 42000000,
            sha256: "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b".to_string(),
            signature_b64: "c2lnbmF0dXJl".to_string(),
            signing_key_id: "key_01".to_string(),
        }],
        revoked_versions: vec![],
        rollback: None,
        signature_b64: "sig_outer".to_string(),
        signing_key_id: "key_01".to_string(),
    };
    let manifest_json = serde_json::to_string(&manifest_dto).unwrap();

    db_pool
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO update_manifest (target, channel, version, manifest_json, signature_b64, signing_key_id, published_at, revoked)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                [
                    "windows-x86_64",
                    "stable",
                    "1.0.0",
                    &manifest_json,
                    "c2ln",
                    "key_01",
                    "2026-10-22T08:00:00Z",
                ],
            )
            .unwrap();
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();

    // Query update from older version 0.9.0
    let update_req = client_http
        .get(format!("{}/updates/windows-x86_64/0.9.0", base_url))
        .header("X-OpenShell-Channel", "stable")
        .header("X-OpenShell-Install-Id", "install_node_01")
        .send()
        .await
        .expect("query update");
    assert_eq!(update_req.status(), reqwest::StatusCode::OK);
    let parsed_manifest: UpdateManifest = update_req.json().await.expect("parse manifest");
    assert_eq!(parsed_manifest.version, "1.0.0");

    // Query update when already on 1.0.0
    let already_updated = client_http
        .get(format!("{}/updates/windows-x86_64/1.0.0", base_url))
        .header("X-OpenShell-Channel", "stable")
        .send()
        .await
        .expect("query current update");
    assert_eq!(already_updated.status(), reqwest::StatusCode::NO_CONTENT);

    // 10. Relay Ticket Generation
    let ticket_req = RelayTicketRequest {
        dest_host: "127.0.0.1".to_string(),
        dest_port: 22,
        protocol: "tcp".to_string(),
        ttl_sec: 120,
        bytes_limit: 256 * 1024 * 1024,
    };
    let ticket_resp = client
        .create_relay_ticket(ticket_req)
        .await
        .expect("create relay ticket");
    assert!(!ticket_resp.ticket.is_empty());
    assert!(!ticket_resp.expires_at.is_empty());

    // 11. Revoke Device and verify access rejection
    client
        .revoke_device("dev_windows_b")
        .await
        .expect("revoke dev_windows_b");
    let dev_list_after_revoke = client.list_devices().await.expect("list devices");
    let b_device = dev_list_after_revoke
        .iter()
        .find(|d| d.id == "dev_windows_b")
        .unwrap();
    assert!(b_device.revoked_at.is_some());
}

#[tokio::test]
async fn test_single_user_bootstrap_and_login() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let db_path = temp_dir.path().join("single_user.db");

    let config = Config {
        database_url: db_path.to_str().unwrap().to_string(),
        sync_username: Some("admin".to_string()),
        sync_password: Some("secret123".to_string()),
        allow_multi_user: false,
        ..Config::default()
    };

    let db_pool = DbPool::open(&config.database_url).expect("db pool");
    openshell_server::bootstrap_single_user(&db_pool, &config).expect("bootstrap");

    let app_state = AppState::new(db_pool.clone(), config);
    let app = create_router(app_state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let local_addr = listener.local_addr().expect("local addr");
    let base_url = format!("http://{}", local_addr);

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let client = SyncClient::new(&base_url, "device_admin_1");
    let login_res = client
        .login(LoginRequest {
            email: "admin".to_string(),
            password: "secret123".to_string(),
            device: LoginDevicePayload {
                id: None,
                name: "Admin Laptop".to_string(),
                platform: "windows".to_string(),
                arch: "x86_64".to_string(),
                public_key: "pk_test".to_string(),
                app_version: Some("1.1.1".to_string()),
            },
        })
        .await;
    assert!(
        login_res.is_ok(),
        "single user login should succeed with username: {:?}",
        login_res.err()
    );

    // Registration should be rejected in single-user mode
    let reg_res = client
        .register(RegisterRequest {
            email: "another_user".to_string(),
            password: "password123".to_string(),
            device_name: "Attacker Device".to_string(),
            device_platform: "linux".to_string(),
            device_arch: "x86_64".to_string(),
            device_public_key: "pk_attacker".to_string(),
            invite_code: None,
        })
        .await;
    assert!(
        reg_res.is_err(),
        "registration should be rejected in single-user mode"
    );
}
