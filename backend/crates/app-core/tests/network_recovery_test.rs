use openshell_app_core::{AppServices, APP_VERSION};
use openshell_core_domain::{AppPaths, PortForwardId, SecretId};
use openshell_store::{backup, SecretRepo, SettingsRepo, Store, VaultRepo};
use openshell_vault::KdfParams;

const MASTER: &str = "synthetic-recovery-master";

#[tokio::test]
async fn pre_marker_missing_references_are_never_reencrypted_on_startup_or_recovery() {
    use openshell_core_domain::{PortForwardRepository, PortForwardRuleInput};

    for tombstone in [false, true] {
        for mixed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let app = AppServices::new(dir.path().to_path_buf()).unwrap();
            app.vault
                .init(
                    MASTER,
                    false,
                    Some(KdfParams {
                        mem_kib: 1024,
                        time: 1,
                        parallelism: 1,
                    }),
                )
                .unwrap();
            let input = app
                .network_secrets
                .prepare_forward(
                    PortForwardRuleInput {
                        name: "pre-marker".into(),
                        bind_port: 1080,
                        socks_password: Some("synthetic-original-password".into()),
                        ..Default::default()
                    },
                    None,
                )
                .await
                .unwrap();
            let rule = app.port_forward_repo.create(input).await.unwrap();
            let reference = rule.socks_password_ref.unwrap();
            app.store
                .with_conn(|conn| {
                    conn.execute("DELETE FROM app_meta WHERE key='network_secrets.store'", [])
                        .unwrap();
                    if tombstone {
                        conn.execute("UPDATE secret SET deleted_at=1 WHERE id=?1", [&reference])
                            .unwrap();
                    } else {
                        conn.execute("DELETE FROM secret WHERE id=?1", [&reference])
                            .unwrap();
                    }
                    Ok(())
                })
                .unwrap();
            if mixed {
                app.settings_repo
                    .set(
                        "global",
                        None,
                        "proxy_list",
                        serde_json::json!([{
                            "id":"legacy", "name":"legacy", "proxy_type":"http", "host":"localhost",
                            "port":8080, "password":"synthetic-legacy-proxy"
                        }]),
                        false,
                    )
                    .unwrap();
            }
            drop(app);
            let app = AppServices::new(dir.path().to_path_buf()).unwrap();
            assert!(
                app.network_secrets.forwards(None).await.is_err(),
                "missing pre-marker reference must be rejected"
            );
            app.vault.unlock(Some(MASTER), false).unwrap();
            assert!(
                app.network_secrets.forwards(None).await.is_err(),
                "unlock must not turn a missing reference into a password"
            );
            assert!(
                AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER)
                    .is_err()
            );
            let unchanged = app.port_forward_repo.get(&rule.id).await.unwrap();
            assert_eq!(
                unchanged.socks_password_ref.as_deref(),
                Some(reference.as_str())
            );
            app.store
                .with_conn(|conn| {
                    let count: i64 = conn
                        .query_row("SELECT COUNT(*) FROM secret", [], |row| row.get(0))
                        .unwrap();
                    assert_eq!(
                        count,
                        i64::from(tombstone),
                        "failed recovery must not create secrets"
                    );
                    Ok(())
                })
                .unwrap();
            if mixed {
                assert_eq!(
                    app.settings_repo
                        .get("global", None, "proxy_list")
                        .unwrap()
                        .unwrap()
                        .value_json[0]["password"],
                    "synthetic-legacy-proxy"
                );
            }
            // A missing secret affects its rule; the existing password input repairs it.
            assert!(app.vault.unlock(Some("wrong-password"), false).is_err());
            app.vault.unlock(Some(MASTER), false).unwrap();
            let repaired = app
                .network_secrets
                .prepare_forward(
                    PortForwardRuleInput {
                        name: unchanged.name,
                        bind_port: unchanged.bind_port,
                        socks_password: Some("synthetic-reentered-password".into()),
                        ..Default::default()
                    },
                    Some(&rule.id),
                )
                .await
                .unwrap();
            let repaired = app
                .port_forward_repo
                .update(&rule.id, repaired)
                .await
                .unwrap();
            assert_eq!(
                app.network_secrets
                    .resolve(
                        repaired.socks_password_ref.as_deref().unwrap(),
                        "socks_password"
                    )
                    .unwrap()
                    .as_str(),
                "synthetic-reentered-password"
            );
            assert!(
                AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER)
                    .is_ok()
            );
        }
    }
}

