//! OpenShell SSH 适配层：russh 连接、认证、跳板、保活、通道。

pub mod connection;
pub mod errors;
pub mod handler;
pub mod known_hosts;
pub mod manager;
pub mod stream;

pub use connection::{ConnectOptions, SshConnection};
pub use errors::{map_io_error, map_russh_error};
pub use handler::OpenShellClientHandler;
pub use known_hosts::HostKeyVerifier;
pub use manager::SshConnectionManager;
pub use russh;
pub use stream::SshByteStream;

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::{HostKeyDecision, HostKeyPolicy};

    #[tokio::test]
    async fn test_insecure_host_key_verifier() {
        let verifier = HostKeyVerifier::new(None, HostKeyPolicy::Insecure, "127.0.0.1".into(), 22);
        let pubkey = russh::keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti test@example.com",
        )
        .expect("parse test key");
        let decision = verifier.check_key(&pubkey).await.expect("check key");
        assert_eq!(decision, HostKeyDecision::Trust);
    }

    #[tokio::test]
    async fn test_connection_manager_empty_list() {
        let mgr = SshConnectionManager::new();
        let list = mgr.list().await;
        assert!(list.is_empty());
    }
}
