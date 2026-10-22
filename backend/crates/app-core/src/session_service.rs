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
    _secret_repo: Arc<SecretRepo>,
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
            _secret_repo: secret_repo,
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
                "vault is locked: cannot import ssh key",
            ));
        }

        // 验证私钥并提取公钥与指纹
        let privkey = openshell_ssh::russh::keys::decode_secret_key(pem, passphrase.as_deref())
            .map_err(|e| {
                DomainError::validation(format!(
                    "failed to decode private key (check passphrase): {e}"
                ))
            })?;

        let pubkey = privkey.public_key();
        let fingerprint = pubkey
            .fingerprint(openshell_ssh::russh::keys::HashAlg::Sha256)
            .to_string();
        let public_key_str = pubkey.to_openssh().unwrap_or_default();
        let algorithm = privkey.algorithm().to_string();

        let key_id = SshKeyId::new();
        let secret_id = SecretId::new();
        let secret_record =
            self.vault_manager
                .encrypt_secret(&secret_id, "ssh_key", pem.as_bytes())?;

        let now = now_ms();
        let has_passphrase = passphrase.is_some();
        let ssh_key = SshKey {
            id: key_id,
            name,
            algorithm,
            key_size: None,
            public_key: public_key_str,
            fingerprint_sha256: fingerprint,
            secret_id,
            passphrase_credential_id: None,
            has_passphrase,
            comment,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync: Default::default(),
        };

        let material = SecretMaterial::PrivateKey {
            pem: Zeroizing::new(pem.as_bytes().to_vec()),
            passphrase: passphrase.map(Zeroizing::new),
        };

        self.ssh_key_repo
            .create(ssh_key, secret_record, material)
            .await
    }

    pub async fn delete_ssh_key(&self, id: &SshKeyId) -> DomainResult<()> {
        self.ssh_key_repo.delete(id).await
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
