use openshell_core_domain::{
    now_ms, DomainError, DomainResult, ErrorCode, HostKeyDecision, HostKeyPolicy, KnownHost,
    KnownHostId, KnownHostRepository, KnownHostStatus, SyncMeta,
};
use std::sync::Arc;

pub struct HostKeyVerifier {
    repo: Option<Arc<dyn KnownHostRepository>>,
    policy: HostKeyPolicy,
    host: String,
    port: u16,
}

impl HostKeyVerifier {
    pub fn new(
        repo: Option<Arc<dyn KnownHostRepository>>,
        policy: HostKeyPolicy,
        host: String,
        port: u16,
    ) -> Self {
        Self {
            repo,
            policy,
            host,
            port,
        }
    }

    pub async fn check_key(
        &self,
        public_key: &russh::keys::PublicKey,
    ) -> DomainResult<HostKeyDecision> {
        if self.policy == HostKeyPolicy::Insecure {
            return Ok(HostKeyDecision::Trust);
        }

        let key_type = public_key.algorithm().as_str().to_string();
        let pubkey_str = public_key.to_openssh().map_err(|e| {
            DomainError::new(
                ErrorCode::SshProtocol,
                format!("failed to encode public key: {e}"),
            )
        })?;
        let fp = public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();

        let repo = match &self.repo {
            Some(r) => r,
            None => {
                // If no repo configured and not strict, accept
                return if self.policy == HostKeyPolicy::AcceptNew {
                    Ok(HostKeyDecision::Trust)
                } else {
                    Err(DomainError::new(
                        ErrorCode::HostkeyUnknown,
                        format!(
                            "unverified host key for {}:{} ({})",
                            self.host, self.port, fp
                        ),
                    ))
                };
            }
        };

        let existing = repo.find(&self.host, self.port, &key_type).await?;

        match existing {
            Some(kh) => {
                if kh.status == KnownHostStatus::Revoked {
                    return Err(DomainError::new(
                        ErrorCode::HostkeyMismatch,
                        format!(
                            "服务器 {}:{} 的主机公钥已被显式标记为撤销 (Revoked)，已阻止连接",
                            self.host, self.port
                        ),
                    ));
                }

                if kh.fingerprint_sha256 == fp {
                    // Update last seen
                    let mut updated = kh.clone();
                    updated.last_seen_at = now_ms();
                    let _ = repo.upsert_trusted(updated).await;
                    Ok(HostKeyDecision::Trust)
                } else {
                    // Fingerprint mismatch! Mark changed and fail with HostkeyMismatch
                    let _ = repo.mark_changed(&kh.id, &fp).await;
                    Err(DomainError::new(
                        ErrorCode::HostkeyMismatch,
                        format!(
                            "警告：目标服务器 {}:{} 的主机公钥指纹已发生变更！\n历史保存指纹: {}\n当前实际指纹: {}\n这可能是服务器重装或存在中间人风险。",
                            self.host, self.port, kh.fingerprint_sha256, fp
                        ),
                    ))
                }
            }
            None => {
                // Unknown host key
                if self.policy == HostKeyPolicy::AcceptNew {
                    let now = now_ms();
                    let new_kh = KnownHost {
                        id: KnownHostId::new(),
                        host: self.host.clone(),
                        port: self.port,
                        key_type,
                        public_key: pubkey_str,
                        fingerprint_sha256: fp,
                        status: KnownHostStatus::Trusted,
                        previous_fingerprint: None,
                        first_seen_at: now,
                        last_seen_at: now,
                        changed_at: None,
                        source: "auto".to_string(),
                        created_at: now,
                        updated_at: now,
                        deleted_at: None,
                        sync: SyncMeta::default(),
                    };
                    repo.upsert_trusted(new_kh).await?;
                    Ok(HostKeyDecision::Trust)
                } else {
                    Err(DomainError::new(
                        ErrorCode::HostkeyUnknown,
                        format!(
                            "检测到未收录的目标主机公钥 ({}:{}，指纹: {})。如需首次自动信任，请将主机密钥策略设为「首次自动接受 (Accept New)」。",
                            self.host, self.port, fp
                        ),
                    ))
                }
            }
        }
    }
}
