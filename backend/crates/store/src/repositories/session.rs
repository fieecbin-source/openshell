//! 会话仓储。

use crate::models::{
    bump_sync, ensure_id, host_key_policy_str, map_sql_error, mark_sync_deleted, session_from_row,
    SESSION_COLUMNS,
};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, AuthMethod, DomainError, DomainResult, HostKeyPolicy, Protocol, Session, SessionId,
    SessionInput, SessionPatch, SessionQuery, SessionRepository, SyncMeta,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

/// 会话仓储。
pub struct SessionRepo {
    store: Store,
}

impl SessionRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    fn get_sync(&self, id: &SessionId) -> DomainResult<Session> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id.as_str()],
                session_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("session not found"))
        })
    }
}

fn default_name(input: &SessionInput) -> String {
    match (&input.username, &input.host) {
        (Some(user), Some(host)) => format!("{user}@{host}"),
        (_, Some(host)) => host.clone(),
        _ => "untitled session".to_string(),
    }
}

fn apply_patch(mut s: Session, patch: SessionPatch) -> Session {
    if let Some(v) = patch.group_id {
        s.group_id = v;
    }
    if let Some(v) = patch.name {
        s.name = v;
    }
    if let Some(v) = patch.protocol {
        s.protocol = v;
    }
    if let Some(v) = patch.host {
        s.host = v;
    }
    if let Some(v) = patch.port {
        s.port = v;
    }
    if let Some(v) = patch.username {
        s.username = v;
    }
    if let Some(v) = patch.auth_method {
        s.auth_method = v;
    }
    if let Some(v) = patch.credential_id {
        s.credential_id = v;
    }
    if let Some(v) = patch.ssh_key_id {
        s.ssh_key_id = v;
    }
    if let Some(v) = patch.host_key_policy {
        s.host_key_policy = v;
    }
    if let Some(v) = patch.proxy_jump_json {
        s.proxy_jump_json = v;
    }
    if let Some(v) = patch.terminal_profile_id {
        s.terminal_profile_id = v;
    }
    if let Some(v) = patch.encoding {
        s.encoding = v;
    }
    if let Some(v) = patch.startup_command {
        s.startup_command = v;
    }
    if let Some(v) = patch.working_dir {
        s.working_dir = v;
    }
    if let Some(v) = patch.keepalive_sec {
        s.keepalive_sec = v;
    }
    if let Some(v) = patch.keepalive_max_miss {
        s.keepalive_max_miss = v;
    }
    if let Some(v) = patch.auto_reconnect {
        s.auto_reconnect = v;
    }
    if let Some(v) = patch.reconnect_max {
        s.reconnect_max = v;
    }
    if let Some(v) = patch.compression {
        s.compression = v;
    }
    if let Some(v) = patch.agent_forwarding {
        s.agent_forwarding = v;
    }
    if let Some(v) = patch.tags_json {
        s.tags_json = v;
    }
    if let Some(v) = patch.favorite {
        s.favorite = v;
    }
    if let Some(v) = patch.color {
        s.color = v;
    }
    if let Some(v) = patch.icon_key {
        s.icon_key = v;
    }
    if let Some(v) = patch.notes {
        s.notes = v;
    }
    if let Some(v) = patch.protocol_options_json {
        s.protocol_options_json = v;
    }
    if let Some(v) = patch.sort_order {
        s.sort_order = v;
    }
    s
}

