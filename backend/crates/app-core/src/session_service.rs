//! 会话与凭据服务：会话、分组、凭据、SSH 密钥与设置的用例编排。

use crate::event_bus::EventBus;
use openshell_core_domain::{
    now_ms, Credential, CredentialId, CredentialKind, CredentialRepository, DomainError,
    DomainResult, ErrorCode, Group, GroupId, GroupKind, GroupRepository, KnownHost, KnownHostId,
    KnownHostRepository, SavePolicy, SecretId, SecretMaterial, Session, SessionId, SessionInput,
    SessionPatch, SessionQuery, SessionRepository, SshKey, SshKeyId, SshKeyRepository,
};
use openshell_store::{
    CredentialRepo, GroupRepo, KnownHostRepo, SecretRepo, SessionRepo, SettingRecord, SettingsRepo,
    SshKeyRepo,
};
use openshell_vault::VaultManager;
use std::sync::Arc;
use zeroize::Zeroizing;

pub struct SessionService {
    session_repo: Arc<SessionRepo>,
    group_repo: Arc<GroupRepo>,
    credential_repo: Arc<CredentialRepo>,
    ssh_key_repo: Arc<SshKeyRepo>,
    known_host_repo: Arc<KnownHostRepo>,
    settings_repo: Arc<SettingsRepo>,
    secret_repo: Arc<SecretRepo>,
    vault_manager: Arc<VaultManager>,
    _event_bus: Arc<EventBus>,
}

