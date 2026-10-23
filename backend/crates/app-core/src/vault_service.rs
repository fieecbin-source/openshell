//! 保险库用例服务：解锁状态、密码生命周期与 SecretResolver 凭据解析实现。

use crate::event_bus::EventBus;
use async_trait::async_trait;
use openshell_core_domain::{
    now_ms, AppEvent, CredentialId, CredentialRepository, DomainError, DomainResult, ErrorCode,
    PromptPolicy, SecretMaterial, SecretResolver, SshKeyId, SshKeyRepository, VaultId,
    VaultLifecycle, VaultRecord, VaultState,
};
use openshell_store::{CredentialRepo, SecretRepo, SshKeyRepo, VaultRepo};
use openshell_vault::{KdfParams, KeySlotParts, VaultManager, CRYPTO_SUITE, DEFAULT_KDF};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    pub state: String,
    pub vault_id: Option<String>,
    pub auto_lock_minutes: u32,
    pub keychain_enabled: bool,
    pub last_opened_at: Option<i64>,
}

pub struct VaultService {
    vault_manager: Arc<VaultManager>,
    vault_repo: Arc<VaultRepo>,
    credential_repo: Arc<CredentialRepo>,
    ssh_key_repo: Arc<SshKeyRepo>,
    secret_repo: Arc<SecretRepo>,
    event_bus: Arc<EventBus>,
}

impl VaultService {
    pub fn new(
        vault_manager: Arc<VaultManager>,
        vault_repo: Arc<VaultRepo>,
        credential_repo: Arc<CredentialRepo>,
        ssh_key_repo: Arc<SshKeyRepo>,
        secret_repo: Arc<SecretRepo>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            vault_manager,
            vault_repo,
            credential_repo,
            ssh_key_repo,
            secret_repo,
            event_bus,
        }
    }

    pub fn manager(&self) -> Arc<VaultManager> {
        self.vault_manager.clone()
    }

    pub fn status(&self) -> DomainResult<VaultStatus> {
        let vault_opt = self.vault_repo.load()?;
        match vault_opt {
            None => Ok(VaultStatus {
                state: "uninitialized".to_string(),
                vault_id: None,
                auto_lock_minutes: 15,
                keychain_enabled: false,
                last_opened_at: None,
            }),
            Some(v) => {
                let state_str = match self.vault_manager.state() {
                    VaultState::Unlocked => "unlocked",
                    _ => "locked",
                };
                Ok(VaultStatus {
                    state: state_str.to_string(),
                    vault_id: Some(v.id.to_string()),
                    auto_lock_minutes: 15,
                    keychain_enabled: v.keychain_ref.is_some(),
                    last_opened_at: v.last_opened_at,
                })
            }
        }
    }

    pub fn init(
        &self,
        master_password: &str,
        remember_in_keychain: bool,
        kdf_params: Option<KdfParams>,
    ) -> DomainResult<VaultStatus> {
        let existing = self.vault_repo.load()?;
        if existing.is_some() {
            return Err(DomainError::validation("vault is already initialized"));
        }

        let kdf = kdf_params.unwrap_or(DEFAULT_KDF);
        let (parts, _vault_key) = self.vault_manager.init(master_password, kdf)?;

        let now = now_ms();
        let vault_id = VaultId::new();
        let keychain_ref = if remember_in_keychain {
            Some(format!("vault:{}", vault_id))
        } else {
            None
        };

        let record = VaultRecord {
            id: vault_id.clone(),
            name: "default".to_string(),
            schema_version: openshell_store::SCHEMA_VERSION as i64,
            crypto_suite: CRYPTO_SUITE.to_string(),
            kdf_alg: "argon2id".to_string(),
            kdf_mem_kib: parts.kdf.mem_kib as i64,
            kdf_time: parts.kdf.time as i64,
            kdf_parallelism: parts.kdf.parallelism as i64,
            kdf_salt: parts.salt,
            wrapped_vault_key: parts.wrapped_vault_key,
            key_check: parts.key_check,
            keychain_ref,
            created_at: now,
            updated_at: now,
            last_opened_at: Some(now),
            sync_enabled: false,
            server_url: None,
            account_id: None,
            quota_bytes: None,
        };

        self.vault_repo.save(&record)?;
        self.event_bus.emit(AppEvent::VaultState {
            state: VaultLifecycle::Unlocked,
            reason: "init".to_string(),
        });

        self.status()
    }

    pub fn unlock(
        &self,
        master_password: Option<&str>,
        _use_keychain: bool,
    ) -> DomainResult<VaultStatus> {
        let vault = self.vault_repo.load()?.ok_or_else(|| {
            DomainError::new(ErrorCode::VaultUninitialized, "vault not initialized")
        })?;

        let password = master_password
            .ok_or_else(|| DomainError::validation("master_password is required"))?;

        let parts = KeySlotParts {
            salt: vault.kdf_salt.clone(),
            kdf: KdfParams {
                mem_kib: vault.kdf_mem_kib as u32,
                time: vault.kdf_time as u32,
                parallelism: vault.kdf_parallelism as u32,
            },
            wrapped_vault_key: vault.wrapped_vault_key.clone(),
            key_check: vault.key_check.clone(),
        };

        self.vault_manager.unlock(&parts, password)?;
        let now = now_ms();
        let _ = self.vault_repo.set_last_opened(&vault.id, now);

        self.event_bus.emit(AppEvent::VaultState {
            state: VaultLifecycle::Unlocked,
            reason: "manual".to_string(),
        });

        self.status()
    }

    pub fn lock(&self) -> DomainResult<VaultStatus> {
        self.vault_manager.lock();
        self.event_bus.emit(AppEvent::VaultState {
            state: VaultLifecycle::Locked,
            reason: "manual".to_string(),
        });
        self.status()
    }

    pub fn change_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> DomainResult<VaultStatus> {
        let mut vault = self.vault_repo.load()?.ok_or_else(|| {
            DomainError::new(ErrorCode::VaultUninitialized, "vault not initialized")
        })?;

        let new_parts = self
            .vault_manager
            .change_password(old_password, new_password)?;

        vault.kdf_salt = new_parts.salt;
        vault.kdf_mem_kib = new_parts.kdf.mem_kib as i64;
        vault.kdf_time = new_parts.kdf.time as i64;
        vault.kdf_parallelism = new_parts.kdf.parallelism as i64;
        vault.wrapped_vault_key = new_parts.wrapped_vault_key;
        vault.key_check = new_parts.key_check;
        vault.updated_at = now_ms();

        self.vault_repo.save(&vault)?;
        self.status()
    }
}

