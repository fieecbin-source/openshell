//! 设置仓储：作用域 + 键 + JSON 值。

use crate::models::{
    bump_sync, json_value_type, map_sql_error, setting_from_row, SettingRecord, SETTING_COLUMNS,
};
use crate::Store;
use openshell_core_domain::{now_ms, DomainError, DomainResult};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

/// 设置仓储。
pub struct SettingsRepo {
    store: Store,
}

impl SettingsRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// 读取单个设置值。
    pub fn get(
        &self,
        scope: &str,
        scope_id: Option<&str>,
        key: &str,
    ) -> DomainResult<Option<SettingRecord>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SETTING_COLUMNS} FROM setting \
                     WHERE scope = ?1 AND scope_id IS ?2 AND key = ?3"
                ),
                params![scope, scope_id, key],
                setting_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    /// 写入或更新设置值。
    pub fn set(
        &self,
        scope: &str,
        scope_id: Option<&str>,
        key: &str,
        value: Value,
        syncable: bool,
    ) -> DomainResult<SettingRecord> {
        if scope.is_empty() || key.is_empty() {
            return Err(DomainError::validation("invalid setting scope or key"));
        }
        let now = now_ms();
        let value_type = json_value_type(&value).to_string();
        let dirty = i64::from(syncable);

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let existing: Option<(String, i64)> = tx
                .query_row(
                    "SELECT id, version FROM setting WHERE scope = ?1 AND scope_id IS ?2 AND key = ?3",
                    params![scope, scope_id, key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(map_sql_error)?;

            let record = match existing {
                Some((id, version)) => {
                    if syncable {
                        bump_sync(&tx, &id, "setting", None)?;
                    }
                    tx.execute(
                        "UPDATE setting SET value_json = ?1, value_type = ?2, syncable = ?3, \
                         updated_at = ?4, dirty = ?5 WHERE id = ?6",
                        params![value, value_type, syncable, now, dirty, id],
                    )
                    .map_err(map_sql_error)?;
                    SettingRecord {
                        id,
                        scope: scope.to_string(),
                        scope_id: scope_id.map(str::to_string),
                        key: key.to_string(),
                        value_json: value,
                        value_type,
                        syncable,
                        updated_at: now,
                        version,
                        origin_device_id: None,
                        dirty: syncable,
                    }
                }
                None => {
                    let id = ulid::Ulid::new().to_string();
                    if syncable {
                        bump_sync(&tx, &id, "setting", None)?;
                    }
                    tx.execute(
                        "INSERT INTO setting(id, scope, scope_id, key, value_json, value_type, \
                         syncable, updated_at, version, origin_device_id, dirty) \
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9)",
                        params![
                            id,
                            scope,
                            scope_id,
                            key,
                            value,
                            value_type,
                            syncable,
                            now,
                            dirty,
                        ],
                    )
                    .map_err(map_sql_error)?;
                    SettingRecord {
                        id,
                        scope: scope.to_string(),
                        scope_id: scope_id.map(str::to_string),
                        key: key.to_string(),
                        value_json: value,
                        value_type,
                        syncable,
                        updated_at: now,
                        version: 0,
                        origin_device_id: None,
                        dirty: syncable,
                    }
                }
            };

            tx.commit().map_err(map_sql_error)?;
            Ok(record)
        })
    }

    /// 列出某作用域下的全部设置。
    pub fn list(&self, scope: &str) -> DomainResult<Vec<SettingRecord>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SETTING_COLUMNS} FROM setting WHERE scope = ?1 ORDER BY scope_id, key"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map(params![scope], setting_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }
}
