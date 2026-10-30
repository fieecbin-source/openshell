//! 数据安全验收用例：旧库升级、迁移失败回滚恢复、快照裁剪、拒绝降级。
//!
//! 全部走真实 SQLite 文件（`tempfile` 临时目录），不依赖网络与图形界面。

use openshell_core_domain::ErrorCode;
use openshell_store::backup::{self, BackupReason};
use openshell_store::migrator::{force_migration_failure, open_with_migration, MigrationOptions};
use openshell_store::SCHEMA_VERSION;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

const MIGRATION_001: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("../migrations/002_app_meta.sql");

/// 故障注入是进程级全局状态，涉及迁移的用例必须串行，否则并行执行会互相污染。
static MIGRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 构造一个「老版本客户端」的数据库：v1 schema + 用户数据。
fn create_v1_database(path: &Path) {
    let conn = Connection::open(path).expect("create v1 db");
    conn.execute_batch(MIGRATION_001).expect("apply v1 schema");
    conn.pragma_update(None, "user_version", 1i64)
        .expect("set user_version 1");

    let now = 1_700_000_000_000i64;
    conn.execute(
        "INSERT INTO session_group(id, kind, name, sort_order, created_at, updated_at, version, dirty) \
         VALUES(?1, 'session', ?2, 0, ?3, ?3, 0, 0)",
        params!["grp-1", "生产环境", now],
    )
    .expect("insert group");
    conn.execute(
        "INSERT INTO session(id, group_id, name, protocol, host, port, username, sort_order, \
         created_at, updated_at, version, dirty) \
         VALUES(?1, ?2, ?3, 'ssh', '10.0.0.8', 22, 'root', 0, ?4, ?4, 0, 0)",
        params!["ses-1", "grp-1", "web-01", now],
    )
    .expect("insert session");
    conn.execute(
        "INSERT INTO setting(id, scope, scope_id, key, value_json, value_type, syncable, updated_at) \
         VALUES(?1, 'user', NULL, 'terminal.fontSize', '15', 'number', 0, ?2)",
        params!["set-1", now],
    )
    .expect("insert setting");
}

fn create_v2_database(path: &Path) {
    let conn = Connection::open(path).expect("create v2 db");
    conn.execute_batch(MIGRATION_001).expect("apply v1 schema");
    conn.execute_batch(MIGRATION_002).expect("apply v2 schema");
    conn.pragma_update(None, "user_version", 2i64)
        .expect("set user_version 2");

    let now = 1_700_000_000_000i64;
    conn.execute(
        "INSERT INTO session_group(id, kind, name, sort_order, created_at, updated_at, version, dirty) \
         VALUES(?1, 'session', ?2, 0, ?3, ?3, 4, 0)",
        params!["grp-v2", "保留分组", now],
    )
    .expect("insert v2 group");
    conn.execute(
        "INSERT INTO sync_record(record_id, record_type, base_version, local_rev, \
         server_checksum, sync_state, updated_at) VALUES(?1, 'session_group', 4, 4, ?2, 'clean', ?3)",
        params!["grp-v2", "checksum-v1", now],
    )
    .expect("insert legacy sync metadata");
    conn.execute(
        "INSERT INTO setting(id, scope, scope_id, key, value_json, value_type, syncable, \
         updated_at, version, dirty) VALUES(?1, 'user', NULL, 'terminal.theme', ?2, \
         'string', 0, ?3, 2, 0)",
        params!["set-theme", "\"dark\"", now],
    )
    .expect("insert syncable preference");
}

fn options_for(dir: &Path) -> MigrationOptions {
    MigrationOptions {
        app_version: "1.0.1".to_string(),
        backups_dir: dir.join("backups"),
        keep_backups: 5,
    }
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .expect("count rows")
}

fn session_name(conn: &Connection) -> String {
    conn.query_row("SELECT name FROM session WHERE id = 'ses-1'", [], |r| {
        r.get(0)
    })
    .expect("read session")
}

fn group_name(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT name FROM session_group WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("read group")
}

fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get::<_, i64>(0),
    )
    .expect("query sqlite_master")
        > 0
}

#[test]
fn upgrades_v1_database_without_losing_data() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let db_path = tmp.path().join("openshell.db");
    create_v1_database(&db_path);

    let (store, report) =
        open_with_migration(&db_path, &options_for(tmp.path())).expect("open and migrate");

    assert_eq!(report.from_version, 1);
    assert_eq!(report.schema_version, SCHEMA_VERSION);
    assert!(!report.was_recovered());
    // 有数据的老库必须留下迁移前快照
    assert!(report.pre_migration_backup.is_some());
    assert_eq!(
        store.schema_version().expect("schema version"),
        SCHEMA_VERSION
    );

    let conn = Connection::open(&db_path).expect("reopen db");
    assert_eq!(count(&conn, "session"), 1);
    assert_eq!(count(&conn, "session_group"), 1);
    assert_eq!(count(&conn, "setting"), 1);
    assert_eq!(session_name(&conn), "web-01");
    assert!(has_table(&conn, "app_meta"), "v2 must create app_meta");

    // 快照文件真实存在且可被列举
    let backups = backup::list(&tmp.path().join("backups")).expect("list backups");
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].reason, BackupReason::PreMigration);
    assert!(PathBuf::from(&backups[0].path).is_file());
}

