//! 端口转发规则仓储实现。

use crate::models::{
    bump_sync, ensure_id, map_sql_error, mark_sync_deleted, port_forward_from_row,
    PORT_FORWARD_COLUMNS,
};
use crate::Store;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, DomainError, DomainResult, PortForwardId, PortForwardRepository, PortForwardRule,
    PortForwardRuleInput, PortForwardType, SessionId, SocksAuth, SyncMeta,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

/// 端口转发规则仓储。
pub struct PortForwardRepo {
    store: Store,
}

impl PortForwardRepo {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
}

#[async_trait]
impl PortForwardRepository for PortForwardRepo {
    async fn list(&self, session_id: Option<&SessionId>) -> DomainResult<Vec<PortForwardRule>> {
        self.store.with_conn(|conn| {
            let sql = match session_id {
                Some(_sid) => format!(
                    "SELECT {PORT_FORWARD_COLUMNS} FROM port_forward WHERE deleted_at IS NULL AND session_id = ?1 ORDER BY sort_order ASC, name ASC"
                ),
                None => format!(
                    "SELECT {PORT_FORWARD_COLUMNS} FROM port_forward WHERE deleted_at IS NULL ORDER BY sort_order ASC, name ASC"
                ),
            };
            let mut stmt = conn.prepare(&sql).map_err(map_sql_error)?;
            let rows = if let Some(sid) = session_id {
                stmt.query_map(params![sid.as_str()], port_forward_from_row)
                    .map_err(map_sql_error)?
            } else {
                stmt.query_map([], port_forward_from_row).map_err(map_sql_error)?
            };
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    async fn get(&self, id: &PortForwardId) -> DomainResult<PortForwardRule> {
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {PORT_FORWARD_COLUMNS} FROM port_forward WHERE id = ?1 AND deleted_at IS NULL"),
                params![id.as_str()],
                port_forward_from_row,
            )
            .optional()
            .map_err(map_sql_error)?
            .ok_or_else(|| DomainError::not_found("port forward rule not found"))
        })
    }

    async fn create(&self, input: PortForwardRuleInput) -> DomainResult<PortForwardRule> {
        if input.name.trim().is_empty() {
            return Err(DomainError::validation("rule name cannot be empty"));
        }
        let id = PortForwardId::new();
        let now = now_ms();
        let rule_type = input.rule_type.unwrap_or(PortForwardType::Local);
        let bind_host = input.bind_host.unwrap_or_else(|| "127.0.0.1".to_string());
        let auto_start = input.auto_start.unwrap_or(false);
        let auto_reconnect = input.auto_reconnect.unwrap_or(true);
        let reconnect_max = input.reconnect_max.unwrap_or(7);
        let socks_auth = input.socks_auth.unwrap_or(SocksAuth::None);
        let expose_warning_ack = input.expose_warning_ack.unwrap_or(false);
        let sort_order = input.sort_order.unwrap_or(1024);
        let session_id_str = input.session_id.as_ref().map(|s| s.as_str().to_string());

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            bump_sync(&tx, id.as_str(), "port_forward", None)?;

            tx.execute(
                "INSERT INTO port_forward(id, session_id, name, type, bind_host, bind_port, \
                 dest_host, dest_port, auto_start, auto_reconnect, reconnect_max, socks_auth, \
                 socks_username, socks_password_ref, expose_warning_ack, sort_order, \
                 created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL, 0, NULL, 1)",
                params![
                    id.as_str(),
                    session_id_str.as_deref(),
                    input.name,
                    rule_type.as_str(),
                    bind_host,
                    input.bind_port as i64,
                    input.dest_host,
                    input.dest_port.map(|p| p as i64),
                    if auto_start { 1 } else { 0 },
                    if auto_reconnect { 1 } else { 0 },
                    reconnect_max,
                    socks_auth.as_str(),
                    input.socks_username,
                    input.socks_password_ref,
                    if expose_warning_ack { 1 } else { 0 },
                    sort_order,
                    now,
                    now,
                ],
            )
            .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)?;

