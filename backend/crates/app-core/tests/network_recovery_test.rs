use openshell_app_core::{AppServices, APP_VERSION};
use openshell_core_domain::{AppPaths, PortForwardId, SecretId};
use openshell_store::{backup, SecretRepo, SettingsRepo, Store, VaultRepo};
use openshell_vault::KdfParams;
use rusqlite::OptionalExtension;

const MASTER: &str = "synthetic-recovery-master";

#[tokio::test]
async fn recovery_closes_old_handles_before_migration_failure_restore() {
    for needs_reentry in [false, true] {
        let (dir, store, _, _) = old_profile();
        let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
        let entries = recovery_entries(&items, "synthetic-restore");
        if !needs_reentry {
            reenter_legacy_socks(&store).await;
        }
        // Fail migration 3 only for this fixture, without a process-global injection.
        store
            .with_conn(|conn| {
                conn.execute_batch("CREATE TABLE sync_conflict(id TEXT PRIMARY KEY)")
                    .unwrap();
                Ok(())
            })
            .unwrap();
        drop(store);
        let result = if needs_reentry {
            AppServices::recover_legacy_network_secrets_with_reentry(
                dir.path().to_path_buf(),
                MASTER,
                &entries,
            )
        } else {
            AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER)
        };
        let app = result.unwrap_or_else(|error| panic!("restore failed: {error}"));
        assert!(app.migration.was_recovered());
        assert_eq!(app.store.schema_version().unwrap(), 1);
        assert_eq!(app.list_backups().unwrap().len(), 1);
    }
}

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
                app.network_secrets.forwards_strict(None).await.is_err(),
                "missing pre-marker reference must be rejected"
            );
            let listed = app.network_secrets.forwards(None).await.unwrap();
            assert_eq!(listed.len(), 1, "坏引用仍要能进入编辑");
            assert!(listed[0].rule.socks_password_ref.is_none());
            app.vault.unlock(Some(MASTER), false).unwrap();
            assert!(
                app.network_secrets.forwards_strict(None).await.is_err(),
                "unlock must not turn a missing reference into a password"
            );
            assert!(app.network_secrets.forwards(None).await.unwrap()[0]
                .rule
                .socks_password_ref
                .is_none());
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

