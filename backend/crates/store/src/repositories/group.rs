//! 分组仓储（会话分组 / 片段分组树）。

use crate::models::{
    bump_sync, ensure_id, group_from_row, map_sql_error, mark_sync_deleted, GROUP_COLUMNS,
};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, DomainError, DomainResult, Group, GroupId, GroupKind, GroupRepository, SyncMeta,
};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

/// 分组仓储。
pub struct GroupRepo {
    store: Store,
}

impl GroupRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    fn get_sync(&self, id: &GroupId) -> DomainResult<Group> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {GROUP_COLUMNS} FROM session_group WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id.as_str()],
                group_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("group not found"))
        })
    }
}

/// 校验父链：父分组存在、未删除、无环且深度不超过 8。
///
/// 返回父链包含的节点数（根为 0）。
fn validate_parent(
    tx: &Transaction<'_>,
    moving: Option<&GroupId>,
    parent: Option<&GroupId>,
) -> DomainResult<i64> {
    let mut depth = 0i64;
    let mut current = parent.map(|g| g.as_str().to_string());
    while let Some(id) = current {
        if let Some(moving_id) = moving {
            if id == moving_id.as_str() {
                return Err(DomainError::conflict(
                    "group cannot be moved into itself or its descendant",
                ));
            }
        }
        let row: Option<(Option<String>, Option<i64>)> = tx
            .query_row(
                "SELECT parent_id, deleted_at FROM session_group WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(map_sql_error)?;
        let Some((parent_id, deleted_at)) = row else {
            return Err(DomainError::not_found("parent group not found"));
        };
        if deleted_at.is_some() {
            return Err(DomainError::not_found("parent group not found"));
        }
        current = parent_id;
        depth += 1;
        if depth >= 8 {
            return Err(DomainError::conflict("group depth exceeds limit"));
        }
    }
    Ok(depth)
}

fn validate_name(name: &str) -> DomainResult<()> {
    if name.is_empty() || name.chars().count() > 128 {
        return Err(DomainError::validation("invalid group name"));
    }
    Ok(())
}

/// 收集某父分组下的子分组 ID。
fn child_ids(tx: &Transaction<'_>, parent_id: &GroupId) -> DomainResult<Vec<String>> {
    let mut stmt = tx
        .prepare("SELECT id FROM session_group WHERE parent_id = ?1 AND deleted_at IS NULL")
        .map_err(map_sql_error)?;
    let rows = stmt
        .query_map(params![parent_id.as_str()], |r| r.get::<_, String>(0))
        .map_err(map_sql_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sql_error)
}

#[async_trait]
impl GroupRepository for GroupRepo {
    async fn list(&self, kind: GroupKind) -> DomainResult<Vec<Group>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {GROUP_COLUMNS} FROM session_group WHERE kind = ?1 AND deleted_at IS NULL \
                     ORDER BY (parent_id IS NOT NULL), sort_order, name COLLATE NOCASE"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map(params![kind.as_str()], group_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn create(
        &self,
        parent_id: Option<GroupId>,
        name: String,
        kind: GroupKind,
    ) -> DomainResult<Group> {
        validate_name(&name)?;
        let id = GroupId::new();
        ensure_id::<GroupId>(id.as_str())?;
        let now = now_ms();
        let group = Group {
            id: id.clone(),
            parent_id: parent_id.clone(),
            name,
            kind,
            sort_order: 1024,
            color: None,
            icon_key: Some("folder".to_string()),
            expanded: true,
            notes: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync: SyncMeta {
                version: 0,
                origin_device_id: None,
                dirty: true,
            },
        };

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let depth = validate_parent(&tx, None, parent_id.as_ref())?;
            if depth >= 8 {
                return Err(DomainError::conflict("group depth exceeds limit"));
            }
            tx.execute(
                "INSERT INTO session_group(id, parent_id, name, kind, sort_order, color, icon_key, \
                 expanded, notes, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, 0, NULL, 1)",
                params![
                    group.id.as_str(),
                    group.parent_id.as_ref().map(|g| g.as_str()),
                    group.name,
                    group.kind.as_str(),
                    group.sort_order,
                    group.color,
                    group.icon_key,
                    group.expanded,
                    group.notes,
                    group.created_at,
                    group.updated_at,
                ],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "group", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })?;

        Ok(group)
    }

    async fn rename(&self, id: &GroupId, name: String) -> DomainResult<Group> {
        validate_name(&name)?;
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let mut group = tx
                .query_row(
                    &format!(
                        "SELECT {GROUP_COLUMNS} FROM session_group WHERE id = ?1 AND deleted_at IS NULL"
                    ),
                    params![id.as_str()],
                    group_from_row,
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("group not found"))?;

            tx.execute(
                "UPDATE session_group SET name = ?1, updated_at = ?2, dirty = 1 \
                 WHERE id = ?3 AND deleted_at IS NULL",
                params![name, now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "group", None)?;
            tx.commit().map_err(map_sql_error)?;

            group.name = name;
            group.updated_at = now;
            group.sync.dirty = true;
            Ok(group)
        })
    }

    async fn delete(&self, id: &GroupId) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let parent_id: Option<String> = tx
                .query_row(
                    "SELECT parent_id FROM session_group WHERE id = ?1 AND deleted_at IS NULL",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("group not found"))?;

            // 子分组上移到父级。
            for child in child_ids(&tx, id)? {
                tx.execute(
                    "UPDATE session_group SET parent_id = ?1, updated_at = ?2, dirty = 1 \
                     WHERE id = ?3",
                    params![parent_id, now, child],
                )
                .map_err(map_sql_error)?;
                bump_sync(&tx, &child, "group", None)?;
            }

            // 会话上移到父级。
            let session_ids: Vec<String> = {
                let mut stmt = tx
                    .prepare("SELECT id FROM session WHERE group_id = ?1 AND deleted_at IS NULL")
                    .map_err(map_sql_error)?;
                let rows = stmt
                    .query_map(params![id.as_str()], |r| r.get::<_, String>(0))
                    .map_err(map_sql_error)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(map_sql_error)?
            };
            for session_id in session_ids {
                tx.execute(
                    "UPDATE session SET group_id = ?1, updated_at = ?2, dirty = 1 WHERE id = ?3",
                    params![parent_id, now, session_id],
                )
                .map_err(map_sql_error)?;
                bump_sync(&tx, &session_id, "session", None)?;
            }

            // 片段上移到父级。
            let snippet_ids: Vec<String> = {
                let mut stmt = tx
                    .prepare("SELECT id FROM snippet WHERE group_id = ?1 AND deleted_at IS NULL")
                    .map_err(map_sql_error)?;
                let rows = stmt
                    .query_map(params![id.as_str()], |r| r.get::<_, String>(0))
                    .map_err(map_sql_error)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(map_sql_error)?
            };
            for snippet_id in snippet_ids {
                tx.execute(
                    "UPDATE snippet SET group_id = ?1, updated_at = ?2, dirty = 1 WHERE id = ?3",
                    params![parent_id, now, snippet_id],
                )
                .map_err(map_sql_error)?;
                bump_sync(&tx, &snippet_id, "snippet", None)?;
            }

            tx.execute(
                "UPDATE session_group SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, id.as_str()],
            )
            .map_err(map_sql_error)?;

            mark_sync_deleted(&tx, id.as_str(), "group")?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }

    async fn move_to(
        &self,
        id: &GroupId,
        parent_id: Option<GroupId>,
        sort_order: i64,
    ) -> DomainResult<Group> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let mut group = tx
                .query_row(
                    &format!(
                        "SELECT {GROUP_COLUMNS} FROM session_group WHERE id = ?1 AND deleted_at IS NULL"
                    ),
                    params![id.as_str()],
                    group_from_row,
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("group not found"))?;

            let depth = validate_parent(&tx, Some(id), parent_id.as_ref())?;
            if depth >= 8 {
                return Err(DomainError::conflict("group depth exceeds limit"));
            }

            tx.execute(
                "UPDATE session_group SET parent_id = ?1, sort_order = ?2, updated_at = ?3, dirty = 1 \
                 WHERE id = ?4 AND deleted_at IS NULL",
                params![parent_id.as_ref().map(|g| g.as_str()), sort_order, now, id.as_str()],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "group", None)?;
            tx.commit().map_err(map_sql_error)?;

            group.parent_id = parent_id;
            group.sort_order = sort_order;
            group.updated_at = now;
            group.sync.dirty = true;
            Ok(group)
        })
    }
}

// 保持 `get_sync` 供后续查询方法复用。
#[allow(dead_code)]
impl GroupRepo {
    /// 读取未删除的分组。
    pub fn get(&self, id: &GroupId) -> DomainResult<Group> {
        self.get_sync(id)
    }
}
