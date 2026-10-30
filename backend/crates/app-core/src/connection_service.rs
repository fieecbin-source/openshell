//! 连接用例服务：SSH 建连编排、凭据解析、生命周期事件广播与断线重连。

use crate::event_bus::EventBus;
use crate::op_registry::OpRegistry;
use openshell_core_domain::{
    AppEvent, AuthMethod, ConnectionId, ConnectionState, DomainError, DomainResult, ErrorCode,
    PromptPolicy, SecretMaterial, SecretResolver, SessionId, SessionRepository,
};
use openshell_ssh::{ConnectOptions, SshConnectionManager};
use openshell_store::{KnownHostRepo, SessionRepo};
use serde::{Deserialize, Serialize};
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
    secret_resolver: Arc<dyn SecretResolver>,
    ssh_manager: Arc<SshConnectionManager>,
    op_registry: Arc<OpRegistry>,
    event_bus: Arc<EventBus>,
}

impl ConnectionService {
    pub fn new(
        session_repo: Arc<SessionRepo>,
        known_host_repo: Arc<KnownHostRepo>,
        secret_resolver: Arc<dyn SecretResolver>,
        ssh_manager: Arc<SshConnectionManager>,
        op_registry: Arc<OpRegistry>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            session_repo,
            known_host_repo,
            secret_resolver,
            ssh_manager,
            op_registry,
            event_bus,
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

        let session = self.session_repo.get(session_id).await?;
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
            self.op_registry.remove(request_id);
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

        tokio::select! {
            _ = cancel_token.cancelled() => {
                self.op_registry.remove(request_id);
                self.event_bus.emit(AppEvent::ConnectionState {
                    connection_id: connection_id.clone(),
                    state: ConnectionState::Closed,
                    attempt: 1,
                    next_retry_ms: None,
                    error: Some("cancelled by user".to_string()),
                });
                Err(DomainError::new(ErrorCode::Cancelled, "connection cancelled by user"))
            }
            res = ssh_manager.connect(opts, Some(known_host_repo)) => {
                self.op_registry.remove(request_id);
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
                        // 连接建立即开始监视其关闭，保证界面状态最终与真实链路一致
                        self.spawn_close_monitor(cid.clone());
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

    /// 断开连接。
    pub async fn disconnect(&self, connection_id: &ConnectionId) -> DomainResult<()> {
        let res = self.ssh_manager.disconnect(connection_id).await;
        self.event_bus.emit(AppEvent::ConnectionState {
            connection_id: connection_id.clone(),
            state: ConnectionState::Closed,
            attempt: 1,
            next_retry_ms: None,
            error: None,
        });
        res
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