/// schema1 旧库 fixture。`initialize_vault=false` 时 vault 表为空，用于复现
/// 「只读检查/取消却先创建了保险库记录」的真实失败边界。
fn legacy_profile(initialize_vault: bool) -> (tempfile::TempDir, Store, String, Vec<String>) {
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
    if initialize_vault {
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
    }
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

fn old_profile() -> (tempfile::TempDir, Store, String, Vec<String>) {
    legacy_profile(true)
}

fn uninitialized_old_profile() -> (tempfile::TempDir, Store, String, Vec<String>) {
    legacy_profile(false)
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
    let forwards = app.network_secrets.forwards_strict(None).await.unwrap();
    assert_eq!(forwards.len(), socks.len());
    let mut resolved: Vec<String> = Vec::new();
    for forward in &forwards {
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
    assert!(app.network_secrets.forwards_strict(None).await.is_err());
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

/// R01/S01：一条坏引用不得隐藏完好规则，也不得阻断目标级启动与元数据导出。
/// 本用例先于修复存在，用于复现 `forwards()` 的整表失败根因。
#[tokio::test]
async fn broken_reference_no_longer_hides_healthy_forwards_or_blocks_metadata_export() {
    use openshell_core_domain::{PortForwardRepository, PortForwardRuleInput};

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

    let good_input = app
        .network_secrets
        .prepare_forward(
            PortForwardRuleInput {
                name: "healthy".into(),
                bind_port: 1080,
                socks_password: Some("synthetic-healthy".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let good = app.port_forward_repo.create(good_input).await.unwrap();

    let broken_ref = SecretId::new().to_string();
    let bad_id = PortForwardId::new();
    app.store
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO port_forward(id,name,type,bind_host,bind_port,socks_auth,socks_password_ref,created_at,updated_at) \
                 VALUES(?1,'broken','dynamic','127.0.0.1',1081,'userpass',?2,1,1)",
                rusqlite::params![bad_id.to_string(), broken_ref],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();

    let listed = app
        .network_secrets
        .forwards(None)
        .await
        .expect("一条坏引用不应让整份转发列表不可用");
    assert_eq!(listed.len(), 2, "两条规则都必须可编辑");
    // 通过真实序列化边界断言脱敏契约，不依赖列举结构的 Rust 具体类型。
    let rows = serde_json::to_value(&listed).unwrap();
    let bad = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == bad_id.as_str())
        .expect("坏规则必须仍在列表中");
    assert!(bad["socks_password_ref"].is_null(), "未知引用原值绝不回传");
    assert_eq!(bad["credential_state"], "needs_reentry");
    let good_row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == good.id.as_str())
        .unwrap();
    assert_eq!(good_row["credential_state"], "ready");

    let stored_ref: String = app
        .store
        .with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT socks_password_ref FROM port_forward WHERE id=?1",
                    [bad_id.as_str()],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    assert_eq!(stored_ref, broken_ref, "读操作不得改坏持久化原行");

    assert!(app
        .network_secrets
        .resolve(&broken_ref, "socks_password")
        .is_err());
    assert_eq!(
        app.network_secrets
            .resolve(
                good.socks_password_ref.as_deref().unwrap(),
                "socks_password"
            )
            .unwrap()
            .as_str(),
        "synthetic-healthy"
    );

    let archive = openshell_app_core::archive_service::ArchiveService::new(
        app.store.clone(),
        app.vault.manager().clone(),
    );
    let json = archive
        .export_json()
        .await
        .expect("元数据导出不应被无关的坏引用卡死");
    assert!(!json.contains(&broken_ref), "导出不得含未知引用原值");
    assert!(!json.contains("synthetic-healthy"), "导出不得含合成口令");
}

/// R01/S01：启动恢复不能只反复询问主密码后退出，须给出仅含安全元数据的逐条补录路径。
#[tokio::test]
async fn startup_recovery_offers_only_safe_per_rule_reentry_metadata() {
    let (dir, _store, _, _) = old_profile();
    let error = match AppServices::recover_legacy_network_secrets(dir.path().to_path_buf(), MASTER)
    {
        Ok(_) => panic!("来源不明时仅主密码不得直接完成恢复"),
        Err(error) => error,
    };
    let items = error
        .details
        .as_ref()
        .and_then(|details| details.get("recovery_items"))
        .and_then(|value| value.as_array())
        .expect("恢复入口必须给出逐条补录的安全元数据");
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details["requires_reentry"].as_bool()),
        Some(true),
        "恢复入口必须显式要求逐条补录"
    );
    assert_eq!(items.len(), 3, "每条无法判源的规则都要可逐条补录");
    for item in items {
        let object = item.as_object().unwrap();
        assert!(object.contains_key("rule_id"));
        assert!(object.contains_key("name"));
        assert!(object.contains_key("bind_port"));
        assert!(!object.contains_key("socks_password_ref"));
        let serialized = serde_json::to_string(item).unwrap();
        for password in LEGACY_SOCKS_PASSWORDS {
            assert!(
                !serialized.contains(password),
                "安全元数据不得包含旧值原内容"
            );
        }
    }
    assert!(!error.message.contains(MASTER));
    for password in LEGACY_SOCKS_PASSWORDS {
        assert!(!error.message.contains(password));
    }
}

use openshell_app_core::network_secrets::{
    ForwardCredentialState, LegacyRecoveryEntry, LegacyRecoveryItem,
};
use zeroize::Zeroizing;

fn recovery_entries(items: &[LegacyRecoveryItem], prefix: &str) -> Vec<LegacyRecoveryEntry> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| LegacyRecoveryEntry {
            rule_id: item.rule_id.clone(),
            password: Zeroizing::new(format!("{prefix}-{index}")),
        })
        .collect()
}