#[test]
fn upgrades_v2_sync_metadata_without_losing_data() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let db_path = tmp.path().join("openshell.db");
    create_v2_database(&db_path);

    let (store, report) =
        open_with_migration(&db_path, &options_for(tmp.path())).expect("open and migrate v2");
    assert_eq!(report.from_version, 2);
    assert_eq!(report.schema_version, 3);
    assert_eq!(store.schema_version().expect("schema version"), 3);

    let conn = Connection::open(&db_path).expect("reopen db");
    assert_eq!(group_name(&conn, "grp-v2"), "保留分组");
    assert!(has_table(&conn, "sync_conflict"));

    let metadata: (i64, i64, i64, String) = conn
        .query_row(
            "SELECT schema_version, revision, deleted, server_checksum \
             FROM sync_record WHERE record_id = 'grp-v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read migrated sync metadata");
    assert_eq!(metadata, (1, 0, 0, "checksum-v1".to_string()));

    let setting_flags: (i64, i64) = conn
        .query_row(
            "SELECT syncable, dirty FROM setting WHERE id = 'set-theme'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read migrated setting");
    assert_eq!(setting_flags, (1, 1));
}

#[test]
fn rolls_back_to_snapshot_when_migration_fails() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let db_path = tmp.path().join("openshell.db");
    create_v1_database(&db_path);

    force_migration_failure(Some(2));
    let (store, report) =
        open_with_migration(&db_path, &options_for(tmp.path())).expect("open with recovery");
    force_migration_failure(None);

    assert!(report.was_recovered(), "report must flag the recovery");
    assert_eq!(report.schema_version, 1, "must fall back to old schema");
    assert!(report.recovered_from.is_some());
    assert_eq!(store.schema_version().expect("schema version"), 1);

    // 旧数据必须完好可读
    let conn = Connection::open(&db_path).expect("reopen db");
    assert_eq!(session_name(&conn), "web-01");
    assert_eq!(count(&conn, "setting"), 1);
    assert!(!has_table(&conn, "app_meta"), "v2 migration rolled back");

    // 原库被留档，没有被静默丢弃
    let leftovers: Vec<String> = std::fs::read_dir(tmp.path())
        .expect("read data dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("openshell.db.broken-"))
        .collect();
    assert_eq!(leftovers.len(), 1, "quarantined db copy expected");

    drop(store);
    drop(conn);

    // 下一次启动（无故障注入）应能正常完成升级，证明恢复后的库是可用的
    let (_store, retry) =
        open_with_migration(&db_path, &options_for(tmp.path())).expect("retry migration");
    assert_eq!(retry.schema_version, SCHEMA_VERSION);
    assert!(!retry.was_recovered());
    let conn = Connection::open(&db_path).expect("reopen db");
    assert_eq!(session_name(&conn), "web-01");
}

#[test]
fn refuses_to_open_database_from_newer_app() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let db_path = tmp.path().join("openshell.db");
    let conn = Connection::open(&db_path).expect("create db");
    conn.pragma_update(None, "user_version", 99i64)
        .expect("set future schema");
    drop(conn);

    let err = match open_with_migration(&db_path, &options_for(tmp.path())) {
        Ok(_) => panic!("opening a database from a newer app must fail"),
        Err(err) => err,
    };
    assert_eq!(err.code, ErrorCode::SchemaNewerThanApp);
    assert!(!err.retryable);
}

#[test]
fn prune_keeps_newest_and_never_deletes_manual_backups() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let dir = tmp.path().join("backups");
    std::fs::create_dir_all(&dir).expect("create backups dir");

    for index in 1..=6 {
        let name = format!("openshell_1.0.{index}_pre-install_2026010{index}T000000Z.db");
        std::fs::write(dir.join(name), b"snapshot").expect("write snapshot");
    }
    std::fs::write(
        dir.join("openshell_1.0.0_manual_20250101T000000Z.db"),
        b"manual",
    )
    .expect("write manual snapshot");
    // 非本模块命名的文件必须原样保留
    std::fs::write(dir.join("notes.txt"), b"keep me").expect("write stray file");

    let removed = backup::prune(&dir, 2).expect("prune");
    assert_eq!(removed.len(), 4);

    let remaining: Vec<String> = backup::list(&dir)
        .expect("list")
        .into_iter()
        .map(|b| b.file_name)
        .collect();
    assert_eq!(remaining.len(), 3);
    assert!(remaining.iter().any(|n| n.contains("_manual_")));
    assert!(dir.join("notes.txt").exists());
    // 保留的是文件名最大（即时间最新）的两份
    assert!(remaining.iter().any(|n| n.contains("20260106")));
    assert!(remaining.iter().any(|n| n.contains("20260105")));
}

#[test]
fn snapshot_can_be_created_and_restored() {
    let _guard = MIGRATION_LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().expect("temp dir");
    let db_path = tmp.path().join("openshell.db");
    let opts = options_for(tmp.path());
    let (store, _) = open_with_migration(&db_path, &opts).expect("fresh db");

    openshell_store::SettingsRepo::new(store.clone())
        .set("user", None, "demo", serde_json::json!("v"), false)
        .expect("insert row");

    let info = backup::create(
        &store,
        &tmp.path().join("backups"),
        "1.0.1",
        BackupReason::Manual,
    )
    .expect("snapshot");
    drop(store);

    // 模拟数据被破坏：直接删库，再用快照恢复
    std::fs::remove_file(&db_path).expect("remove db");
    backup::restore(Path::new(&info.path), &db_path).expect("restore");

    let conn = Connection::open(&db_path).expect("reopen db");
    assert_eq!(count(&conn, "setting"), 1);
}
