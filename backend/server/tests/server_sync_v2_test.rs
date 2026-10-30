use std::net::SocketAddr;

use openshell_server::{create_router, AppState, Config, DbPool};
use openshell_sync_client::{
    decrypt_entity_record, encrypt_entity_record, SyncClient, SyncClientError,
};
use openshell_sync_protocol::*;
use openshell_vault::VaultKey;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct TestSession {
    name: String,
    host: String,
}

async fn start_server() -> (String, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let database = temp_dir.path().join("sync-v2.db");
    let config = Config {
        database_url: database.to_string_lossy().into_owned(),
        artifacts_dir: temp_dir.path().join("artifacts"),
        ..Config::default()
    };
    let state = AppState::new(
        DbPool::open(&config.database_url).expect("database"),
        config,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        axum::serve(
            listener,
            create_router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("server");
    });
    (format!("http://{address}"), temp_dir)
}

async fn authenticated_client(base_url: &str) -> SyncClient {
    let mut client = SyncClient::new(base_url, "device-v2");
    let registration = client
        .register(RegisterRequest {
            email: "sync-v2@example.com".to_string(),
            password: "CorrectHorseBatteryStaple!42".to_string(),
            device_name: "v2 test client".to_string(),
            device_platform: "windows".to_string(),
            device_arch: "x86_64".to_string(),
            device_public_key: "test-public-key".to_string(),
            invite_code: None,
        })
        .await
        .expect("register");
    client.set_device_id(&registration.device_id);
    let login = client
        .login(LoginRequest {
            email: "sync-v2@example.com".to_string(),
            password: "CorrectHorseBatteryStaple!42".to_string(),
            device: LoginDevicePayload {
                id: Some(registration.device_id),
                name: "v2 test client".to_string(),
                platform: "windows".to_string(),
                arch: "x86_64".to_string(),
                public_key: "test-public-key".to_string(),
                app_version: Some("1.2.0".to_string()),
            },
        })
        .await
        .expect("login");
    client.set_access_token(login.access_token);
    client
        .put_vault(PutVaultRequest {
            vault_id: "vault-v2".to_string(),
            schema_version: SYNC_SCHEMA_VERSION_V2,
            crypto_suite: "XChaCha20-Poly1305".to_string(),
            kdf: KdfParamsDto {
                alg: "argon2id".to_string(),
                salt_b64: "dGVzdC1zYWx0".to_string(),
                mem_kib: 65_536,
                time: 3,
                parallelism: 1,
            },
            wrapped_key_b64: "d3JhcHBlZC1rZXk=".to_string(),
            key_check_b64: "a2V5LWNoZWNr".to_string(),
            key_version: 1,
        })
        .await
        .expect("vault");
    client
}

async fn additional_client(base_url: &str, device_id: &str) -> SyncClient {
    let mut client = SyncClient::new(base_url, device_id);
    let login = client
        .login(LoginRequest {
            email: "sync-v2@example.com".to_string(),
            password: "CorrectHorseBatteryStaple!42".to_string(),
            device: LoginDevicePayload {
                id: Some(device_id.to_string()),
                name: "v2 second test client".to_string(),
                platform: "linux".to_string(),
                arch: "x86_64".to_string(),
                public_key: "second-test-public-key".to_string(),
                app_version: Some("1.2.0".to_string()),
            },
        })
        .await
        .expect("login second device");
    client.set_device_id(login.device_id);
    client.set_access_token(login.access_token);
    client
}