fn assert_no_plaintext(bytes: &[u8], values: &[&str]) {
    for value in values {
        if value.is_empty() {
            continue;
        }
        assert!(
            !bytes
                .windows(value.len())
                .any(|window| window == value.as_bytes()),
            "合成秘密或旧值不得出现在持久化字节中"
        );
    }
}

/// 只读列举、错误主密码、取消与失败补录都不得改动 schema1 原库。
fn assert_legacy_rows_untouched(store: &Store, proxy: &str) {
    assert_eq!(store.schema_version().unwrap(), 1);
    store
        .with_conn(|conn| {
            let refs = conn
                .prepare("SELECT socks_password_ref FROM port_forward ORDER BY bind_port")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(
                refs,
                LEGACY_SOCKS_PASSWORDS
                    .iter()
                    .map(|password| (*password).to_owned())
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "失败路径不得创建或重加密任何秘密"
            );
            let raw: String = conn
                .query_row(
                    "SELECT value_json FROM setting WHERE key='proxy_list'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(raw.contains(proxy));
            Ok(())
        })
        .unwrap();
}

/// R01/S01：正确主密码才逐条列出待补录项；错误主密码与只读列举都不写库、不泄露。
#[tokio::test]
async fn legacy_recovery_verifies_master_password_before_listing_or_writing() {
    let (dir, store, proxy, _) = old_profile();
    let wrong = match AppServices::inspect_legacy_recovery(
        dir.path().to_path_buf(),
        "synthetic-wrong-master",
    ) {
        Ok(_) => panic!("错误主密码不得解锁旧库"),
        Err(error) => error,
    };
    let rendered = format!("{} {:?} {:?}", wrong.message, wrong.details, wrong);
    assert!(!rendered.contains("synthetic-wrong-master"));
    assert!(!rendered.contains(MASTER));
    for password in LEGACY_SOCKS_PASSWORDS {
        assert!(!rendered.contains(password));
    }
    assert_legacy_rows_untouched(&store, &proxy);

    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
    assert_eq!(items.len(), 3);
    let serialized = serde_json::to_string(&items).unwrap();
    assert!(!serialized.contains("socks_password_ref"));
    assert!(!serialized.contains(MASTER));
    for password in LEGACY_SOCKS_PASSWORDS {
        assert!(!serialized.contains(password));
    }
    assert_legacy_rows_untouched(&store, &proxy);
    assert!(
        backup::list(&AppPaths::new(dir.path().to_path_buf()).backups_dir)
            .unwrap()
            .is_empty()
    );
}

/// R01/S01：逐条补录后旧库真正升级，规则可读可启动；导出与备份不含旧值或新口令。
#[tokio::test]
async fn per_rule_reentry_upgrades_legacy_store_and_enables_read_and_start() {
    let (dir, store, proxy, _) = old_profile();
    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
    let entries = recovery_entries(&items, "synthetic-reentered-socks");
    drop(store);
    let app = AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &entries,
    )
    .unwrap();
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
    let views = app.network_secrets.forwards(None).await.unwrap();
    assert_eq!(views.len(), items.len());
    assert!(views
        .iter()
        .all(|view| view.credential_state == ForwardCredentialState::Ready));
    let strict = app.network_secrets.forwards_strict(None).await.unwrap();
    assert_eq!(strict.len(), items.len());
    let mut resolved = Vec::new();
    for rule in &strict {
        let reference = rule.socks_password_ref.as_deref().unwrap();
        assert!(!LEGACY_SOCKS_PASSWORDS.contains(&reference));
        resolved.push(
            app.network_secrets
                .resolve(reference, "socks_password")
                .unwrap()
                .to_string(),
        );
    }
    resolved.sort();
    let mut expected = (0..items.len())
        .map(|index| format!("synthetic-reentered-socks-{index}"))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(resolved, expected, "补录后的口令必须可解密且可用于运行");

    let mut leaks = LEGACY_SOCKS_PASSWORDS.to_vec();
    leaks.push(proxy.as_str());
    for entry in &entries {
        leaks.push(entry.password.as_str());
    }
    let snapshots = app.list_backups().unwrap();
    assert_eq!(snapshots.len(), 1, "升级必须留下迁移前快照");
    for snapshot in &snapshots {
        assert_no_plaintext(&std::fs::read(&snapshot.path).unwrap(), &leaks);
    }
    let json = openshell_app_core::archive_service::ArchiveService::new(
        app.store.clone(),
        app.vault.manager().clone(),
    )
    .export_json()
    .await
    .unwrap();
    for value in &leaks {
        assert!(!json.contains(value), "元数据导出不得含口令或未知引用");
    }
}