#[async_trait]
impl SessionRepository for SessionRepo {
    async fn list(&self, q: &SessionQuery) -> DomainResult<Vec<Session>> {
        self.store.with_conn(|conn| {
            let mut sql = format!("SELECT {SESSION_COLUMNS} FROM session WHERE 1 = 1");
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

            if !q.include_deleted {
                sql.push_str(" AND deleted_at IS NULL");
            }
            if let Some(group) = &q.group_id {
                sql.push_str(" AND group_id = ?");
                args.push(Box::new(group.as_str().to_string()));
            }
            if let Some(protocol) = &q.protocol {
                sql.push_str(" AND protocol = ?");
                args.push(Box::new(protocol.as_str().to_string()));
            }
            if q.favorite_only {
                sql.push_str(" AND favorite = 1");
            }
            if let Some(query) = &q.query {
                sql.push_str(" AND (name LIKE ? OR host LIKE ? OR username LIKE ?)");
                let pattern = format!("%{query}%");
                args.push(Box::new(pattern.clone()));
                args.push(Box::new(pattern.clone()));
                args.push(Box::new(pattern));
            }
            sql.push_str(" ORDER BY favorite DESC, sort_order ASC, name COLLATE NOCASE ASC");
            if q.limit > 0 {
                sql.push_str(" LIMIT ? OFFSET ?");
                args.push(Box::new(i64::from(q.limit)));
                args.push(Box::new(i64::from(q.offset)));
            }

            let mut stmt = conn.prepare(&sql).map_err(map_sql_error)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(args), session_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn get(&self, id: &SessionId) -> DomainResult<Session> {
        self.get_sync(id)
    }

    async fn create(&self, input: SessionInput) -> DomainResult<Session> {
        let id = SessionId::new();
        ensure_id::<SessionId>(id.as_str())?;

        let name = input.name.clone().unwrap_or_else(|| default_name(&input));
        if name.is_empty() || name.chars().count() > 128 {
            return Err(DomainError::validation("invalid session name"));
        }

        let now = now_ms();
        let protocol = input.protocol.unwrap_or(Protocol::Ssh);
        let session = Session {
            id: id.clone(),
            group_id: input.group_id,
            name,
            protocol,
            host: input.host,
            port: input.port.or_else(|| protocol.default_port()),
            username: input.username,
            auth_method: input.auth_method.unwrap_or(AuthMethod::Password),
            credential_id: input.credential_id,
            ssh_key_id: input.ssh_key_id,
            host_key_policy: input.host_key_policy.unwrap_or(HostKeyPolicy::AcceptNew),
            proxy_jump_json: input.proxy_jump_json,
            proxy_id: None,
            terminal_profile_id: input.terminal_profile_id,
            encoding: input.encoding.unwrap_or_else(|| "UTF-8".to_string()),
            startup_command: input.startup_command,
            working_dir: input.working_dir,
            keepalive_sec: input.keepalive_sec.unwrap_or(30),
            keepalive_max_miss: input.keepalive_max_miss.unwrap_or(3),
            auto_reconnect: input.auto_reconnect.unwrap_or(false),
            reconnect_max: input.reconnect_max.unwrap_or(7),
            compression: input.compression.unwrap_or(false),
            agent_forwarding: input.agent_forwarding.unwrap_or(false),
            x11_forwarding: false,
            tags_json: Some(input.tags_json.unwrap_or_else(|| Value::Array(Vec::new()))),
            favorite: input.favorite.unwrap_or(false),
            color: input.color,
            icon_key: input.icon_key,
            notes: input.notes,
            protocol_options_json: input.protocol_options_json,
            last_used_at: None,
            last_result: None,
            use_count: 0,
            sort_order: input.sort_order.unwrap_or(1024),
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
            tx.execute(
                "INSERT INTO session(id, group_id, name, protocol, host, port, username, auth_method, \
                 credential_id, ssh_key_id, host_key_policy, proxy_jump_json, proxy_id, \
                 terminal_profile_id, encoding, startup_command, working_dir, keepalive_sec, \
                 keepalive_max_miss, auto_reconnect, reconnect_max, compression, agent_forwarding, \
                 x11_forwarding, tags_json, favorite, color, icon_key, notes, protocol_options_json, \
                 last_used_at, last_result, use_count, sort_order, created_at, updated_at, deleted_at, \
                 version, origin_device_id, dirty) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
                 ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, \
                 ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40)",
                params![
                    session.id.as_str(),
                    session.group_id.as_ref().map(|g| g.as_str()),
                    session.name,
                    session.protocol.as_str(),
                    session.host,
                    session.port.map(i64::from),
                    session.username,
                    session.auth_method.as_str(),
                    session.credential_id.as_ref().map(|c| c.as_str()),
                    session.ssh_key_id.as_ref().map(|k| k.as_str()),
                    host_key_policy_str(session.host_key_policy),
                    session.proxy_jump_json,
                    session.proxy_id,
                    session.terminal_profile_id,
                    session.encoding,
                    session.startup_command,
                    session.working_dir,
                    session.keepalive_sec,
                    session.keepalive_max_miss,
                    session.auto_reconnect,
                    session.reconnect_max,
                    session.compression,
                    session.agent_forwarding,
                    session.x11_forwarding,
                    session.tags_json,
                    session.favorite,
                    session.color,
                    session.icon_key,
                    session.notes,
                    session.protocol_options_json,
                    session.last_used_at,
                    session.last_result,
                    session.use_count,
                    session.sort_order,
                    session.created_at,
                    session.updated_at,
                    session.deleted_at,
                    session.sync.version,
                    session.sync.origin_device_id,
                    session.sync.dirty,
                ],
            )
            .map_err(map_sql_error)?;
            bump_sync(&tx, id.as_str(), "session", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })?;

        Ok(session)
    }

    async fn update(
        &self,
        id: &SessionId,
        patch: SessionPatch,
        expected_local_rev: Option<i64>,
    ) -> DomainResult<Session> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let existing = tx
                .query_row(
                    &format!(
                        "SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1 AND deleted_at IS NULL"
                    ),
                    params![id.as_str()],
                    session_from_row,
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("session not found"))?;

            let mut updated = apply_patch(existing, patch);
            if updated.name.is_empty() || updated.name.chars().count() > 128 {
                return Err(DomainError::validation("invalid session name"));
            }
            updated.updated_at = now;
            updated.sync.dirty = true;

            bump_sync(&tx, id.as_str(), "session", expected_local_rev)?;

            tx.execute(
                "UPDATE session SET group_id = ?1, name = ?2, protocol = ?3, host = ?4, port = ?5, \
                 username = ?6, auth_method = ?7, credential_id = ?8, ssh_key_id = ?9, \
                 host_key_policy = ?10, proxy_jump_json = ?11, proxy_id = ?12, \
                 terminal_profile_id = ?13, encoding = ?14, startup_command = ?15, working_dir = ?16, \
                 keepalive_sec = ?17, keepalive_max_miss = ?18, auto_reconnect = ?19, \
                 reconnect_max = ?20, compression = ?21, agent_forwarding = ?22, x11_forwarding = ?23, \
                 tags_json = ?24, favorite = ?25, color = ?26, icon_key = ?27, notes = ?28, \
                 protocol_options_json = ?29, last_used_at = ?30, last_result = ?31, use_count = ?32, \
                 sort_order = ?33, updated_at = ?34, deleted_at = ?35, version = ?36, \
                 origin_device_id = ?37, dirty = 1 WHERE id = ?38 AND deleted_at IS NULL",
                params![
                    updated.group_id.as_ref().map(|g| g.as_str()),
                    updated.name,
                    updated.protocol.as_str(),
                    updated.host,
                    updated.port.map(i64::from),
                    updated.username,
                    updated.auth_method.as_str(),
                    updated.credential_id.as_ref().map(|c| c.as_str()),
                    updated.ssh_key_id.as_ref().map(|k| k.as_str()),
                    host_key_policy_str(updated.host_key_policy),
                    updated.proxy_jump_json,
                    updated.proxy_id,
                    updated.terminal_profile_id,
                    updated.encoding,
                    updated.startup_command,
                    updated.working_dir,
                    updated.keepalive_sec,
                    updated.keepalive_max_miss,
                    updated.auto_reconnect,
                    updated.reconnect_max,
                    updated.compression,
                    updated.agent_forwarding,
                    updated.x11_forwarding,
                    updated.tags_json,
                    updated.favorite,
                    updated.color,
                    updated.icon_key,
                    updated.notes,
                    updated.protocol_options_json,
                    updated.last_used_at,
                    updated.last_result,
                    updated.use_count,
                    updated.sort_order,
                    updated.updated_at,
                    updated.deleted_at,
                    updated.sync.version,
                    updated.sync.origin_device_id,
                    id.as_str(),
                ],
            )
            .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)?;
            Ok(updated)
        })
    }

    async fn delete(&self, id: &SessionId) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let affected = tx
                .execute(
                    "UPDATE session SET deleted_at = ?1, updated_at = ?1, dirty = 1 \
                     WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("session not found"));
            }
            mark_sync_deleted(&tx, id.as_str(), "session")?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }

    async fn restore(&self, id: &SessionId) -> DomainResult<Session> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let affected = tx
                .execute(
                    "UPDATE session SET deleted_at = NULL, updated_at = ?1, dirty = 1 \
                     WHERE id = ?2 AND deleted_at IS NOT NULL",
                    params![now, id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected > 0 {
                bump_sync(&tx, id.as_str(), "session", None)?;
            }
            let session = tx
                .query_row(
                    &format!(
                        "SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1 AND deleted_at IS NULL"
                    ),
                    params![id.as_str()],
                    session_from_row,
                )
                .optional()
                .map_err(map_sql_error)?
                .ok_or_else(|| DomainError::not_found("session not found"))?;
            tx.commit().map_err(map_sql_error)?;
            Ok(session)
        })
    }

    async fn touch_used(&self, id: &SessionId, result: &str) -> DomainResult<()> {
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;
            let affected = tx
                .execute(
                    "UPDATE session SET last_used_at = ?1, last_result = ?2, use_count = use_count + 1, \
                     updated_at = ?1, dirty = 1 WHERE id = ?3 AND deleted_at IS NULL",
                    params![now, result, id.as_str()],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("session not found"));
            }
            bump_sync(&tx, id.as_str(), "session", None)?;
            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