#[tokio::test]
async fn v2_sync_preserves_metadata_conflicts_and_tombstones() {
    let (base_url, _temp_dir) = start_server().await;
    let client = authenticated_client(&base_url).await;
    let vault_key = VaultKey::random();
    let record = TestSession {
        name: "Production".to_string(),
        host: "prod.example.test".to_string(),
    };
    let (ciphertext, checksum) =
        encrypt_entity_record(&vault_key, "session", "session-1", 1, &record)
            .expect("encrypt record");

    let create_request = CommitRequestV2 {
        schema_version: SYNC_SCHEMA_VERSION_V2,
        base_cursor: None,
        changes: vec![CommitChangeV2 {
            record_id: "session-1".to_string(),
            record_type: "session".to_string(),
            schema_version: SYNC_SCHEMA_VERSION_V2,
            key_version: 1,
            base_revision: None,
            revision: 1,
            ciphertext_b64: ciphertext.clone(),
            checksum: checksum.clone(),
            deleted: false,
            updated_at: "2026-10-29T09:00:00Z".to_string(),
            device_id: client.device_id.clone(),
        }],
    };
    let committed = client
        .commit_v2_with_idempotency_key(create_request.clone(), "create-session-1")
        .await
        .expect("commit v2 record");
    assert_eq!(committed.applied[0].revision, 1);
    let repeated = client
        .commit_v2_with_idempotency_key(create_request.clone(), "create-session-1")
        .await
        .expect("repeat idempotent commit");
    assert_eq!(repeated, committed);

    let mut reused_key_request = create_request;
    reused_key_request.changes[0].updated_at = "2026-10-29T09:01:00Z".to_string();
    let reused_key_error = client
        .commit_v2_with_idempotency_key(reused_key_request, "create-session-1")
        .await
        .expect_err("same key with a different body must fail");
    assert!(matches!(
        reused_key_error,
        SyncClientError::Api {
            code: ApiErrorCode::IdempotencyKeyReused,
            status: 409,
            ..
        }
    ));

    let pulled = client.get_changes_v2(0, Some(10)).await.expect("pull v2");
    assert_eq!(pulled.changes.len(), 1);
    let change = &pulled.changes[0];
    assert_eq!(change.record_type, "session");
    assert_eq!(change.schema_version, SYNC_SCHEMA_VERSION_V2);
    assert_eq!(change.revision, 1);
    assert_eq!(change.updated_at, "2026-10-29T09:00:00Z");
    let decrypted: TestSession = decrypt_entity_record(
        &vault_key,
        &change.record_type,
        &change.record_id,
        change.key_version as i64,
        &change.ciphertext_b64,
        &change.checksum,
    )
    .expect("decrypt pulled record");
    assert_eq!(decrypted, record);

    let second_client = additional_client(&base_url, "device-v2-b").await;
    let updated_record = TestSession {
        name: "Production A".to_string(),
        host: "prod-a.example.test".to_string(),
    };
    let (updated_ciphertext, updated_checksum) =
        encrypt_entity_record(&vault_key, "session", "session-1", 1, &updated_record)
            .expect("encrypt first concurrent update");
    let updated = client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: Some(pulled.next_cursor),
            changes: vec![CommitChangeV2 {
                record_id: "session-1".to_string(),
                record_type: "session".to_string(),
                schema_version: SYNC_SCHEMA_VERSION_V2,
                key_version: 1,
                base_revision: Some(1),
                revision: 2,
                ciphertext_b64: updated_ciphertext,
                checksum: updated_checksum,
                deleted: false,
                updated_at: "2026-10-29T10:00:00Z".to_string(),
                device_id: client.device_id.clone(),
            }],
        })
        .await
        .expect("commit first concurrent update");
    assert_eq!(updated.applied[0].revision, 2);

    let stale_record = TestSession {
        name: "Production B".to_string(),
        host: "prod-b.example.test".to_string(),
    };
    let (stale_ciphertext, stale_checksum) =
        encrypt_entity_record(&vault_key, "session", "session-1", 1, &stale_record)
            .expect("encrypt stale concurrent update");
    let stale = second_client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: Some(pulled.next_cursor),
            changes: vec![CommitChangeV2 {
                record_id: "session-1".to_string(),
                record_type: "session".to_string(),
                schema_version: SYNC_SCHEMA_VERSION_V2,
                key_version: 1,
                base_revision: Some(1),
                revision: 2,
                ciphertext_b64: stale_ciphertext,
                checksum: stale_checksum,
                deleted: false,
                updated_at: "2026-10-29T11:00:00Z".to_string(),
                device_id: second_client.device_id.clone(),
            }],
        })
        .await
        .expect("stale commit returns conflict response");
    assert!(stale.applied.is_empty());
    assert_eq!(stale.conflicts[0].server_revision, 2);
    assert_eq!(stale.conflicts[0].server_updated_at, "2026-10-29T10:00:00Z");
    assert!(!stale.conflicts[0].server_deleted);

    let deleted = client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: Some(pulled.next_cursor),
            changes: vec![CommitChangeV2 {
                record_id: "session-1".to_string(),
                record_type: "session".to_string(),
                schema_version: SYNC_SCHEMA_VERSION_V2,
                key_version: 1,
                base_revision: Some(2),
                revision: 3,
                ciphertext_b64: String::new(),
                checksum: String::new(),
                deleted: true,
                updated_at: "2026-10-29T11:00:00Z".to_string(),
                device_id: client.device_id.clone(),
            }],
        })
        .await
        .expect("commit tombstone");
    let tombstones = client
        .get_changes_v2(deleted.applied[0].seq - 1, Some(10))
        .await
        .expect("pull tombstone");
    assert!(tombstones.changes[0].deleted);
    assert_eq!(tombstones.changes[0].revision, 3);

    let resurrected_record = TestSession {
        name: "Stale resurrection".to_string(),
        host: "stale.example.test".to_string(),
    };
    let (resurrected_ciphertext, resurrected_checksum) = encrypt_entity_record(
        &vault_key,
        "session",
        "session-1",
        1,
        &resurrected_record,
    )
    .expect("encrypt stale resurrection");
    let tombstone_conflict = second_client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: Some(updated.new_cursor),
            changes: vec![CommitChangeV2 {
                record_id: "session-1".to_string(),
                record_type: "session".to_string(),
                schema_version: SYNC_SCHEMA_VERSION_V2,
                key_version: 1,
                base_revision: Some(2),
                revision: 3,
                ciphertext_b64: resurrected_ciphertext,
                checksum: resurrected_checksum,
                deleted: false,
                updated_at: "2026-10-29T12:00:00Z".to_string(),
                device_id: second_client.device_id.clone(),
            }],
        })
        .await
        .expect("stale resurrection returns conflict");
    assert!(tombstone_conflict.conflicts[0].server_deleted);
    assert!(tombstone_conflict.conflicts[0].server_deleted_at.is_some());
}