/// R01/S01：取消保留不写库、不覆盖备份，且重新启动仍可重试并成功。
#[tokio::test]
async fn cancelling_reentry_preserves_original_store_and_keeps_retry_open() {
    let (dir, store, proxy, _) = old_profile();
    let backups_dir = AppPaths::new(dir.path().to_path_buf()).backups_dir;
    let before = backup::list(&backups_dir).unwrap();
    let error = match AppServices::cancel_legacy_recovery() {
        Ok(()) => panic!("取消必须给出可重试的明确结果"),
        Err(error) => error,
    };
    assert!(error.message.contains("取消"));
    assert!(!error.message.contains(MASTER));
    for password in LEGACY_SOCKS_PASSWORDS {
        assert!(!error.message.contains(password));
    }
    assert_legacy_rows_untouched(&store, &proxy);
    assert_eq!(backup::list(&backups_dir).unwrap().len(), before.len());
    drop(store);

    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
    assert_eq!(items.len(), 3, "取消后必须仍能重新逐条补录");
    let entries = recovery_entries(&items, "synthetic-after-cancel");
    let app = AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &entries,
    )
    .unwrap();
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
}

/// R01/S01：少一条、空口令、重复规则等混合失败一律整事务回滚，且可重试。
#[tokio::test]
async fn incomplete_or_invalid_reentry_rolls_back_the_whole_transaction() {
    let (dir, store, proxy, _) = old_profile();
    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();

    let mut partial = recovery_entries(&items, "synthetic-partial");
    partial.pop();
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &partial
    )
    .is_err());
    assert_legacy_rows_untouched(&store, &proxy);

    let mut empty = recovery_entries(&items, "synthetic-empty");
    empty[1].password = Zeroizing::new(String::new());
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &empty
    )
    .is_err());
    assert_legacy_rows_untouched(&store, &proxy);

    let mut duplicate = recovery_entries(&items, "synthetic-duplicate");
    let duplicated_id = duplicate[0].rule_id.clone();
    duplicate[2].rule_id = duplicated_id;
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &duplicate
    )
    .is_err());
    assert_legacy_rows_untouched(&store, &proxy);

    let entries = recovery_entries(&items, "synthetic-after-rollback");
    drop(store);
    let app = AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &entries,
    )
    .unwrap();
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
    assert_eq!(
        app.network_secrets
            .forwards_strict(None)
            .await
            .unwrap()
            .len(),
        3
    );
}

/// Task8 T7-02：旧库完整持久化快照。除旧 SOCKS 原值外，覆盖 vault 记录（主密码绑定
/// kdf_salt / wrapped_vault_key / key_check、last_opened_at、updated_at）、secret、代理、
/// 来源标记、schema 与备份；检查/取消/失败路径前后必须逐项一致。
#[derive(Debug, PartialEq)]
struct LegacySnapshot {
    schema_version: i64,
    vault: Option<serde_json::Value>,
    secret_count: i64,
    socks_refs: Vec<String>,
    proxy_raw: String,
    marker: Option<String>,
    backups: usize,
}