/// 旧库里的 SOCKS 明文口令样例：任意明文、26 位纯字母口令、合法 ULID 形状口令。
///
/// 旧版本把这三类值都直接写进 `socks_password_ref`，形态上无法与 `SecretId` 区分。
const LEGACY_SOCKS_PASSWORDS: [&str; 3] = [
    "plain-old-password",
    "abcdefghijklmnopqrstuvwxyz",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
];

fn old_profile() -> (tempfile::TempDir, Store, String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(dir.path().to_path_buf());
    let store = Store::open(&paths.db_path).unwrap();
    store
        .with_conn(|conn| {
            conn.execute_batch(include_str!("../../store/migrations/001_init.sql"))
                .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            Ok(())
        })
        .unwrap();
    let app = AppServices::new_in_memory().unwrap();
    app.vault
        .init(
            MASTER,
            false,
            Some(KdfParams {
                mem_kib: 1024,
                time: 1,
                parallelism: 1,
            }),
        )
        .unwrap();
    VaultRepo::new(store.clone())
        .save(&VaultRepo::new(app.store.clone()).load().unwrap().unwrap())
        .unwrap();
    let proxy = format!("synthetic-proxy-{}", SecretId::new());
    SettingsRepo::new(store.clone()).set("global",None,"proxy_list",serde_json::json!([{"id":"proxy","name":"proxy","host":"localhost","port":1080,"proxy_type":"socks5","password":proxy}]),false).unwrap();
    store.with_conn(|conn| {
        for (index, socks) in LEGACY_SOCKS_PASSWORDS.iter().enumerate() {
            conn.execute("INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_password_ref,created_at,updated_at) VALUES(?1,'legacy','dynamic','127.0.0.1',?2,?3,1,1)",rusqlite::params![PortForwardId::new().to_string(), 1080 + index as u16, socks]).unwrap();
        }
        Ok(())
    }).unwrap();
    (
        dir,
        store,
        proxy,
        LEGACY_SOCKS_PASSWORDS
            .iter()
            .map(|p| (*p).to_string())
            .collect(),
    )
}

// Test-only recovery through the existing explicit password input, before schema upgrade.
// Startup's master-password prompt does not authorize interpreting an ambiguous ref as plaintext.
async fn reenter_legacy_socks(store: &Store) {
    use openshell_core_domain::{PortForwardRepository, PortForwardRuleInput};
    let app = AppServices::new_in_memory().unwrap();
    VaultRepo::new(app.store.clone())
        .save(&VaultRepo::new(store.clone()).load().unwrap().unwrap())
        .unwrap();
    app.vault.unlock(Some(MASTER), false).unwrap();
    let network = openshell_app_core::network_secrets::NetworkSecrets::new(
        store.clone(),
        app.vault.manager(),
    );
    let repo = openshell_store::PortForwardRepo::new(store.clone());
    for rule in repo.list(None).await.unwrap() {
        let password = LEGACY_SOCKS_PASSWORDS[usize::from(rule.bind_port - 1080)];
        let input = network
            .prepare_forward(
                PortForwardRuleInput {
                    name: rule.name,
                    rule_type: Some(rule.rule_type),
                    bind_port: rule.bind_port,
                    socks_password: Some(password.into()),
                    ..Default::default()
                },
                Some(&rule.id),
            )
            .await
            .unwrap();
        repo.update(&rule.id, input).await.unwrap();
    }
}

#[tokio::test]
async fn schema_one_reference_snapshot_with_a_missing_secret_is_preserved() {
    for tombstone in [false, true] {
        let (dir, store, proxy, _) = old_profile();
        reenter_legacy_socks(&store).await;
        let reference: String = store
            .with_conn(|conn| {
                let reference: String = conn
                    .query_row(
                        "SELECT socks_password_ref FROM port_forward ORDER BY bind_port LIMIT 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                if tombstone {
                    conn.execute("UPDATE secret SET deleted_at=1 WHERE id=?1", [&reference])
                        .unwrap();
                } else {
                    conn.execute("DELETE FROM secret WHERE id=?1", [&reference])
                        .unwrap();
                }
                Ok(reference)
            })
            .unwrap();
        assert!(AppServices::new(dir.path().to_path_buf()).is_err());
        assert!(
            AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).is_err()
        );
        assert_eq!(store.schema_version().unwrap(), 1);
        store
            .with_conn(|conn| {
                assert_eq!(
                    conn.query_row(
                        "SELECT socks_password_ref FROM port_forward ORDER BY bind_port LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                    reference
                );
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                        .get::<_, i64>(0))
                        .unwrap(),
                    2 + i64::from(tombstone)
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            SettingsRepo::new(store.clone())
                .get("global", None, "proxy_list")
                .unwrap()
                .unwrap()
                .value_json[0]["password"],
            proxy
        );
        reenter_legacy_socks(&store).await;
        drop(store);
        assert!(
            AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).is_ok()
        );
    }
}