#[tokio::test]
async fn v2_rejects_unsupported_schema_version() {
    let (base_url, _temp_dir) = start_server().await;
    let client = authenticated_client(&base_url).await;
    let error = client
        .commit_v2(CommitRequestV2 {
            schema_version: 999,
            base_cursor: None,
            changes: Vec::new(),
        })
        .await
        .expect_err("unsupported schema must fail");
    assert!(matches!(
        error,
        SyncClientError::Api {
            code: ApiErrorCode::UpgradeRequired,
            status: 426,
            ..
        }
    ));

    let cursor_error = client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: Some(1),
            changes: Vec::new(),
        })
        .await
        .expect_err("cursor ahead of the server must fail");
    assert!(matches!(
        cursor_error,
        SyncClientError::Api {
            code: ApiErrorCode::SyncConflict,
            status: 409,
            ..
        }
    ));
}

#[tokio::test]
async fn v1_client_cannot_overwrite_a_v2_record() {
    let (base_url, _temp_dir) = start_server().await;
    let client = authenticated_client(&base_url).await;
    let vault_key = VaultKey::random();
    let record = TestSession {
        name: "v2 record".to_string(),
        host: "v2.example.test".to_string(),
    };
    let (ciphertext, checksum) =
        encrypt_entity_record(&vault_key, "session", "protected-v2", 1, &record)
            .expect("encrypt v2 record");
    client
        .commit_v2(CommitRequestV2 {
            schema_version: SYNC_SCHEMA_VERSION_V2,
            base_cursor: None,
            changes: vec![CommitChangeV2 {
                record_id: "protected-v2".to_string(),
                record_type: "session".to_string(),
                schema_version: SYNC_SCHEMA_VERSION_V2,
                key_version: 1,
                base_revision: None,
                revision: 1,
                ciphertext_b64: ciphertext.clone(),
                checksum: checksum.clone(),
                deleted: false,
                updated_at: "2026-10-29T09:00:00Z".to_string(),
                device_id: client.device_id.clone(),
            }],
        })
        .await
        .expect("create protected v2 record");

    let error = client
        .commit(CommitRequest {
            base_cursor: Some(1),
            changes: vec![CommitChange {
                record_id: "protected-v2".to_string(),
                base_version: Some(1),
                ciphertext_b64: ciphertext,
                checksum,
                deleted: false,
                client_updated_at: "2026-10-29T10:00:00Z".to_string(),
            }],
        })
        .await
        .expect_err("v1 must not overwrite v2 data");
    assert!(matches!(
        error,
        SyncClientError::Api {
            code: ApiErrorCode::UpgradeRequired,
            status: 426,
            ..
        }
    ));
}
