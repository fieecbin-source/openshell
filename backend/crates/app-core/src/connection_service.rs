//! 连接用例服务：SSH 建连编排、凭据解析、生命周期事件广播与断线重连。

use crate::event_bus::EventBus;
use crate::op_registry::{CancellationToken, OpRegistry};
use openshell_core_domain::{
    AppEvent, AuthMethod, ConnectionId, ConnectionState, DomainError, DomainResult, ErrorCode,
    PromptPolicy, Protocol, ProxyServerConfig, SecretMaterial, SecretResolver, Session, SessionId,
    SessionRepository,
};
use openshell_ssh::{ConnectOptions, SshConnectionManager};
use openshell_store::{KnownHostRepo, SessionRepo, SettingsRepo};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectOverrides {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// 私钥口令（连接失败后补录，或临时覆盖已保存口令）。
    pub passphrase: Option<String>,
}

pub struct ConnectionService {
    session_repo: Arc<SessionRepo>,
    known_host_repo: Arc<KnownHostRepo>,
    settings_repo: Arc<SettingsRepo>,
    secret_resolver: Arc<dyn SecretResolver>,
    ssh_manager: Arc<SshConnectionManager>,
    op_registry: Arc<OpRegistry>,
    event_bus: Arc<EventBus>,
    route_dependencies: Arc<tokio::sync::Mutex<HashMap<ConnectionId, Vec<ConnectionId>>>>,
}