            Ok(PortForwardRule {
                id,
                session_id: input.session_id,
                name: input.name,
                rule_type,
                bind_host,
                bind_port: input.bind_port,
                dest_host: input.dest_host,
                dest_port: input.dest_port,
                auto_start,
                auto_reconnect,
                reconnect_max,
                socks_auth,
                socks_username: input.socks_username,
                socks_password_ref: input.socks_password_ref,
                expose_warning_ack,
                sort_order,
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

    async fn update(
        &self,
        id: &PortForwardId,
        input: PortForwardRuleInput,
    ) -> DomainResult<PortForwardRule> {
        ensure_id::<PortForwardId>(id.as_str())?;
        if input.name.trim().is_empty() {
            return Err(DomainError::validation("rule name cannot be empty"));
        }
        let now = now_ms();
        let rule_type = input.rule_type.unwrap_or(PortForwardType::Local);
        let bind_host = input.bind_host.unwrap_or_else(|| "127.0.0.1".to_string());
        let auto_start = input.auto_start.unwrap_or(false);
        let auto_reconnect = input.auto_reconnect.unwrap_or(true);
        let reconnect_max = input.reconnect_max.unwrap_or(7);
        let socks_auth = input.socks_auth.unwrap_or(SocksAuth::None);
        let expose_warning_ack = input.expose_warning_ack.unwrap_or(false);
        let sort_order = input.sort_order.unwrap_or(1024);
        let session_id_str = input.session_id.as_ref().map(|s| s.as_str().to_string());

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            bump_sync(&tx, id.as_str(), "port_forward", None)?;

            let affected = tx.execute(
                "UPDATE port_forward SET session_id = ?1, name = ?2, type = ?3, bind_host = ?4, \
                 bind_port = ?5, dest_host = ?6, dest_port = ?7, auto_start = ?8, \
                 auto_reconnect = ?9, reconnect_max = ?10, socks_auth = ?11, \
                 socks_username = ?12, socks_password_ref = ?13, expose_warning_ack = ?14, \
                 sort_order = ?15, updated_at = ?16, dirty = 1 \
                 WHERE id = ?17 AND deleted_at IS NULL",
                params![
                    session_id_str.as_deref(),
                    input.name,
                    rule_type.as_str(),
                    bind_host,
                    input.bind_port as i64,
                    input.dest_host,
                    input.dest_port.map(|p| p as i64),
                    if auto_start { 1 } else { 0 },
                    if auto_reconnect { 1 } else { 0 },
                    reconnect_max,
                    socks_auth.as_str(),
                    input.socks_username,
                    input.socks_password_ref,
                    if expose_warning_ack { 1 } else { 0 },
                    sort_order,
                    now,
                    id.as_str(),
                ],
            )
            .map_err(map_sql_error)?;

            if affected == 0 {
                return Err(DomainError::not_found("port forward rule not found"));
            }

            let version: i64 = tx
                .query_row(
                    "SELECT version FROM port_forward WHERE id = ?1",
                    params![id.as_str()],
                    |r| r.get(0),
                )
                .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)?;

            Ok(PortForwardRule {
                id: id.clone(),
                session_id: input.session_id,
                name: input.name,
                rule_type,
                bind_host,
                bind_port: input.bind_port,
                dest_host: input.dest_host,
                dest_port: input.dest_port,
                auto_start,
                auto_reconnect,
                reconnect_max,
                socks_auth,
                socks_username: input.socks_username,
                socks_password_ref: input.socks_password_ref,
                expose_warning_ack,
                sort_order,
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

    async fn delete(&self, id: &PortForwardId) -> DomainResult<()> {
        ensure_id::<PortForwardId>(id.as_str())?;
        let now = now_ms();
        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            mark_sync_deleted(&tx, id.as_str(), "port_forward")?;

            let affected = tx
                .execute(
                    "UPDATE port_forward SET deleted_at = ?1, dirty = 1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id.as_str()],
                )
                .map_err(map_sql_error)?;

            if affected == 0 {
                return Err(DomainError::not_found("port forward rule not found"));
            }

            tx.commit().map_err(map_sql_error)?;
            Ok(())
        })
    }
}
