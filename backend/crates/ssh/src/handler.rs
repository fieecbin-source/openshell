use crate::known_hosts::HostKeyVerifier;
use openshell_core_domain::DomainError;
use std::sync::{Arc, Mutex};

/// 与 russh 共享的“主机密钥校验失败原因”槽位。
///
/// russh 的 `check_server_key` 只能返回 `bool`，拒绝时框架只会给出通用错误，
/// 用户看不到「指纹变更 / 公钥未收录」这类关键信息。这里把具体原因暂存，
/// 由 `SshConnection::connect` 在握手失败后取回并原样返回给前端。
pub type HostKeyErrorSlot = Arc<Mutex<Option<DomainError>>>;

/// 一条远端转发的运行期路由。
///
/// `cancel` 是该路由所有 relay 的取消信号：`stop_remote_forward` 撤销服务端监听的同时
/// 广播取消，已建立的 relay 立即结束（两端 EOF），避免“点了停止但隧道还在转发”。
#[derive(Clone)]
pub struct RemoteRoute {
    pub dest: (String, u16),
    pub cancel: tokio::sync::watch::Sender<bool>,
}

pub type RemoteRoutes =
    Arc<tokio::sync::Mutex<std::collections::HashMap<(String, u32), RemoteRoute>>>;

/// 取消并清空全部远端转发路由（连接关闭/失联时调用）。
///
/// 先广播取消再丢弃路由：仅清表不会停止已建立的 relay。
pub async fn cancel_all_remote_routes(routes: &RemoteRoutes) {
    let mut guard = routes.lock().await;
    for (_, route) in guard.drain() {
        route.cancel.send_replace(true);
    }
}

pub struct OpenShellClientHandler {
    pub remote_routes: RemoteRoutes,
    pub agent_forwarding: bool,
    pub x11_forwarding: Option<Arc<crate::x11::X11Forward>>,
    pub(crate) closed_tx: Option<Arc<tokio::sync::watch::Sender<bool>>>,
    verifier: Arc<HostKeyVerifier>,
    host_key_error: HostKeyErrorSlot,
}

impl OpenShellClientHandler {
    pub fn new(verifier: Arc<HostKeyVerifier>) -> Self {
        Self {
            verifier,
            remote_routes: Default::default(),
            agent_forwarding: false,
            x11_forwarding: None,
            closed_tx: None,
            host_key_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn host_key_error_slot(&self) -> HostKeyErrorSlot {
        Arc::clone(&self.host_key_error)
    }
}

impl russh::client::Handler for OpenShellClientHandler {
    type Error = russh::Error;

    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        cancel_all_remote_routes(&self.remote_routes).await;
        self.x11_forwarding = None;
        if let Some(closed) = &self.closed_tx {
            closed.send_replace(true);
        }
        match reason {
            russh::client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            russh::client::DisconnectReason::Error(error) => Err(error),
        }
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            return Ok(());
        }
        tokio::spawn(async move {
            #[cfg(unix)]
            let socket = match std::env::var_os("SSH_AUTH_SOCK") {
                Some(path) => tokio::net::UnixStream::connect(path).await,
                None => return,
            };
            #[cfg(windows)]
            let socket = tokio::net::windows::named_pipe::ClientOptions::new().open(
                std::env::var_os("SSH_AUTH_SOCK")
                    .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into()),
            );
            #[cfg(any(unix, windows))]
            if let Ok(mut socket) = socket {
                reply.accept().await;
                let _ =
                    tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket).await;
            }
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _address: &str,
        _port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let (Some(x11), Some(closed)) = (self.x11_forwarding.clone(), self.closed_tx.as_ref())
        else {
            return Ok(());
        };
        let mut closed = closed.subscribe();
        if *closed.borrow() {
            return Ok(());
        }
        tokio::spawn(async move {
            reply.accept().await;
            let mut stream = channel.into_stream();
            tokio::select! {
                result=x11.forward(&mut stream) => {if result.is_err() {tracing::warn!("X11 channel failed authentication or local display forwarding");}},
                _=closed.changed() => {},
            }
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let routes = self.remote_routes.lock().await;
        let route = routes
            .get(&(connected_address.to_string(), connected_port))
            .cloned()
            .or_else(|| {
                let mut matching = routes
                    .iter()
                    .filter(|((_, port), _)| *port == connected_port);
                let first = matching.next().map(|(_, route)| route.clone());
                if matching.next().is_none() {
                    first
                } else {
                    None
                }
            });
        drop(routes);
        // Unknown routes are rejected by dropping the reply handle.
        if let Some(route) = route {
            let mut cancel = route.cancel.subscribe();
            let (host, port) = route.dest;
            tokio::spawn(async move {
                if *cancel.borrow() {
                    return;
                }
                if let Ok(Ok(mut socket)) = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tokio::net::TcpStream::connect((host.as_str(), port)),
                )
                .await
                {
                    reply.accept().await;
                    let mut stream = channel.into_stream();
                    // Stop 之后不得继续转发：取消即丢弃两端句柄，双方收到 EOF。
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut stream, &mut socket) => {}
                        _ = cancel.changed() => {
                            tracing::debug!("remote forward relay cancelled by stop");
                        }
                    }
                }
            });
        }
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pubkey = server_public_key.public_key();
        match self.verifier.check_key(&pubkey).await {
            Ok(decision) => Ok(matches!(
                decision,
                openshell_core_domain::HostKeyDecision::Trust
                    | openshell_core_domain::HostKeyDecision::TrustOnce
            )),
            Err(e) => {
                tracing::warn!("Host key verification failed: {}", e.message);
                if let Ok(mut slot) = self.host_key_error.lock() {
                    *slot = Some(e);
                }
                Ok(false)
            }
        }
    }
}
