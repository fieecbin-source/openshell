use openshell_app_core::{
    sync_codec::{self, ConflictBackupInput, LocalSyncRecord},
    AppServices,
};
use openshell_core_domain::*;

async fn session() -> (AppServices, Session, LocalSyncRecord) {
    let app = AppServices::new_in_memory().unwrap();
    let session = app
        .session
        .create_session(SessionInput {
            name: Some("local-original".into()),
            host: Some("test.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let record = sync_codec::collect_dirty_records(&app.store)
        .unwrap()
        .into_iter()
        .find(|record| record.record_id == session.id.as_str())
        .unwrap();
    (app, session, record)
}
fn conflict(record: &LocalSyncRecord) -> ConflictBackupInput {
    ConflictBackupInput {
        record_id: record.record_id.clone(),
        record_type: record.record_type,
        local_snapshot: Some(serde_json::to_value(record).unwrap()),
        remote_ciphertext_b64: String::new(),
        remote_checksum: String::new(),
        remote_revision: 2,
        remote_device_id: None,
        remote_deleted: false,
        remote_updated_at: 2,
    }
}

#[tokio::test]
async fn conflict_snapshot_failure_does_not_overwrite_dirty_local_data() {
    let (app, session, local) = session().await;
    let mut remote = local.clone();
    remote.payload["name"] = serde_json::json!("remote");
    remote.revision = 2;
    app.store.with_conn(|conn| { conn.execute_batch("CREATE TRIGGER reject_conflict BEFORE INSERT ON sync_conflict BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").unwrap();Ok(()) }).unwrap();
    assert!(sync_codec::apply_remote_records_with_conflicts(
        &app.store,
        &[remote.clone()],
        vec![conflict(&local)]
    )
    .is_err());
    assert_eq!(
        app.session.get_session(&session.id).await.unwrap().name,
        "local-original"
    );
    assert!(app.sync.list_conflicts().unwrap().is_empty());
    app.store
        .with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER reject_conflict").unwrap();
            Ok(())
        })
        .unwrap();
    sync_codec::apply_remote_records_with_conflicts(&app.store, &[remote], vec![conflict(&local)])
        .unwrap();
    assert_eq!(app.sync.list_conflicts().unwrap().len(), 1);
}

#[tokio::test]
async fn push_conflict_captures_edits_made_after_the_upload_snapshot() {
    let (app, session, sent) = session().await;
    app.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("edited-during-upload".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let id = sync_codec::backup_conflict(&app.store, conflict(&sent)).unwrap();
    let json: String = app
        .store
        .with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT local_snapshot_json FROM sync_conflict WHERE id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    let snapshot: LocalSyncRecord = serde_json::from_str(&json).unwrap();
    assert_eq!(snapshot.payload["name"], "edited-during-upload");
    sync_codec::resolve_conflict_record(&app.store, &id, true, &snapshot).unwrap();
    assert_eq!(
        app.session.get_session(&session.id).await.unwrap().name,
        "edited-during-upload"
    );
}

#[tokio::test]
async fn pull_retries_if_an_unidentified_local_edit_appears_before_apply() {
    let (app, session, mut remote) = session().await;
    remote.payload["name"] = serde_json::json!("remote");
    remote.revision = 2;
    assert!(
        sync_codec::apply_remote_records_with_conflicts(&app.store, &[remote], Vec::new()).is_err()
    );
    assert_eq!(
        app.session.get_session(&session.id).await.unwrap().name,
        "local-original"
    );
}

#[tokio::test]
async fn upload_acknowledgement_preserves_edits_made_after_its_clean_scan() {
    let (app, session, sent) = session().await;
    app.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("edited-before-clean-commit".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    sync_codec::mark_uploaded_records(
        &app.store,
        &[sync_codec::AppliedSyncRecord {
            record_id: sent.record_id.clone(),
            record_type: sent.record_type,
            revision: 2,
            key_version: 1,
            checksum: None,
            deleted: false,
        }],
        &[sent],
    )
    .unwrap();
    let dirty = sync_codec::collect_dirty_records(&app.store).unwrap();
    let record = dirty
        .iter()
        .find(|record| record.record_id == session.id.as_str())
        .unwrap();
    assert_eq!(record.payload["name"], "edited-before-clean-commit");
}

#[tokio::test]
async fn resolving_a_conflict_does_not_overwrite_a_later_local_edit() {
    let (app, session, local) = session().await;
    let mut remote = local.clone();
    remote.payload["name"] = serde_json::json!("remote");
    remote.revision = 2;
    sync_codec::apply_remote_records_with_conflicts(&app.store, &[remote], vec![conflict(&local)])
        .unwrap();
    let id = app.sync.list_conflicts().unwrap()[0].id.clone();
    app.session
        .update_session(
            &session.id,
            SessionPatch {
                name: Some("later-local-edit".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert!(sync_codec::resolve_conflict_record(&app.store, &id, true, &local).is_err());
    assert_eq!(
        app.session.get_session(&session.id).await.unwrap().name,
        "later-local-edit"
    );
    assert_eq!(app.sync.list_conflicts().unwrap().len(), 1);
}

#[tokio::test]
async fn restoring_a_session_requires_the_private_key_passphrase_secret() {
    let (app, session, mut record) = session().await;
    let key = SshKeyId::new();
    let secret = SecretId::new();
    let credential = CredentialId::new();
    let passphrase = SecretId::new();
    app.store.with_conn(|conn| {
        for id in [&secret,&passphrase] { conn.execute("INSERT INTO secret(id,record_type,ciphertext,nonce,aad,crypto_suite,key_version,created_at,updated_at) VALUES(?1,'synthetic',X'01',X'01',X'01','synthetic',1,1,1)",[id.as_str()]).unwrap(); }
        conn.execute("INSERT INTO credential(id,name,kind,secret_id,save_policy,created_at,updated_at) VALUES(?1,'passphrase','password',?2,'vault',1,1)",rusqlite::params![credential.as_str(),passphrase.as_str()]).unwrap();
        conn.execute("INSERT INTO ssh_key(id,name,algorithm,public_key,fingerprint_sha256,secret_id,passphrase_credential_id,has_passphrase,created_at,updated_at) VALUES(?1,'key','ed25519','synthetic','synthetic-fingerprint',?2,?3,1,1,1)",rusqlite::params![key.as_str(),secret.as_str(),credential.as_str()]).unwrap();
        conn.execute("UPDATE secret SET deleted_at=1 WHERE id=?1",[passphrase.as_str()]).unwrap();Ok(())
    }).unwrap();
    record.payload["ssh_key_id"] = serde_json::json!(key);
    let id = sync_codec::backup_conflict(&app.store, conflict(&record)).unwrap();
    assert!(sync_codec::resolve_conflict_record(&app.store, &id, true, &record).is_err());
    assert_eq!(app.sync.list_conflicts().unwrap().len(), 1);
    assert!(app
        .session
        .get_session(&session.id)
        .await
        .unwrap()
        .ssh_key_id
        .is_none());
}