impl SessionService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_repo: Arc<SessionRepo>,
        group_repo: Arc<GroupRepo>,
        credential_repo: Arc<CredentialRepo>,
        ssh_key_repo: Arc<SshKeyRepo>,
        known_host_repo: Arc<KnownHostRepo>,
        settings_repo: Arc<SettingsRepo>,
        secret_repo: Arc<SecretRepo>,
        vault_manager: Arc<VaultManager>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            session_repo,
            group_repo,
            credential_repo,
            ssh_key_repo,
            known_host_repo,
            settings_repo,
            secret_repo,
            vault_manager,
            _event_bus: event_bus,
        }
    }

    // ==========================================
    // Sessions
    // ==========================================

    pub async fn list_sessions(&self, q: &SessionQuery) -> DomainResult<Vec<Session>> {
        self.session_repo.list(q).await
    }

    pub async fn get_session(&self, id: &SessionId) -> DomainResult<Session> {
        self.session_repo.get(id).await
    }

    pub async fn create_session(&self, input: SessionInput) -> DomainResult<Session> {
        self.session_repo.create(input).await
    }

    pub async fn update_session(
        &self,
        id: &SessionId,
        patch: SessionPatch,
        expected_local_rev: Option<i64>,
    ) -> DomainResult<Session> {
        self.session_repo
            .update(id, patch, expected_local_rev)
            .await
    }

    pub async fn delete_session(&self, id: &SessionId) -> DomainResult<()> {
        self.session_repo.delete(id).await
    }

    pub async fn restore_session(&self, id: &SessionId) -> DomainResult<Session> {
        self.session_repo.restore(id).await
    }

    pub async fn duplicate_session(&self, id: &SessionId) -> DomainResult<Session> {
        let original = self.session_repo.get(id).await?;
        let input = SessionInput {
            group_id: original.group_id,
            name: Some(format!("{} (Copy)", original.name)),
            protocol: Some(original.protocol),
            host: original.host,
            port: original.port,
            username: original.username,
            auth_method: Some(original.auth_method),
            credential_id: original.credential_id,
            ssh_key_id: original.ssh_key_id,
            host_key_policy: Some(original.host_key_policy),
            proxy_jump_json: original.proxy_jump_json,
            terminal_profile_id: original.terminal_profile_id,
            encoding: Some(original.encoding),
            startup_command: original.startup_command,
            working_dir: original.working_dir,
            keepalive_sec: Some(original.keepalive_sec),
            keepalive_max_miss: Some(original.keepalive_max_miss),
            auto_reconnect: Some(original.auto_reconnect),
            reconnect_max: Some(original.reconnect_max),
            compression: Some(original.compression),
            agent_forwarding: Some(original.agent_forwarding),
            tags_json: original.tags_json,
            favorite: Some(original.favorite),
            color: original.color,
            icon_key: original.icon_key,
            notes: original.notes,
            protocol_options_json: original.protocol_options_json,
            sort_order: Some(original.sort_order + 1),
        };
        self.session_repo.create(input).await
    }

    pub async fn touch_used(&self, id: &SessionId, result: &str) -> DomainResult<()> {
        self.session_repo.touch_used(id, result).await
    }

    // ==========================================
    // Groups
    // ==========================================

    pub async fn list_groups(&self, kind: GroupKind) -> DomainResult<Vec<Group>> {
        self.group_repo.list(kind).await
    }

    pub async fn create_group(
        &self,
        parent_id: Option<GroupId>,
        name: String,
        kind: GroupKind,
    ) -> DomainResult<Group> {
        self.group_repo.create(parent_id, name, kind).await
    }

    pub async fn rename_group(&self, id: &GroupId, name: String) -> DomainResult<Group> {
        self.group_repo.rename(id, name).await
    }

    pub async fn delete_group(&self, id: &GroupId) -> DomainResult<()> {
        self.group_repo.delete(id).await
    }

    pub async fn move_group(
        &self,
        id: &GroupId,
        parent_id: Option<GroupId>,
        sort_order: i64,
    ) -> DomainResult<Group> {
        self.group_repo.move_to(id, parent_id, sort_order).await
    }

    // ==========================================
    // Credentials
    // ==========================================

    pub async fn list_credentials(&self) -> DomainResult<Vec<Credential>> {
        self.credential_repo.list().await
    }

    pub async fn get_credential(&self, id: &CredentialId) -> DomainResult<Credential> {
        self.credential_repo.get(id).await
    }

    pub async fn create_credential(
        &self,
        name: String,
        kind: CredentialKind,
        username: Option<String>,
        secret_plaintext: &str,
        hint: Option<String>,
        save_policy: Option<SavePolicy>,
    ) -> DomainResult<Credential> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "vault is locked: cannot create credential",
            ));
        }

        let cred_id = CredentialId::new();
        let secret_id = SecretId::new();
        let secret_record = self.vault_manager.encrypt_secret(
            &secret_id,
            "credential",
            secret_plaintext.as_bytes(),
        )?;

        let now = now_ms();
        let cred = Credential {
            id: cred_id,
            name,
            kind,
            username,
            secret_id,
            hint,
            save_policy: save_policy.unwrap_or(SavePolicy::Always),
            expires_at: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync: Default::default(),
        };

        let material = match kind {
            CredentialKind::Password | CredentialKind::Passphrase => {
                SecretMaterial::Password(Zeroizing::new(secret_plaintext.to_string()))
            }
            CredentialKind::KeyboardInteractive => {
                let json_val = serde_json::from_str(secret_plaintext)
                    .unwrap_or_else(|_| serde_json::json!(secret_plaintext));
                SecretMaterial::KeyboardInteractive(json_val)
            }
        };

        self.credential_repo
            .create(cred, secret_record, material)
            .await
    }

    pub async fn delete_credential(&self, id: &CredentialId) -> DomainResult<()> {
        self.credential_repo.delete(id).await
    }

    // ==========================================
    // SSH Keys
    // ==========================================

    pub async fn list_ssh_keys(&self) -> DomainResult<Vec<SshKey>> {
        self.ssh_key_repo.list().await
    }

    pub async fn get_ssh_key(&self, id: &SshKeyId) -> DomainResult<SshKey> {
        self.ssh_key_repo.get(id).await
    }

    pub async fn import_ssh_key(
        &self,
        name: String,
        pem: &str,
        passphrase: Option<String>,
        comment: Option<String>,
    ) -> DomainResult<SshKey> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "主保险库已锁定，请先解锁后再导入 SSH 密钥",
            ));
        }

        let trimmed = pem.trim();
        let mut clean_pem = trimmed.replace("\r\n", "\n").replace('\r', "\n");

        // 兼容支持 Base64 编码的 PEM（例如直接复制 FinalShell 等导出的 key_data）
        if !clean_pem.starts_with("-----BEGIN") {
            use openshell_ssh::base64::Engine;
            if let Ok(decoded) =
                openshell_ssh::base64::engine::general_purpose::STANDARD.decode(trimmed)
            {
                if let Ok(utf8) = String::from_utf8(decoded) {
                    if utf8.contains("-----BEGIN") {
                        clean_pem = utf8.trim().replace("\r\n", "\n").replace('\r', "\n");
                    }
                }
            }
        }

        // 友好拦截用户误贴公钥的情况
        if clean_pem.starts_with("ssh-") || clean_pem.starts_with("ecdsa-") {
            return Err(DomainError::validation(
                "检测到输入为 SSH 公钥 (Public Key)。客户端连接服务器需要导入私钥 (Private Key)。请将该公钥部署至目标服务器的 ~/.ssh/authorized_keys 中，并在客户端导入私钥。"
            ));
        }

        // 验证私钥并提取公钥与指纹
        let privkey =
            openshell_ssh::russh::keys::decode_secret_key(&clean_pem, passphrase.as_deref())
                .map_err(|e| {
                    let err_str = e.to_string().to_lowercase();
                    let has_passphrase = passphrase.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
                    let unreadable = err_str.contains("could not read key")
                        || err_str.contains("unsupported key type");
                    let encrypted = err_str.contains("encrypted")
                        || clean_pem.contains("ENCRYPTED")
                        || clean_pem.contains("bcrypt")
                        || clean_pem.contains("aes256");
                    if !unreadable && has_passphrase {
                        DomainError::validation(
                            "私钥口令不正确，无法解密该私钥，请重新输入。",
                        )
                    } else if !unreadable && encrypted {
                        DomainError::validation(
                            "该私钥已加密，请在下方填写私钥口令 (Passphrase) 后再导入。",
                        )
                    } else {
                        DomainError::validation(
                            "无法识别该私钥文件。请选择 OpenSSH (-----BEGIN OPENSSH PRIVATE KEY-----) 或 PEM 格式的私钥文件，不要选择 .pub 公钥文件。",
                        )
                    }
                })?;

        let pubkey = privkey.public_key();
        let fingerprint = pubkey
            .fingerprint(openshell_ssh::russh::keys::HashAlg::Sha256)
            .to_string();

        // 检查是否已有相同指纹的私钥（已存在则直接返回，但必须把本次填写的口令补绑上，
        // 否则旧记录会一直缺少口令凭据，导致连接时无法解密私钥）
        if let Ok(Some(existing_key)) = self.ssh_key_repo.find_by_fingerprint(&fingerprint).await {
            let mut key = existing_key;
            if key.deleted_at.is_some() {
                let _ = self.ssh_key_repo.restore(&key.id, &name).await;
                key.deleted_at = None;
                key.name = name.clone();
            }
            // 以本次导入的私钥内容重新写入密文：历史记录可能存在密文缺失或被标记删除的情况，
            // 仅恢复元数据无法建立连接，必须同时补齐加密内容。
            let secret_record = self.vault_manager.encrypt_secret(
                &key.secret_id,
                "ssh_key",
                clean_pem.as_bytes(),
            )?;
            self.secret_repo.save_or_restore(secret_record)?;
            if let Some(pass) = passphrase.as_deref().filter(|p| !p.is_empty()) {
                let cred = self
                    .create_credential(
                        format!("{} (私钥口令)", key.name),
                        CredentialKind::Passphrase,
                        None,
                        pass,
                        None,
                        Some(SavePolicy::Always),
                    )
                    .await?;
                key = self
                    .ssh_key_repo
                    .update_passphrase(&key.id, Some(&cred.id), true)
                    .await?;
            } else if key.has_passphrase {
                // 本次导入的私钥未加密（无需口令即可解析），清理旧记录上残留的“已加密”标记，
                // 否则连接时会一直等待一个并不存在的口令。
                key = self
                    .ssh_key_repo
                    .update_passphrase(&key.id, None, false)
                    .await?;
            }
            return Ok(key);
        }

        let public_key_str = pubkey.to_openssh().unwrap_or_default();
        let algorithm = privkey.algorithm().to_string();

        // 持久化私钥口令：否则带 Passphrase 的私钥在连接时无法解密。
        let passphrase_credential = match passphrase.as_deref() {
            Some(pass) if !pass.is_empty() => Some(
                self.create_credential(
                    format!("{name} (私钥口令)"),
                    CredentialKind::Passphrase,
                    None,
                    pass,
                    None,
                    Some(SavePolicy::Always),
                )
                .await?,
            ),
            _ => None,
        };

        let key_id = SshKeyId::new();
        let secret_id = SecretId::new();
        let secret_record =
            self.vault_manager
                .encrypt_secret(&secret_id, "ssh_key", clean_pem.as_bytes())?;

        let now = now_ms();
        let ssh_key = SshKey {
            id: key_id,
            name,
            algorithm,
            key_size: None,
            public_key: public_key_str,
            fingerprint_sha256: fingerprint,
            secret_id,
            passphrase_credential_id: passphrase_credential.as_ref().map(|c| c.id.clone()),
            has_passphrase: passphrase_credential.is_some(),
            comment,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync: Default::default(),
        };

        let material = SecretMaterial::PrivateKey {
            pem: Zeroizing::new(clean_pem.as_bytes().to_vec()),
            passphrase: passphrase.map(Zeroizing::new),
        };

        self.ssh_key_repo
            .create(ssh_key, secret_record, material)
            .await
    }

    pub async fn delete_ssh_key(&self, id: &SshKeyId) -> DomainResult<()> {
        self.ssh_key_repo.delete(id).await
    }

    /// 为已导入的加密私钥补录/重置口令。
    ///
    /// 校验口令能否真正解开私钥，成功后才写入保险库并绑定到该私钥。
    pub async fn set_ssh_key_passphrase(
        &self,
        id: &SshKeyId,
        passphrase: &str,
    ) -> DomainResult<SshKey> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "主保险库已锁定，请先解锁后再设置私钥口令",
            ));
        }
        if passphrase.is_empty() {
            return Err(DomainError::validation("请输入私钥口令 (Passphrase)"));
        }

        let key = self.ssh_key_repo.get(id).await?;
        let secret = match self.secret_repo.get(&key.secret_id)? {
            Some(secret) => secret,
            None => self.secret_repo.restore_if_deleted(&key.secret_id)?.ok_or_else(|| {
                DomainError::not_found(
                    "该私钥的加密内容缺失，无法设置口令。请在「私钥管理」中重新导入该私钥文件。",
                )
            })?,
        };
        let pem_bytes = self.vault_manager.decrypt_secret(&secret)?;
        let pem = String::from_utf8(pem_bytes)
            .map_err(|_| DomainError::new(ErrorCode::Validation, "私钥内容不是有效的文本格式"))?;

        openshell_ssh::russh::keys::decode_secret_key(&pem, Some(passphrase)).map_err(|_| {
            DomainError::validation("私钥口令不正确，无法解密该私钥，请重新输入。")
        })?;

        let cred = self
            .create_credential(
                format!("{} (私钥口令)", key.name),
                CredentialKind::Passphrase,
                None,
                passphrase,
                None,
                Some(SavePolicy::Always),
            )
            .await?;

        self.ssh_key_repo
            .update_passphrase(id, Some(&cred.id), true)
            .await
    }

    // ==========================================
    // Known Hosts
    // ==========================================

    pub async fn list_known_hosts(&self) -> DomainResult<Vec<KnownHost>> {
        self.known_host_repo.list().await
    }

    pub async fn delete_known_host(&self, id: &KnownHostId) -> DomainResult<()> {
        self.known_host_repo.delete(id).await
    }

    // ==========================================
    // Settings
    // ==========================================

    pub fn get_setting(
        &self,
        scope: &str,
        scope_id: Option<&str>,
        key: &str,
    ) -> DomainResult<Option<SettingRecord>> {
        self.settings_repo.get(scope, scope_id, key)
    }

    pub fn set_setting(
        &self,
        scope: &str,
        scope_id: Option<&str>,
        key: &str,
        value: serde_json::Value,
        syncable: bool,
    ) -> DomainResult<SettingRecord> {
        self.settings_repo
            .set(scope, scope_id, key, value, syncable)
    }

    pub fn list_settings(
        &self,
        scope: Option<&str>,
        _scope_id: Option<&str>,
    ) -> DomainResult<Vec<SettingRecord>> {
        self.settings_repo.list(scope.unwrap_or("app"))
    }
}
