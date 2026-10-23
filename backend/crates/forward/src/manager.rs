//! 端口转发运行时管理器。

use crate::socks5::handle_socks5_handshake;
use openshell_core_domain::{
    DomainError, DomainResult, ErrorCode, PortForwardId, PortForwardRule, PortForwardType,
};
use openshell_ssh::SshConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "details")]
pub enum ForwardStatus {
    Stopped,
    Listening { bound_addr: String },
    Error(String),
}

struct RunningForward {
    #[allow(dead_code)]
    rule: PortForwardRule,
    status: ForwardStatus,
    handle: JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct ForwardManager {
    running: Arc<RwLock<HashMap<PortForwardId, RunningForward>>>,
}

impl ForwardManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 获取某规则的运行状态。
    pub async fn get_status(&self, id: &PortForwardId) -> ForwardStatus {
        let running = self.running.read().await;
        running
            .get(id)
            .map(|r| r.status.clone())
            .unwrap_or(ForwardStatus::Stopped)
    }

    /// 列出所有活跃规则状态映射。
    pub async fn list_statuses(&self) -> HashMap<PortForwardId, ForwardStatus> {
        let running = self.running.read().await;
        running
            .iter()
            .map(|(id, r)| (id.clone(), r.status.clone()))
            .collect()
    }

    /// 启动转发规则。
    pub async fn start_rule(
        &self,
        rule: PortForwardRule,
        conn: Arc<SshConnection>,
    ) -> DomainResult<()> {
        let id = rule.id.clone();
        self.stop_rule(&id).await;

        let bind_addr = format!("{}:{}", rule.bind_host, rule.bind_port);
        let listener = TcpListener::bind(&bind_addr).await.map_err(|e| {
            DomainError::new(
                ErrorCode::ForwardBind,
                format!("failed to bind {}: {}", bind_addr, e),
            )
        })?;

        let actual_addr = listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| bind_addr.clone());

        let rule_clone = rule.clone();
        let handle = tokio::spawn(async move {
            match rule_clone.rule_type {
                PortForwardType::Local => {
                    let dest_host = rule_clone.dest_host.unwrap_or_default();
                    let dest_port = rule_clone.dest_port.unwrap_or(80);
                    while let Ok((mut local_stream, _)) = listener.accept().await {
                        let conn_clone = Arc::clone(&conn);
                        let d_host = dest_host.clone();
                        tokio::spawn(async move {
                            if let Ok(mut ssh_stream) =
                                conn_clone.open_direct_tcpip(&d_host, dest_port).await
                            {
                                let _ = tokio::io::copy_bidirectional(
                                    &mut local_stream,
                                    &mut ssh_stream,
                                )
                                .await;
                            }
                        });
                    }
                }
                PortForwardType::Dynamic => {
                    let auth_mode = rule_clone.socks_auth;
                    let username = rule_clone.socks_username.clone();
                    let password: Option<String> = None; // 经 SecretResolver 或规则指定

                    while let Ok((mut local_stream, _)) = listener.accept().await {
                        let conn_clone = Arc::clone(&conn);
                        let u_opt = username.clone();
                        let p_opt = password.clone();
                        tokio::spawn(async move {
                            let handshake_res = handle_socks5_handshake(
                                &mut local_stream,
                                auth_mode,
                                u_opt.as_deref(),
                                p_opt.as_deref(),
                            )
                            .await;

                            if let Ok((target_host, target_port)) = handshake_res {
                                if let Ok(mut ssh_stream) = conn_clone
                                    .open_direct_tcpip(&target_host, target_port)
                                    .await
                                {
                                    let _ = tokio::io::copy_bidirectional(
                                        &mut local_stream,
                                        &mut ssh_stream,
                                    )
                                    .await;
                                }
                            }
                        });
                    }
                }
                PortForwardType::Remote => {
                    // 远程端口转发由 russh 远程转发监听
                    tracing::info!(rule_id = %rule_clone.id, "remote port forward started");
                }
            }
        });

        let mut running = self.running.write().await;
        running.insert(
            id,
            RunningForward {
                rule,
                status: ForwardStatus::Listening {
                    bound_addr: actual_addr,
                },
                handle,
            },
        );

        Ok(())
    }

    /// 停止转发规则。
    pub async fn stop_rule(&self, id: &PortForwardId) {
        let mut running = self.running.write().await;
        if let Some(rf) = running.remove(id) {
            rf.handle.abort();
        }
    }

    /// 停止所有活跃转发规则。
    pub async fn stop_all(&self) {
        let mut running = self.running.write().await;
        for (_, rf) in running.drain() {
            rf.handle.abort();
        }
    }
}
