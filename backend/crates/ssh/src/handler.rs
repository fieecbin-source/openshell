use crate::known_hosts::HostKeyVerifier;
use openshell_core_domain::DomainError;
use std::sync::{Arc, Mutex};

/// 与 russh 共享的“主机密钥校验失败原因”槽位。
///
/// russh 的 `check_server_key` 只能返回 `bool`，拒绝时框架只会给出通用错误，
/// 用户看不到「指纹变更 / 公钥未收录」这类关键信息。这里把具体原因暂存，
/// 由 `SshConnection::connect` 在握手失败后取回并原样返回给前端。
pub type HostKeyErrorSlot = Arc<Mutex<Option<DomainError>>>;

pub struct OpenShellClientHandler {
    verifier: Arc<HostKeyVerifier>,
    host_key_error: HostKeyErrorSlot,
}

impl OpenShellClientHandler {
    pub fn new(verifier: Arc<HostKeyVerifier>) -> Self {
        Self {
            verifier,
            host_key_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn host_key_error_slot(&self) -> HostKeyErrorSlot {
        Arc::clone(&self.host_key_error)
    }
}

impl russh::client::Handler for OpenShellClientHandler {
    type Error = russh::Error;

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
