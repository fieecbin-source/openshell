use openshell_app_core::{archive_service::ArchiveService, AppServices};
use openshell_core_domain::*;
use openshell_importer::ConflictStrategy;

fn archive(app: &AppServices) -> ArchiveService {
    ArchiveService::new(app.store.clone(), app.vault.manager().clone())
}

#[tokio::test]
async fn repeated_json_archive_import_respects_existing_group_paths_for_all_strategies() {
    let source = AppServices::new_in_memory().unwrap();
    let group = source
        .session
        .create_group(None, "Servers".into(), GroupKind::Session)
        .await
        .unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("repeat.invalid".into()),
            group_id: Some(group.id),
            ..Default::default()
        })
        .await
        .unwrap();
    let json = archive(&source).export_json().await.unwrap();
    for strategy in [
        ConflictStrategy::Skip,
        ConflictStrategy::Overwrite,
        ConflictStrategy::KeepBoth,
    ] {
        let target = AppServices::new_in_memory().unwrap();
        let importer = archive(&target);
        target
            .session
            .create_group(None, "servers".into(), GroupKind::Session)
            .await
            .unwrap();
        for _ in 0..2 {
            let preview = importer.preview_json(&json, strategy).await.unwrap();
            importer
                .commit(
                    &preview.candidates,
                    preview.archive_token.as_deref().unwrap(),
                )
                .unwrap();
        }
        let count = if matches!(strategy, ConflictStrategy::KeepBoth) {
            2
        } else {
            1
        };
        let groups = if matches!(strategy, ConflictStrategy::KeepBoth) {
            3
        } else {
            1
        };
        assert_eq!(
            target
                .session
                .list_groups(GroupKind::Session)
                .await
                .unwrap()
                .len(),
            groups
        );
        assert_eq!(
            target
                .session
                .list_sessions(&SessionQuery::default())
                .await
                .unwrap()
                .len(),
            count
        );
    }
}

