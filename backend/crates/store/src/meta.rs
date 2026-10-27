//! `app_meta` 键值元数据：记录跨启动需要保留的应用级状态。
//!
//! 与 `setting` 表的区别：`setting` 是用户可见、可同步的偏好设置；
//! `app_meta` 是机器状态（上次启动版本、迁移/恢复记录），不参与同步、不进 UI 配置。

use crate::models::map_sql_error;
use crate::Store;
use openshell_core_domain::{now_ms, DomainResult};
use rusqlite::{params, OptionalExtension};

/// 上一次成功启动的客户端版本。
pub const KEY_LAST_APP_VERSION: &str = "last_app_version";
/// 最近一次 schema 迁移完成时间（Unix 毫秒）。
pub const KEY_LAST_MIGRATION_AT: &str = "last_migration_at";
/// 最近一次「迁移失败并从快照恢复」的时间（Unix 毫秒）。
pub const KEY_LAST_RECOVERY_AT: &str = "last_recovery_at";
/// 最近一次恢复所使用的快照路径。
pub const KEY_LAST_RECOVERY_BACKUP: &str = "last_recovery_backup";

/// 读取一个元数据值。
pub fn get(store: &Store, key: &str) -> DomainResult<Option<String>> {
    store.with_conn(|conn| {
        conn.query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_sql_error)
    })
}

/// 写入（或覆盖）一个元数据值。
pub fn set(store: &Store, key: &str, value: &str) -> DomainResult<()> {
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO app_meta(key, value, updated_at) VALUES(?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ms()],
        )
        .map_err(map_sql_error)
        .map(|_| ())
    })
}

/// 读取一个整型元数据值。
pub fn get_i64(store: &Store, key: &str) -> DomainResult<Option<i64>> {
    Ok(get(store, key)?.and_then(|raw| raw.parse::<i64>().ok()))
}

/// 写入一个整型元数据值。
pub fn set_i64(store: &Store, key: &str, value: i64) -> DomainResult<()> {
    set(store, key, &value.to_string())
}

/// 记录本次启动的客户端版本，返回上一次记录的版本。
///
/// 首次启动（或从未记录）返回 `None`；返回值与当前版本不同即表示「刚刚完成升级」，
/// 调用方据此决定是否追加一份升级后的安全快照。
pub fn record_startup(store: &Store, app_version: &str) -> DomainResult<Option<String>> {
    let previous = get(store, KEY_LAST_APP_VERSION)?;
    if previous.as_deref() != Some(app_version) {
        set(store, KEY_LAST_APP_VERSION, app_version)?;
    }
    Ok(previous)
}