#[async_trait]
impl SecretResolver for VaultService {
    async fn resolve_credential(
        &self,
        id: &CredentialId,
        _policy: PromptPolicy,
    ) -> DomainResult<SecretMaterial> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "主保险库处于锁定状态，无法解密服务器登录凭据，请先输入主密码解锁保险库",
            ));
        }

        let cred = self.credential_repo.get(id).await?;
        let secret = match self.secret_repo.get(&cred.secret_id)? {
            Some(secret) => secret,
            None => self.secret_repo.restore_if_deleted(&cred.secret_id)?.ok_or_else(|| {
                DomainError::not_found("该凭据的加密内容缺失，请重新保存该登录凭据后再连接。")
            })?,
        };

        let plaintext = self.vault_manager.decrypt_secret(&secret)?;
        match cred.kind {
            openshell_core_domain::CredentialKind::Password
            | openshell_core_domain::CredentialKind::Passphrase => {
                let s = String::from_utf8(plaintext).map_err(|_| {
                    DomainError::new(ErrorCode::VaultDecryptFailed, "invalid utf-8 in secret")
                })?;
                Ok(SecretMaterial::Password(Zeroizing::new(s)))
            }
            openshell_core_domain::CredentialKind::KeyboardInteractive => {
                let json_val = serde_json::from_slice(&plaintext).map_err(|_| {
                    DomainError::new(ErrorCode::VaultDecryptFailed, "invalid json in secret")
                })?;
                Ok(SecretMaterial::KeyboardInteractive(json_val))
            }
        }
    }

    async fn resolve_ssh_key(
        &self,
        id: &SshKeyId,
        _policy: PromptPolicy,
    ) -> DomainResult<SecretMaterial> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "主保险库处于锁定状态，无法解密私钥，请先输入主密码解锁保险库",
            ));
        }

        let key = self.ssh_key_repo.get(id).await?;
        let secret = match self.secret_repo.get(&key.secret_id)? {
            Some(secret) => secret,
            None => self.secret_repo.restore_if_deleted(&key.secret_id)?.ok_or_else(|| {
                DomainError::not_found(
                    "该私钥的加密内容缺失，无法用于连接。请在「私钥管理」中重新导入该私钥文件。",
                )
            })?,
        };

        let pem_bytes = self.vault_manager.decrypt_secret(&secret)?;

        let passphrase = if key.has_passphrase {
            if let Some(ref pass_id) = key.passphrase_credential_id {
                let pass_material = self
                    .resolve_credential(pass_id, PromptPolicy::StoredOnly)
                    .await?;
                match pass_material {
                    SecretMaterial::Password(p) => Some(p),
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok(SecretMaterial::PrivateKey {
            pem: Zeroizing::new(pem_bytes),
            passphrase,
        })
    }
}