impl ConnectionService {
    pub fn new(
        session_repo: Arc<SessionRepo>,
        known_host_repo: Arc<KnownHostRepo>,
        settings_repo: Arc<SettingsRepo>,
        secret_resolver: Arc<dyn SecretResolver>,
        ssh_manager: Arc<SshConnectionManager>,
        op_registry: Arc<OpRegistry>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            session_repo,
            known_host_repo,
            settings_repo,
            secret_resolver,
            ssh_manager,
            op_registry,
            event_bus,
            route_dependencies: Default::default(),
        }
    }

    pub fn ssh_manager(&self) -> Arc<SshConnectionManager> {
        self.ssh_manager.clone()
    }

    /// 发起会话连接。
    pub async fn connect_session(
        &self,
        request_id: &str,
        session_id: &SessionId,
        overrides: Option<ConnectOverrides>,
    ) -> DomainResult<ConnectionId> {
        let cancel_token = self.op_registry.register(request_id);
        // 无论从哪个分支提前返回，都要把 request_id 从注册表里摘除。
        // 历史实现只在部分路径手动 remove，凭据解析失败 / 主机为空等早期错误会让
        // 令牌永久留在 HashMap 中（每次失败的连接尝试泄漏一条）。
        let _op_guard = OpTokenGuard {
            registry: self.op_registry.as_ref(),
            request_id,
        };
        if cancel_token.is_cancelled() {
            return Err(DomainError::new(
                ErrorCode::Cancelled,
                "operation cancelled",
            ));
        }

        let route = self.connection_route(session_id).await?;
        let mut jump = None;
        let mut opened = Vec::new();
        for session in route.into_iter().rev() {
            let is_target = &session.id == session_id;
            if !is_target {
                let mut existing = None;
                // Only reuse independently opened connections; automatic hops belong to their target.
                let reusable: Vec<_> = self
                    .route_dependencies
                    .lock()
                    .await
                    .keys()
                    .cloned()
                    .collect();
                for id in reusable {
                    if let Ok(conn) = self.ssh_manager.get(&id).await {
                        if conn.session_id == session.id && !*conn.closed_channel().borrow() {
                            existing = Some(conn);
                            break;
                        }
                    }
                }
                if let Some(conn) = existing {
                    jump = Some(conn);
                    continue;
                }
            }
            let result = self
                .connect_one(
                    session,
                    if is_target { overrides.clone() } else { None },
                    jump.clone(),
                    &cancel_token,
                )
                .await;
            match result {
                Ok(id) if is_target => {
                    self.route_dependencies
                        .lock()
                        .await
                        .insert(id.clone(), opened);
                    self.spawn_close_monitor(id.clone());
                    return Ok(id);
                }
                Ok(id) => {
                    opened.push(id.clone());
                    self.spawn_close_monitor(id.clone());
                    jump = Some(self.ssh_manager.get(&id).await?);
                }
                Err(error) => {
                    for id in opened.into_iter().rev() {
                        let _ = self.disconnect(&id).await;
                    }
                    return Err(error);
                }
            }
        }
        Err(DomainError::validation("empty SSH connection route"))
    }

    async fn connection_route(&self, session_id: &SessionId) -> DomainResult<Vec<Session>> {
        let mut route = Vec::new();
        let mut visited = HashSet::new();
        let mut next = session_id.clone();
        loop {
            if !visited.insert(next.clone()) {
                return Err(DomainError::validation("ProxyJump 配置存在循环引用"));
            }
            let session = self.session_repo.get(&next).await?;
            if !matches!(session.protocol, Protocol::Ssh | Protocol::Sftp) {
                return Err(DomainError::validation(
                    "SSH 建连及跳板机仅支持 SSH/SFTP 会话",
                ));
            }
            let jump_id = match session.proxy_jump_json.as_ref().filter(|v| !v.is_null()) {
                Some(value) => {
                    let config: ProxyJumpConfig =
                        serde_json::from_value(value.clone()).map_err(|_| {
                            DomainError::validation("ProxyJump 配置需要有效的 session_id")
                        })?;
                    if config.session_id.trim().is_empty() {
                        return Err(DomainError::validation("ProxyJump session_id 不能为空"));
                    }
                    if session.proxy_id.as_deref().is_some_and(|id| !id.is_empty()) {
                        return Err(DomainError::validation(
                            "同一会话不能同时绑定代理服务器与跳板机",
                        ));
                    }
                    Some(SessionId::from_string(config.session_id)?)
                }
                None => None,
            };
            route.push(session);
            match jump_id {
                Some(id) => next = id,
                None => return Ok(route),
            }
        }
    }

    async fn connect_one(
        &self,
        session: Session,
        overrides: Option<ConnectOverrides>,
        jump: Option<Arc<openshell_ssh::SshConnection>>,
        cancel_token: &CancellationToken,
    ) -> DomainResult<ConnectionId> {
        let session_id = &session.id;
        let x11_forwarding = if session.x11_forwarding {
            Some(Arc::new(openshell_ssh::x11::X11Forward::from_environment()?))
        } else {
            None
        };
        let proxy = self.proxy_for_session(&session)?;

        let connection_id = ConnectionId::new();

        self.event_bus.emit(AppEvent::ConnectionState {
            connection_id: connection_id.clone(),
            state: ConnectionState::Resolving,
            attempt: 1,
            next_retry_ms: None,
            error: None,
        });

        let mut password: Option<String> = None;
        let mut private_key_pem: Option<Vec<u8>> = None;
        let mut private_key_passphrase: Option<String> = None;

        if let Some(ref ov) = overrides {
            if let Some(ref p) = ov.password {
                password = Some(p.clone());
            }
        }

        match session.auth_method {
            AuthMethod::Password | AuthMethod::KeyboardInteractive => {
                if password.is_none() {
                    if let Some(ref cred_id) = session.credential_id {
                        let material = self
                            .secret_resolver
                            .resolve_credential(cred_id, PromptPolicy::Interactive)
                            .await?;
                        match material {
                            SecretMaterial::Password(p) => password = Some(p.to_string()),
                            SecretMaterial::KeyboardInteractive(json) => {
                                password = json.as_str().map(|s| s.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            }
            AuthMethod::PublicKey => {
                if let Some(ref key_id) = session.ssh_key_id {
                    let material = self
                        .secret_resolver
                        .resolve_ssh_key(key_id, PromptPolicy::Interactive)
                        .await?;
                    if let SecretMaterial::PrivateKey { pem, passphrase } = material {
                        private_key_pem = Some(pem.to_vec());
                        private_key_passphrase = passphrase.map(|p| p.to_string());
                    }
                }
                // 用户在连接失败弹窗中补录的口令优先于已保存口令
                if let Some(ref pass) = overrides.as_ref().and_then(|o| o.passphrase.clone()) {
                    if !pass.is_empty() {
                        private_key_passphrase = Some(pass.clone());
                    }
                }
            }
            AuthMethod::Agent | AuthMethod::None => {}
        }

        if cancel_token.is_cancelled() {
            return Err(DomainError::new(
                ErrorCode::Cancelled,
                "connection cancelled",
            ));
        }

        let host = overrides
            .as_ref()
            .and_then(|o| o.host.clone())
            .or_else(|| session.host.clone())
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .ok_or_else(|| DomainError::validation("目标服务器主机地址 (IP 或域名) 不能为空"))?;

        let port = overrides
            .as_ref()
            .and_then(|o| o.port)
            .or(session.port)
            .unwrap_or(22);

        let username = overrides
            .as_ref()
            .and_then(|o| o.username.clone())
            .or_else(|| session.username.clone())
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "root".to_string());

        let opts = ConnectOptions {
            connection_id: connection_id.clone(),
            session_id: session.id.clone(),
            host,
            port,
            username,
            auth_method: session.auth_method,
            password,
            private_key_pem,
            private_key_passphrase,
            host_key_policy: session.host_key_policy,
            keepalive_sec: session.keepalive_sec.max(0) as u64,
            // 连续失败达到会话配置的次数才判定失联，避免偶发丢包直接断连
            keepalive_max_miss: session.keepalive_max_miss.max(1) as u32,
            timeout_sec: 15,
            compression: session.compression,
            agent_forwarding: session.agent_forwarding,
            x11_forwarding,
        };

        self.event_bus.emit(AppEvent::ConnectionState {
            connection_id: connection_id.clone(),
            state: ConnectionState::Tcp,
            attempt: 1,
            next_retry_ms: None,
            error: None,
        });

        // 异步建连，同时监听取消信号
        let known_host_repo = self.known_host_repo.clone();
        let ssh_manager = self.ssh_manager.clone();

        let connect = async {
            if let Some(jump) = jump {
                let stream = jump.open_direct_tcpip(&opts.host, opts.port).await?;
                ssh_manager
                    .connect_stream(opts, Some(known_host_repo), stream)
                    .await
            } else {
                ssh_manager
                    .connect_via_proxy(opts, Some(known_host_repo), proxy.as_ref())
                    .await
            }
        };
        tokio::select! {
            _ = cancel_token.cancelled() => {
                self.event_bus.emit(AppEvent::ConnectionState {
                    connection_id: connection_id.clone(),
                    state: ConnectionState::Closed,
                    attempt: 1,
                    next_retry_ms: None,
                    error: Some("cancelled by user".to_string()),
                });
                Err(DomainError::new(ErrorCode::Cancelled, "connection cancelled by user"))
            }
            res = connect => {
                match res {
                    Ok(cid) => {
                        let _ = self.session_repo.touch_used(session_id, "success").await;
                        self.event_bus.emit(AppEvent::ConnectionState {
                            connection_id: cid.clone(),
                            state: ConnectionState::Ready,
                            attempt: 1,
                            next_retry_ms: None,
                            error: None,
                        });
                        Ok(cid)
                    }
                    Err(e) => {
                        let _ = self.session_repo.touch_used(session_id, "failed").await;
                        self.event_bus.emit(AppEvent::ConnectionState {
                            connection_id: connection_id.clone(),
                            state: ConnectionState::Closed,
                            attempt: 1,
                            next_retry_ms: None,
                            error: Some(e.to_string()),
                        });
                        Err(e)
                    }
                }
            }
        }
    }

    fn proxy_for_session(&self, session: &Session) -> DomainResult<Option<ProxyServerConfig>> {
        let Some(id) = session.proxy_id.as_deref().filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let proxies: Vec<ProxyServerConfig> =
            match self.settings_repo.get("global", None, "proxy_list")? {
                Some(record) => serde_json::from_value(record.value_json)
                    .map_err(|_| DomainError::validation("代理服务器配置无效"))?,
                None => Vec::new(),
            };
        proxies
            .into_iter()
            .find(|proxy| proxy.id == id)
            .map(Some)
            .ok_or_else(|| DomainError::validation("会话绑定的代理服务器不存在"))
    }

    /// 断开连接。
    pub async fn disconnect(&self, connection_id: &ConnectionId) -> DomainResult<()> {
        let res = self.ssh_manager.disconnect(connection_id).await;
        self.close_route_dependencies(connection_id).await;
        self.event_bus.emit(AppEvent::ConnectionState {
            connection_id: connection_id.clone(),
            state: ConnectionState::Closed,
            attempt: 1,
            next_retry_ms: None,
            error: None,
        });
        res
    }

    async fn close_route_dependencies(&self, connection_id: &ConnectionId) {
        let hops = self
            .route_dependencies
            .lock()
            .await
            .remove(connection_id)
            .unwrap_or_default();
        for hop in hops.into_iter().rev() {
            let _ = self.ssh_manager.disconnect(&hop).await;
            self.event_bus.emit(AppEvent::ConnectionState {
                connection_id: hop,
                state: ConnectionState::Closed,
                attempt: 1,
                next_retry_ms: None,
                error: None,
            });
        }
    }

    /// 列出所有活动连接。
    pub async fn list_connections(&self) -> Vec<ConnectionId> {
        self.ssh_manager.list().await
    }

    /// 监视连接关闭：远端退出、sshd 被杀、网络中断或保活连续失败时，
    /// 清理连接表并向前端发送 `ConnectionState::Closed`。
    ///
    /// 历史实现完全不发送该事件，界面会永远停留在「已连接」，
    /// 用户只能看到终端不再响应（哑死）。
    fn spawn_close_monitor(&self, connection_id: ConnectionId) {
        let manager = self.ssh_manager.clone();
        let bus = self.event_bus.clone();
        let cid = connection_id.clone();
        let dependencies = self.route_dependencies.clone();

        tokio::spawn(async move {
            let mut rx = match manager.get(&cid).await {
                Ok(conn) => conn.closed_channel(),
                Err(_) => return,
            };

            // watch 会保存最后一次值，若订阅时连接已关闭则 changed() 不会触发，
            // 需要先看当前值。
            if !*rx.borrow() {
                // 发送端被 drop 时 changed() 返回 Err，同样视为已关闭
                let _ = rx.changed().await;
            }

            // 只有仍登记在管理器中才发事件：用户主动断开时条目已被移除，
            // 这里返回 false，避免重复发送 Closed。
            if manager.remove_if_active(&cid).await {
                let hops = dependencies.lock().await.remove(&cid).unwrap_or_default();
                for hop in hops.into_iter().rev() {
                    let _ = manager.disconnect(&hop).await;
                    bus.emit(AppEvent::ConnectionState {
                        connection_id: hop,
                        state: ConnectionState::Closed,
                        attempt: 1,
                        next_retry_ms: None,
                        error: None,
                    });
                }
                tracing::warn!(connection_id = %cid, "ssh connection closed or lost");
                bus.emit(AppEvent::ConnectionState {
                    connection_id: cid,
                    state: ConnectionState::Closed,
                    attempt: 1,
                    next_retry_ms: None,
                    error: Some("与服务器的连接已断开（远端关闭或心跳失联）".to_string()),
                });
            }
        });
    }
}

#[derive(Deserialize)]
struct ProxyJumpConfig {
    session_id: String,
}

/// `connect_session` 的取消令牌守卫：无论从哪个分支提前返回，
/// 都会把 `request_id` 从操作注册表中移除。
struct OpTokenGuard<'a> {
    registry: &'a OpRegistry,
    request_id: &'a str,
}

impl Drop for OpTokenGuard<'_> {
    fn drop(&mut self) {
        self.registry.remove(self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppServices;
    use openshell_core_domain::{SessionInput, SessionPatch};
    use serde_json::json;

    async fn session(services: &AppServices, name: &str, jump: Option<&SessionId>) -> Session {
        services
            .session
            .create_session(SessionInput {
                name: Some(name.to_string()),
                host: Some("127.0.0.1".to_string()),
                proxy_jump_json: jump.map(|id| json!({"session_id": id})),
                ..Default::default()
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn jump_route_is_ordered_and_rejects_cycles_before_dialing() {
        let services = AppServices::new_in_memory().unwrap();
        let jump = session(&services, "jump", None).await;
        let target = session(&services, "target", Some(&jump.id)).await;
        let route = services
            .connection
            .connection_route(&target.id)
            .await
            .unwrap();
        assert_eq!(
            route.iter().map(|s| &s.id).collect::<Vec<_>>(),
            vec![&target.id, &jump.id]
        );
        services
            .connection
            .session_repo
            .update(
                &jump.id,
                SessionPatch {
                    proxy_jump_json: Some(Some(json!({"session_id": target.id}))),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        let error = services
            .connection
            .connect_session("cycle-test", &target.id, None)
            .await
            .unwrap_err();
        assert!(error.message.contains("循环"));
        assert!(services.connection.list_connections().await.is_empty());
        assert!(!services.op_registry.cancel("cycle-test"));
    }

    #[tokio::test]
    async fn jump_route_rejects_non_ssh_and_ambiguous_transport() {
        let services = AppServices::new_in_memory().unwrap();
        let jump = session(&services, "jump", None).await;
        let target = session(&services, "target", Some(&jump.id)).await;
        services
            .connection
            .session_repo
            .update(
                &jump.id,
                SessionPatch {
                    protocol: Some(Protocol::Telnet),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        assert!(services
            .connection
            .connection_route(&target.id)
            .await
            .unwrap_err()
            .message
            .contains("SSH/SFTP"));
        services
            .connection
            .session_repo
            .update(
                &target.id,
                SessionPatch {
                    proxy_id: Some("proxy".to_string()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        assert!(services
            .connection
            .connection_route(&target.id)
            .await
            .unwrap_err()
            .message
            .contains("同时"));
    }

    #[tokio::test]
    async fn disconnect_releases_only_the_targets_automatic_hops() {
        let services = AppServices::new_in_memory().unwrap();
        let target = ConnectionId::new();
        let other = ConnectionId::new();
        let hop = ConnectionId::new();
        services
            .connection
            .route_dependencies
            .lock()
            .await
            .insert(target.clone(), vec![hop]);
        services
            .connection
            .route_dependencies
            .lock()
            .await
            .insert(other.clone(), vec![]);
        // Cleanup must still run if the manager already observed the target's EOF.
        assert!(services.connection.disconnect(&target).await.is_err());
        let dependencies = services.connection.route_dependencies.lock().await;
        assert!(!dependencies.contains_key(&target));
        assert!(dependencies.contains_key(&other));
    }

    #[tokio::test]
    async fn bound_proxy_must_exist_and_is_loaded_from_settings() {
        let services = AppServices::new_in_memory().unwrap();
        let mut target = session(&services, "target", None).await;
        target.proxy_id = Some("proxy".to_string());
        assert!(services.connection.proxy_for_session(&target).is_err());
        services.settings_repo.set("global", None, "proxy_list", json!([{
            "id": "proxy", "name": "test", "proxy_type": "socks5", "host": "127.0.0.1", "port": 1080
        }]), false).unwrap();
        let proxy = services
            .connection
            .proxy_for_session(&target)
            .unwrap()
            .unwrap();
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 1080);
        target.proxy_id = None;
        assert!(services
            .connection
            .proxy_for_session(&target)
            .unwrap()
            .is_none());
    }
}
