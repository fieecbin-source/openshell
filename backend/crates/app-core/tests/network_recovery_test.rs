use openshell_app_core::{AppServices, APP_VERSION};
use openshell_core_domain::{AppPaths, PortForwardId, SecretId};
use openshell_store::{backup, SecretRepo, SettingsRepo, Store, VaultRepo};
use openshell_vault::KdfParams;

const MASTER: &str = "synthetic-recovery-master";

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

#[test]
fn failed_socks_update_rolls_back_all_legacy_passwords_and_retries() {
    let (dir, store, proxy, _) = old_profile();
    store.with_conn(|conn| { conn.execute_batch("CREATE TRIGGER reject_socks_update BEFORE UPDATE ON port_forward BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").unwrap(); Ok(()) }).unwrap();
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
                conn.query_row("SELECT COUNT(*) FROM secret", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            conn.execute_batch("DROP TRIGGER reject_socks_update")
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