#[tokio::test]
async fn json_restores_groups_sessions_snippets_rules_and_clears_missing_credentials() {
    let source = AppServices::new_in_memory().unwrap();
    source.vault.init("source-master", false, None).unwrap();
    let group = source
        .session
        .create_group(None, "servers".into(), GroupKind::Session)
        .await
        .unwrap();
    let snippet_group = source
        .session
        .create_group(None, "commands".into(), GroupKind::Snippet)
        .await
        .unwrap();
    let credential = source
        .session
        .create_credential(
            "password".into(),
            CredentialKind::Password,
            None,
            "synthetic-archive-password",
            None,
            None,
        )
        .await
        .unwrap();
    let session = source
        .session
        .create_session(SessionInput {
            name: Some("archived".into()),
            host: Some("test.invalid".into()),
            group_id: Some(group.id),
            credential_id: Some(credential.id),
            ..Default::default()
        })
        .await
        .unwrap();
    source
        .snippet_repo
        .create(SnippetInput {
            name: "command".into(),
            group_id: Some(snippet_group.id),
            body: Some("echo 你好\necho ${name}".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    source
        .port_forward_repo
        .create(PortForwardRuleInput {
            name: "rule".into(),
            session_id: Some(session.id),
            bind_port: 8080,
            dest_host: Some("127.0.0.1".into()),
            dest_port: Some(80),
            ..Default::default()
        })
        .await
        .unwrap();
    let json = archive(&source).export_json().await.unwrap();
    assert!(!json.contains("synthetic-archive-password"));
    let target = AppServices::new_in_memory().unwrap();
    let importer = archive(&target);
    let preview = importer
        .preview_json(&json, ConflictStrategy::Skip)
        .await
        .unwrap();
    assert!(!preview.warnings.is_empty());
    let token = preview.archive_token.unwrap();
    assert_eq!(importer.commit(&preview.candidates, &token).unwrap(), 1);
    assert!(importer.commit(&preview.candidates, &token).is_err());
    assert_eq!(
        target
            .session
            .list_groups(GroupKind::Session)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        target
            .session
            .list_groups(GroupKind::Snippet)
            .await
            .unwrap()
            .len(),
        1
    );
    let restored = target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap();
    assert!(restored[0].credential_id.is_none());
    assert_eq!(
        target.snippet_repo.list(None).await.unwrap()[0]
            .body
            .as_deref(),
        Some("echo 你好\necho ${name}")
    );
    assert_eq!(
        target.port_forward_repo.list(None).await.unwrap()[0]
            .session_id
            .as_ref(),
        Some(&restored[0].id)
    );
}

#[tokio::test]
async fn encrypted_archive_rekeys_passwords_and_locked_commit_is_retryable() {
    let source = AppServices::new_in_memory().unwrap();
    source.vault.init("source-master", false, None).unwrap();
    let password = format!("synthetic-{}", SecretId::new());
    let credential = source
        .session
        .create_credential(
            "password".into(),
            CredentialKind::Password,
            None,
            &password,
            None,
            None,
        )
        .await
        .unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("test.invalid".into()),
            credential_id: Some(credential.id),
            ..Default::default()
        })
        .await
        .unwrap();
    let bytes = archive(&source)
        .export_encrypted("archive-master")
        .await
        .unwrap();
    assert!(!bytes
        .windows(password.len())
        .any(|b| b == password.as_bytes()));
    let target = AppServices::new_in_memory().unwrap();
    target
        .vault
        .init("different-target-master", false, None)
        .unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_encrypted(&bytes, "archive-master", ConflictStrategy::Skip)
        .await
        .unwrap();
    let token = report.archive_token.unwrap();
    target.vault.lock().unwrap();
    assert!(importer.commit(&report.candidates, &token).is_err());
    assert!(target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .is_empty());
    target
        .vault
        .unlock(Some("different-target-master"), false)
        .unwrap();
    importer.commit(&report.candidates, &token).unwrap();
    let session = target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .remove(0);
    let credential = target
        .session
        .get_credential(&session.credential_id.unwrap())
        .await
        .unwrap();
    let secret = openshell_store::SecretRepo::new(target.store.clone())
        .get(&credential.secret_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        target.vault.manager().decrypt_secret(&secret).unwrap(),
        password.as_bytes()
    );
}

#[tokio::test]
async fn changed_candidates_and_discarded_tokens_cannot_commit() {
    let source = AppServices::new_in_memory().unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("test.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let json = archive(&source).export_json().await.unwrap();
    let target = AppServices::new_in_memory().unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_json(&json, ConflictStrategy::Skip)
        .await
        .unwrap();
    let token = report.archive_token.unwrap();
    let mut changed = report.candidates.clone();
    changed[0].input.host = Some("unexpected.invalid".into());
    assert!(importer.commit(&changed, &token).is_err());
    importer.discard(&token);
    assert!(importer.commit(&report.candidates, &token).is_err());
    assert!(target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn snippet_body_and_macro_settings_survive_create_update_and_read() {
    let app = AppServices::new_in_memory().unwrap();
    let input: SnippetInput = serde_json::from_value(serde_json::json!({"name":"multi", "kind":"snippet", "body":"echo ${name}\\necho done", "send_mode":"execute", "variables_json":[{"name":"name"}]})).unwrap();
    let snippet = app.snippet_repo.create(input.clone()).await.unwrap();
    let mut edited = input;
    edited.body = Some("echo edited".into());
    edited.kind = Some(SnippetKind::Macro);
    edited.macro_steps_json = Some(serde_json::json!([{"command":"pwd"}]));
    app.snippet_repo.update(&snippet.id, edited).await.unwrap();
    let stored = app.snippet_repo.list(None).await.unwrap().remove(0);
    assert_eq!(stored.body.as_deref(), Some("echo edited"));
    assert_eq!(stored.kind, SnippetKind::Macro);
    assert_eq!(stored.send_mode, SendMode::Execute);
    assert_eq!(
        stored.macro_steps_json,
        Some(serde_json::json!([{"command":"pwd"}]))
    );
}

#[tokio::test]
async fn keep_both_commit_uses_the_previewed_copy_name() {
    let source = AppServices::new_in_memory().unwrap();
    source
        .session
        .create_session(SessionInput {
            name: Some("same".into()),
            host: Some("same.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let json = archive(&source).export_json().await.unwrap();
    let target = AppServices::new_in_memory().unwrap();
    target
        .session
        .create_session(SessionInput {
            name: Some("same".into()),
            host: Some("same.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_json(&json, ConflictStrategy::KeepBoth)
        .await
        .unwrap();
    let expected = report.candidates[0].input.name.clone().unwrap();
    assert_ne!(expected, "same");
    importer
        .commit(&report.candidates, &report.archive_token.unwrap())
        .unwrap();
    let sessions = target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap();
    assert!(sessions.iter().any(|session| session.name == expected));
}

#[tokio::test]
async fn skipped_existing_session_is_revalidated_before_restoring_dependents() {
    let source = AppServices::new_in_memory().unwrap();
    let original = source
        .session
        .create_session(SessionInput {
            name: Some("same".into()),
            host: Some("same.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    source
        .port_forward_repo
        .create(PortForwardRuleInput {
            name: "rule".into(),
            session_id: Some(original.id),
            bind_port: 8080,
            dest_host: Some("127.0.0.1".into()),
            dest_port: Some(80),
            ..Default::default()
        })
        .await
        .unwrap();
    let target = AppServices::new_in_memory().unwrap();
    let existing = target
        .session
        .create_session(SessionInput {
            name: Some("same".into()),
            host: Some("same.invalid".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_json(
            &archive(&source).export_json().await.unwrap(),
            ConflictStrategy::Skip,
        )
        .await
        .unwrap();
    target
        .store
        .with_conn(|conn| {
            conn.execute(
                "UPDATE session SET deleted_at=1 WHERE id=?1",
                [existing.id.as_str()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(importer
        .commit(&report.candidates, &report.archive_token.unwrap())
        .is_err());
    assert!(target
        .port_forward_repo
        .list(None)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn late_proxy_failure_rolls_back_entities_and_secrets_and_token_can_retry() {
    let source = AppServices::new_in_memory().unwrap();
    source.vault.init("source-master", false, None).unwrap();
    let group = source
        .session
        .create_group(None, "group".into(), GroupKind::Session)
        .await
        .unwrap();
    let credential = source
        .session
        .create_credential(
            "password".into(),
            CredentialKind::Password,
            None,
            "synthetic-rollback-password",
            None,
            None,
        )
        .await
        .unwrap();
    source.network_secrets.save_proxies(vec![serde_json::from_value(serde_json::json!({"id":"proxy","name":"proxy","proxy_type":"socks5","host":"127.0.0.1","port":1080,"password":"synthetic-proxy-password"})).unwrap()]).unwrap();
    let rule = source
        .network_secrets
        .prepare_forward(
            PortForwardRuleInput {
                name: "socks".into(),
                rule_type: Some(PortForwardType::Dynamic),
                bind_port: 1081,
                socks_auth: Some(SocksAuth::Userpass),
                socks_username: Some("test".into()),
                socks_password: Some("synthetic-socks-password".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    source.port_forward_repo.create(rule).await.unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("test.invalid".into()),
            group_id: Some(group.id),
            credential_id: Some(credential.id),
            proxy_id: Some("proxy".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let bytes = archive(&source)
        .export_encrypted("archive-master")
        .await
        .unwrap();
    let target = AppServices::new_in_memory().unwrap();
    target.vault.init("target-master", false, None).unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_encrypted(&bytes, "archive-master", ConflictStrategy::Skip)
        .await
        .unwrap();
    let token = report.archive_token.unwrap();
    target
        .settings_repo
        .set(
            "global",
            None,
            "proxy_list",
            serde_json::json!([{"password":"synthetic-legacy-password"}]),
            false,
        )
        .unwrap();
    assert!(importer.commit(&report.candidates, &token).is_err());
    target
        .store
        .with_conn(|conn| {
            for table in [
                "session",
                "session_group",
                "credential",
                "secret",
                "port_forward",
            ] {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0, "rollback {table}");
            }
            Ok(())
        })
        .unwrap();
    target
        .settings_repo
        .set("global", None, "proxy_list", serde_json::json!([]), false)
        .unwrap();
    importer.commit(&report.candidates, &token).unwrap();
    let restored = target
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap();
    let proxy = target.network_secrets.proxies().unwrap().remove(0);
    assert_eq!(restored[0].proxy_id.as_deref(), Some(proxy.id.as_str()));
    assert_eq!(
        target
            .network_secrets
            .runtime_proxy(proxy)
            .unwrap()
            .password
            .as_deref(),
        Some("synthetic-proxy-password")
    );
    let socks = target
        .network_secrets
        .forwards(None)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        target
            .network_secrets
            .resolve(
                socks.socks_password_ref.as_deref().unwrap(),
                "socks_password"
            )
            .unwrap()
            .as_str(),
        "synthetic-socks-password"
    );
}

#[tokio::test]
async fn new_encrypted_archive_rejects_missing_dependencies_but_legacy_warns() {
    use openshell_vault::{
        kdf::KdfParams,
        package::{open_package, seal_package},
    };
    let source = AppServices::new_in_memory().unwrap();
    source.vault.init("source-master", false, None).unwrap();
    let credential = source
        .session
        .create_credential(
            "password".into(),
            CredentialKind::Password,
            None,
            "synthetic-password",
            None,
            None,
        )
        .await
        .unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("test.invalid".into()),
            credential_id: Some(credential.id),
            ..Default::default()
        })
        .await
        .unwrap();
    let bytes = archive(&source)
        .export_encrypted("archive-master")
        .await
        .unwrap();
    let mut value: serde_json::Value =
        serde_json::from_slice(&open_package("archive-master", &bytes).unwrap()).unwrap();
    value["credentials"] = serde_json::json!([]);
    value["secrets"] = serde_json::json!([]);
    let broken = seal_package(
        "archive-master",
        &serde_json::to_vec(&value).unwrap(),
        KdfParams::default(),
    )
    .unwrap();
    let target = AppServices::new_in_memory().unwrap();
    let importer = archive(&target);
    assert!(importer
        .preview_encrypted(&broken, "archive-master", ConflictStrategy::Skip)
        .await
        .is_err());
    value.as_object_mut().unwrap().remove("recovery_version");
    let legacy = seal_package(
        "archive-master",
        &serde_json::to_vec(&value).unwrap(),
        KdfParams::default(),
    )
    .unwrap();
    let report = importer
        .preview_encrypted(&legacy, "archive-master", ConflictStrategy::Skip)
        .await
        .unwrap();
    assert!(!report.warnings.is_empty());
    assert!(report.candidates[0].input.credential_id.is_none());
}

#[tokio::test]
async fn encrypted_archive_restores_private_key_and_its_passphrase_in_new_vault() {
    use openshell_ssh::russh::keys::{self, ssh_key, PrivateKey};
    let source = AppServices::new_in_memory().unwrap();
    source.vault.init("source-master", false, None).unwrap();
    let key = PrivateKey::new(
        ssh_key::private::Ed25519Keypair::from_seed(&[9; 32]).into(),
        "archive fixture",
    )
    .unwrap();
    let pem = key
        .encrypt(&mut keys::key::safe_rng(), "synthetic-key-passphrase")
        .unwrap()
        .to_openssh(ssh_key::LineEnding::LF)
        .unwrap();
    let original = source
        .session
        .import_ssh_key(
            "key".into(),
            &pem,
            Some("synthetic-key-passphrase".into()),
            None,
        )
        .await
        .unwrap();
    source
        .session
        .create_session(SessionInput {
            host: Some("key.invalid".into()),
            auth_method: Some(AuthMethod::PublicKey),
            ssh_key_id: Some(original.id),
            ..Default::default()
        })
        .await
        .unwrap();
    let bytes = archive(&source)
        .export_encrypted("archive-master")
        .await
        .unwrap();
    let target = AppServices::new_in_memory().unwrap();
    target.vault.init("target-master", false, None).unwrap();
    let importer = archive(&target);
    let report = importer
        .preview_encrypted(&bytes, "archive-master", ConflictStrategy::Skip)
        .await
        .unwrap();
    importer
        .commit(&report.candidates, &report.archive_token.unwrap())
        .unwrap();
    let restored = target.session.list_ssh_keys().await.unwrap().remove(0);
    assert_eq!(restored.fingerprint_sha256, original.fingerprint_sha256);
    let pass = target
        .session
        .get_credential(&restored.passphrase_credential_id.unwrap())
        .await
        .unwrap();
    let repo = openshell_store::SecretRepo::new(target.store.clone());
    let pass = target
        .vault
        .manager()
        .decrypt_secret(&repo.get(&pass.secret_id).unwrap().unwrap())
        .unwrap();
    let pem = target
        .vault
        .manager()
        .decrypt_secret(&repo.get(&restored.secret_id).unwrap().unwrap())
        .unwrap();
    let decoded = keys::decode_secret_key(
        std::str::from_utf8(&pem).unwrap(),
        Some(std::str::from_utf8(&pass).unwrap()),
    )
    .unwrap();
    assert_eq!(decoded.public_key(), key.public_key());
    for strategy in [
        ConflictStrategy::Skip,
        ConflictStrategy::Overwrite,
        ConflictStrategy::KeepBoth,
    ] {
        let report = importer
            .preview_encrypted(&bytes, "archive-master", strategy)
            .await
            .unwrap();
        importer
            .commit(&report.candidates, report.archive_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(target.session.list_ssh_keys().await.unwrap().len(), 1);
    }
}