#[tokio::test]
async fn old_schema_unlocks_migrates_and_creates_a_secret_free_recovery_snapshot() {
    let (dir, store, proxy, socks) = old_profile();
    assert!(AppServices::new(dir.path().to_path_buf()).is_err());
    assert!(AppServices::recover_legacy_network_secrets(
        dir.path().to_path_buf(),
        "wrong-password"
    )
    .is_err());
    assert_eq!(store.schema_version().unwrap(), 1);
    store
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            Ok(())
        })
        .unwrap();
    // Even the correct master password cannot prove these values are legacy passwords.
    assert!(AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).is_err());
    store
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            for password in &socks {
                assert_eq!(
                    conn.query_row(
                        "SELECT COUNT(*) FROM port_forward WHERE socks_password_ref=?1",
                        [password],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                    1
                );
            }
            Ok(())
        })
        .unwrap();
    reenter_legacy_socks(&store).await;
    drop(store);
    let app =
        AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).unwrap();
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
    let saved = app.network_secrets.proxies().unwrap().remove(0);
    assert_eq!(
        app.network_secrets
            .runtime_proxy(saved)
            .unwrap()
            .password
            .as_deref(),
        Some(proxy.as_str())
    );
    let mut forwards = app.network_secrets.forwards(None).await.unwrap();
    assert_eq!(forwards.len(), socks.len());
    let mut resolved: Vec<String> = Vec::new();
    for forward in &mut forwards {
        let reference = forward.socks_password_ref.clone().expect("migrated ref");
        assert!(
            !socks.contains(&reference),
            "legacy plaintext {reference} was kept as a reference"
        );
        resolved.push(
            app.network_secrets
                .resolve(&reference, "socks_password")
                .unwrap()
                .to_string(),
        );
    }
    resolved.sort();
    let mut expected = socks.clone();
    expected.sort();
    assert_eq!(
        resolved, expected,
        "every legacy SOCKS password must survive the upgrade"
    );
    let snapshots = app.list_backups().unwrap();
    assert_eq!(snapshots.len(), 1);
    let bytes = std::fs::read(&snapshots[0].path).unwrap();
    for password in std::iter::once(&proxy).chain(socks.iter()) {
        assert!(!bytes
            .windows(password.len())
            .any(|window| window == password.as_bytes()));
    }
    // A failed later upgrade must still recover usable, encrypted schema-1 data.
    let recovered = Store::open(std::path::Path::new(&snapshots[0].path)).unwrap();
    assert_eq!(recovered.schema_version().unwrap(), 1);
    let reference = SettingsRepo::new(recovered.clone())
        .get("global", None, "proxy_list")
        .unwrap()
        .unwrap()
        .value_json[0]["password_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(SecretRepo::new(recovered)
        .get(&SecretId::from_string(reference).unwrap())
        .unwrap()
        .is_some());
    assert_eq!(snapshots[0].app_version, APP_VERSION);

    // 迁移完成后库已带「引用式存储」来源标记：真实缺失的引用必须报错，
    // 不能被再次当成明文口令加密（那会静默存下错误口令）。
    app.store
        .with_conn(|conn| {
            conn.execute("INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_password_ref,created_at,updated_at) VALUES(?1,'missing','dynamic','127.0.0.1',2080,?2,1,1)", rusqlite::params![PortForwardId::new().to_string(), SecretId::new().to_string()]).unwrap();
            Ok(())
        })
        .unwrap();
    assert!(app.network_secrets.forwards(None).await.is_err());
}

#[tokio::test]
async fn confirmed_socks_and_failed_proxy_migration_preserve_data_and_retry() {
    let (dir, store, proxy, _) = old_profile();
    reenter_legacy_socks(&store).await;
    store.with_conn(|conn| { conn.execute_batch("CREATE TRIGGER reject_proxy_update BEFORE UPDATE ON setting WHEN NEW.key='proxy_list' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").unwrap(); Ok(()) }).unwrap();
    assert!(AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).is_err());
    assert_eq!(store.schema_version().unwrap(), 1);
    assert_eq!(
        SettingsRepo::new(store.clone())
            .get("global", None, "proxy_list")
            .unwrap()
            .unwrap()
            .value_json[0]["password"],
        proxy
    );
    store
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM secret WHERE record_type='proxy_password'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM secret WHERE record_type='socks_password'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                3
            );
            conn.execute_batch("DROP TRIGGER reject_proxy_update")
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(
        backup::list(&AppPaths::new(dir.path().to_path_buf()).backups_dir)
            .unwrap()
            .is_empty()
    );
    drop(store);
    assert!(AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER).is_ok());
}