fn legacy_snapshot(dir: &tempfile::TempDir, store: &Store) -> LegacySnapshot {
    let vault = VaultRepo::new(store.clone())
        .load()
        .unwrap()
        .map(|record| serde_json::to_value(record).unwrap());
    let (schema_version, secret_count, socks_refs, proxy_raw, marker) = store
        .with_conn(|conn| {
            let schema_version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            let secret_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM secret", [], |row| row.get(0))
                .unwrap();
            let socks_refs = conn
                .prepare("SELECT socks_password_ref FROM port_forward ORDER BY bind_port")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            let proxy_raw: String = conn
                .query_row(
                    "SELECT value_json FROM setting WHERE key='proxy_list'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let has_app_meta: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let marker = if has_app_meta {
                conn.query_row(
                    "SELECT value FROM app_meta WHERE key='network_secrets.store'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .unwrap()
            } else {
                None
            };
            Ok((schema_version, secret_count, socks_refs, proxy_raw, marker))
        })
        .unwrap();
    LegacySnapshot {
        schema_version,
        vault,
        secret_count,
        socks_refs,
        proxy_raw,
        marker,
        backups: backup::list(&AppPaths::new(dir.path().to_path_buf()).backups_dir)
            .unwrap()
            .len(),
    }
}

fn assert_snapshot_unchanged(dir: &tempfile::TempDir, store: &Store, before: &LegacySnapshot) {
    assert_eq!(
        &legacy_snapshot(dir, store),
        before,
        "检查/取消/失败路径不得创建 vault、绑定口令、改 last_opened 或留下任何持久化副作用"
    );
}

/// Task8 T7-02：未初始化旧库仅做只读检查与取消，不得创建 vault 或绑定第一次口令。
#[tokio::test]
async fn uninitialized_legacy_inspect_and_cancel_leave_no_persisted_state() {
    let (dir, store, _proxy, _) = uninitialized_old_profile();
    let before = legacy_snapshot(&dir, &store);
    assert!(before.vault.is_none(), "fixture 必须是 vault 表为空的旧库");

    let items =
        AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), "synthetic-first-master")
            .expect("未初始化库也应能列出仅含安全元数据的待补录项");
    assert_eq!(items.len(), LEGACY_SOCKS_PASSWORDS.len());
    assert!(
        AppServices::cancel_legacy_recovery().is_err(),
        "取消须可重试"
    );

    assert_snapshot_unchanged(&dir, &store, &before);
}

/// Task8 T7-02：未初始化旧库补录缺一条/空口令等失败后仍须零写入。
#[tokio::test]
async fn uninitialized_legacy_failed_reentry_leaves_no_persisted_state() {
    let (dir, store, _proxy, _) = uninitialized_old_profile();
    let before = legacy_snapshot(&dir, &store);
    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();

    let mut partial = recovery_entries(&items, "synthetic-partial");
    partial.pop();
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &partial
    )
    .is_err());
    assert_snapshot_unchanged(&dir, &store, &before);

    let mut empty = recovery_entries(&items, "synthetic-empty");
    empty[1].password = Zeroizing::new(String::new());
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &empty
    )
    .is_err());
    assert_snapshot_unchanged(&dir, &store, &before);
}

