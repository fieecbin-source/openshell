use crate::known_hosts::HostKeyVerifier;
use openshell_core_domain::DomainError;
use std::sync::{Arc, Mutex};

/// 与 russh 共享的“主机密钥校验失败原因”槽位。
///
/// russh 的 `check_server_key` 只能返回 `bool`，拒绝时框架只会给出通用错误，
/// 用户看不到「指纹变更 / 公钥未收录」这类关键信息。这里把具体原因暂存，
/// 由 `SshConnection::connect` 在握手失败后取回并原样返回给前端。
pub type HostKeyErrorSlot = Arc<Mutex<Option<DomainError>>>;

pub type RemoteRoutes =
    Arc<tokio::sync::Mutex<std::collections::HashMap<(String, u32), (String, u16)>>>;

pub struct OpenShellClientHandler {
    pub remote_routes: RemoteRoutes,
    pub agent_forwarding: bool,
    verifier: Arc<HostKeyVerifier>,
    host_key_error: HostKeyErrorSlot,
}

impl OpenShellClientHandler {
    pub fn new(verifier: Arc<HostKeyVerifier>) -> Self {
        Self {
            verifier,
            remote_routes: Default::default(),
            agent_forwarding: false,
            host_key_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn host_key_error_slot(&self) -> HostKeyErrorSlot {
        Arc::clone(&self.host_key_error)
    }
}

impl russh::client::Handler for OpenShellClientHandler {
    type Error = russh::Error;

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
        let dest = routes
            .get(&(connected_address.to_string(), connected_port))
            .cloned()
            .or_else(|| {
                let mut matching = routes
                    .iter()
                    .filter(|((_, port), _)| *port == connected_port);
                let first = matching.next().map(|(_, dest)| dest.clone());
                if matching.next().is_none() {
                    first
                } else {
                    None
                }
            });
        drop(routes);
        // Unknown routes are rejected by dropping the reply handle.
        if let Some((host, port)) = dest {
            tokio::spawn(async move {
                if let Ok(Ok(mut socket)) = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tokio::net::TcpStream::connect((host.as_str(), port)),
                )
                .await
                {
                    reply.accept().await;
                    let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket)
                        .await;
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
