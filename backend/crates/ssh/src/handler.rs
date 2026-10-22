use crate::known_hosts::HostKeyVerifier;
use std::sync::Arc;

pub struct OpenShellClientHandler {
    verifier: Arc<HostKeyVerifier>,
}

impl OpenShellClientHandler {
    pub fn new(verifier: Arc<HostKeyVerifier>) -> Self {
        Self { verifier }
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
                tracing::warn!("Host key verification failed: {}", e);
                Ok(false)
            }
        }
    }
}