/// Task8 T7-02：已有 vault 的只读检查仅验证主密码，不更新 last_opened/updated_at。
#[tokio::test]
async fn initialized_legacy_inspect_does_not_touch_last_opened() {
    let (dir, store, _proxy, _) = old_profile();
    store
        .with_conn(|conn| {
            conn.execute("UPDATE vault SET last_opened_at=1, updated_at=1", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let before = legacy_snapshot(&dir, &store);
    assert!(before.vault.is_some(), "fixture 必须是已初始化旧库");

    assert!(AppServices::inspect_legacy_recovery(
        dir.path().to_path_buf(),
        "synthetic-wrong-master"
    )
    .is_err());
    assert_snapshot_unchanged(&dir, &store, &before);

    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
    assert_eq!(items.len(), LEGACY_SOCKS_PASSWORDS.len());
    assert_snapshot_unchanged(&dir, &store, &before);
}

/// Task8 T7-02：取消不得固定第一次主密码；换新口令重试须成功且逐条 resolve 正确。
#[tokio::test]
async fn cancel_does_not_bind_first_master_password_on_uninitialized_store() {
    let (dir, store, _proxy, _) = uninitialized_old_profile();
    let before = legacy_snapshot(&dir, &store);

    let items =
        AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), "synthetic-first-master")
            .unwrap();
    assert!(AppServices::cancel_legacy_recovery().is_err());
    assert_snapshot_unchanged(&dir, &store, &before);

    let entries = recovery_entries(&items, "synthetic-second-try");
    drop(store);
    let app = AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        "synthetic-second-master",
        &entries,
    )
    .expect("取消后换一个新主密码再试必须成功");
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
    assert!(
        app.vault
            .unlock(Some("synthetic-first-master"), false)
            .is_err(),
        "第一次口令不得被绑定"
    );
    app.vault
        .unlock(Some("synthetic-second-master"), false)
        .unwrap();
    let mut resolved = Vec::new();
    for rule in app.network_secrets.forwards_strict(None).await.unwrap() {
        resolved.push(
            app.network_secrets
                .resolve(
                    rule.socks_password_ref.as_deref().unwrap(),
                    "socks_password",
                )
                .unwrap()
                .to_string(),
        );
    }
    resolved.sort();
    let mut expected = (0..items.len())
        .map(|index| format!("synthetic-second-try-{index}"))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(resolved, expected, "新主密码下每条规则口令都应能解密");
}

/// Task8：事务中途失败时，新 vault 行与 secret/SOCKS/代理/标记一起回滚；
/// 同一库同一主密码可重试成功，证明是原子边界而非事后删除补救。
#[tokio::test]
async fn uninitialized_recovery_rolls_back_vault_with_secret_on_mid_transaction_failure() {
    let (dir, store, _proxy, _) = uninitialized_old_profile();
    let before = legacy_snapshot(&dir, &store);
    let items = AppServices::inspect_legacy_recovery(dir.path().to_path_buf(), MASTER).unwrap();
    let entries = recovery_entries(&items, "synthetic-atomic");

    // 每库隔离故障注入：vault 行已在事务内先写入，secret 插入阶段 ABORT。
    store
        .with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_secret_insert BEFORE INSERT ON secret \
                 BEGIN SELECT RAISE(ABORT,'synthetic secret failure'); END",
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &entries
    )
    .is_err());
    assert_snapshot_unchanged(&dir, &store, &before);

    store
        .with_conn(|conn| {
            conn.execute_batch("DROP TRIGGER reject_secret_insert")
                .unwrap();
            Ok(())
        })
        .unwrap();
    drop(store);

    let app = AppServices::recover_legacy_network_secrets_with_reentry(
        dir.path().to_path_buf(),
        MASTER,
        &entries,
    )
    .expect("整事务回滚后必须能用同一主密码重试成功");
    assert_eq!(
        app.store.schema_version().unwrap(),
        openshell_store::SCHEMA_VERSION
    );
    assert!(app
        .vault
        .unlock(Some("synthetic-other-master"), false)
        .is_err());
    app.vault.unlock(Some(MASTER), false).unwrap();
    let mut resolved = Vec::new();
    for rule in app.network_secrets.forwards_strict(None).await.unwrap() {
        resolved.push(
            app.network_secrets
                .resolve(
                    rule.socks_password_ref.as_deref().unwrap(),
                    "socks_password",
                )
                .unwrap()
                .to_string(),
        );
    }
    resolved.sort();
    let mut expected = (0..items.len())
        .map(|index| format!("synthetic-atomic-{index}"))
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(resolved, expected, "重试成功后每条 secret 都可解密");
}
