//! 命令片段与宏仓储实现。

use crate::models::{
    bump_sync, ensure_id, map_sql_error, mark_sync_deleted, snippet_from_row, SNIPPET_COLUMNS,
};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, DomainError, DomainResult, GroupId, SendMode, Snippet, SnippetId, SnippetInput,
    SnippetKind, SnippetRepository, SyncMeta,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// 命令片段与宏仓储。
pub struct SnippetRepo {
    store: Store,
}

impl SnippetRepo {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
}

#[async_trait]
impl SnippetRepository for SnippetRepo {
    async fn list(&self, group_id: Option<&GroupId>) -> DomainResult<Vec<Snippet>> {
        self.store.with_conn(|conn| {
            let sql = match group_id {
                Some(_gid) => format!(
                    "SELECT {SNIPPET_COLUMNS} FROM snippet WHERE deleted_at IS NULL AND group_id = ?1 ORDER BY sort_order ASC, name ASC"
                ),
                None => format!(
                    "SELECT {SNIPPET_COLUMNS} FROM snippet WHERE deleted_at IS NULL ORDER BY sort_order ASC, name ASC"
                ),
            };
            let mut stmt = conn.prepare(&sql).map_err(map_sql_error)?;
            let rows = if let Some(gid) = group_id {
                stmt.query_map(params![gid.as_str()], snippet_from_row)
                    .map_err(map_sql_error)?
            } else {
                stmt.query_map([], snippet_from_row).map_err(map_sql_error)?
            };
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn get(&self, id: &SnippetId) -> DomainResult<Snippet> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SNIPPET_COLUMNS} FROM snippet WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id.as_str()],
                snippet_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("snippet not found"))
        })
    }

    async fn create(&self, input: SnippetInput) -> DomainResult<Snippet> {
        if input.name.trim().is_empty() {
            return Err(DomainError::validation("snippet name cannot be empty"));
        }
        let id = SnippetId::new();
        let now = now_ms();
        let kind = input.kind.unwrap_or(SnippetKind::Snippet);
        let send_mode = input.send_mode.unwrap_or(SendMode::Insert);
        let sort_order = input.sort_order.unwrap_or(1024);
        let group_id_str = input.group_id.as_ref().map(|g| g.as_str().to_string());
        let variables_json = input
            .variables_json
            .unwrap_or_else(|| serde_json::json!([]));
        let tags_json = input.tags_json.unwrap_or_else(|| serde_json::json!([]));

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            bump_sync(&tx, id.as_str(), "snippet", None)?;

            tx.execute(
                "INSERT INTO snippet(id, group_id, kind, name, body, variables_json, macro_steps_json, \
                 send_mode, shortcut, sort_order, tags_json, created_at, updated_at, deleted_at, \
                 version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, 0, NULL, 1)",
                params![
                    id.as_str(),
                    group_id_str.as_deref(),
                    kind.as_str(),
                    input.name,
                    input.body,
                    variables_json,
                    input.macro_steps_json,
                    send_mode.as_str(),
                    input.shortcut,
                    sort_order,
                    tags_json,
                    now,
                    now,
                ],
            )
            .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)?;

            Ok(Snippet {
                id,
                group_id: input.group_id,
                kind,
                name: input.name,
                body: input.body,
                variables_json: Some(variables_json),
                macro_steps_json: input.macro_steps_json,
                send_mode,
                shortcut: input.shortcut,
                sort_order,
                tags_json: Some(tags_json),
                created_at: now,
                updated_at: now,
                deleted_at: None,
                sync: SyncMeta {
                    version: 0,
                    origin_device_id: None,
                    dirty: true,
                },
            })
        })
    }

    async fn update(&self, id: &SnippetId, input: SnippetInput) -> DomainResult<Snippet> {
        ensure_id::<SnippetId>(id.as_str())?;
        if input.name.trim().is_empty() {
            return Err(DomainError::validation("snippet name cannot be empty"));
        }
        let now = now_ms();
        let kind = input.kind.unwrap_or(SnippetKind::Snippet);
        let send_mode = input.send_mode.unwrap_or(SendMode::Insert);
        let sort_order = input.sort_order.unwrap_or(1024);
        let group_id_str = input.group_id.as_ref().map(|g| g.as_str().to_string());
        let variables_json = input
            .variables_json
            .clone()
            .unwrap_or_else(|| serde_json::json!([]));
        let tags_json = input
            .tags_json
            .clone()
            .unwrap_or_else(|| serde_json::json!([]));

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            bump_sync(&tx, id.as_str(), "snippet", None)?;

            let affected = tx
                .execute(
                    "UPDATE snippet SET group_id = ?1, kind = ?2, name = ?3, body = ?4, \
                 variables_json = ?5, macro_steps_json = ?6, send_mode = ?7, shortcut = ?8, \
                 sort_order = ?9, tags_json = ?10, updated_at = ?11, dirty = 1 \
                 WHERE id = ?12 AND deleted_at IS NULL",
                    params![
                        group_id_str.as_deref(),
                        kind.as_str(),
                        input.name,
                        input.body,
                        variables_json,
                        input.macro_steps_json,
                        send_mode.as_str(),
                        input.shortcut,
                        sort_order,
                        tags_json,
                        now,
                        id.as_str(),
                    ],
                )
                .map_err(map_sql_error)?;

            if affected == 0 {
                return Err(DomainError::not_found("snippet not found"));
            }

            let version: i64 = tx
                .query_row(
                    "SELECT version FROM snippet WHERE id = ?1",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)?;

            Ok(Snippet {
                id: id.clone(),
                group_id: input.group_id,
                kind,
                name: input.name,
                body: input.body,
                variables_json: input.variables_json,
                macro_steps_json: input.macro_steps_json,
                send_mode,
                shortcut: input.shortcut,
                sort_order,
                tags_json: input.tags_json,
                created_at: now,
                updated_at: now,
                deleted_at: None,
                sync: SyncMeta {
                    version,
                    origin_device_id: None,
                    dirty: true,
                },
            })
        })
    }

    async fn delete(&self, id: &SnippetId) -> DomainResult<()> {
        ensure_id::<SnippetId>(id.as_str())?;
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            mark_sync_deleted(&tx, id.as_str(), "snippet")?;

            let affected = tx
                .execute(
                    "UPDATE snippet SET deleted_at = ?1, dirty = 1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id.as_str()],
                )
                .map_err(map_sql_error)?;

            if affected == 0 {
                return Err(DomainError::not_found("snippet not found"));
            }

            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
