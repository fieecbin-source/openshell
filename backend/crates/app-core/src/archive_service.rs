//! Archive previews retain secrets only in backend memory until one atomic commit.
use crate::sync_codec::{self, LocalSyncRecord, SyncRecordType, SYNC_SCHEMA_VERSION};
use openshell_core_domain::*;
use openshell_importer::{
    CandidateAction, ConflictStrategy, ImportCandidate, ImportPreviewEngine, ImportPreviewReport,
    OpenShellExportBundle,
};
use openshell_store::{
    CredentialRepo, GroupRepo, SecretRepo, SessionRepo, SnippetRepo, SshKeyRepo, Store,
};
use openshell_vault::{
    kdf::KdfParams,
    package::{open_package, seal_package},
    VaultManager,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
struct ArchivedSecret {
    id: SecretId,
    record_type: String,
    data: Vec<u8>,
}
impl Drop for ArchivedSecret {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct Archive {
    #[serde(default)]
    recovery_version: Option<u32>,
    #[serde(flatten)]
    bundle: OpenShellExportBundle,
    #[serde(default)]
    credentials: Vec<Credential>,
    #[serde(default)]
    ssh_keys: Vec<SshKey>,
    #[serde(default)]
    secrets: Vec<ArchivedSecret>,
}

struct Preview {
    archive: Archive,
    candidates: Vec<ImportCandidate>,
    ids: HashMap<String, String>,
    expected_sessions: HashMap<String, (i64, i64, i64)>,
    expected_entities: sync_codec::ArchiveExpected,
    reused: HashSet<String>,
}

pub struct ArchiveService {
    store: Store,
    vault: Arc<VaultManager>,
    previews: Mutex<HashMap<String, Preview>>,
}

fn invalid() -> DomainError {
    DomainError::validation("归档格式或依赖无效")
}
fn encoded<T: Serialize>(value: &T) -> DomainResult<Value> {
    serde_json::to_value(value).map_err(|_| invalid())
}
fn record<T: Serialize>(kind: SyncRecordType, entity: &T) -> DomainResult<LocalSyncRecord> {
    let mut value = encoded(entity)?;
    let id = value["id"].as_str().ok_or_else(invalid)?.to_owned();
    for (from, to) in [
        ("tags_json", "tags"),
        ("variables_json", "variables"),
        ("macro_steps_json", "macro_steps"),
        ("protocol_options_json", "protocol_options"),
        ("proxy_jump_json", "proxy_jump"),
        ("rule_type", "forward_type"),
    ] {
        if let Some(field) = value.as_object_mut().ok_or_else(invalid)?.remove(from) {
            value[to] = field;
        }
    }
    if kind == SyncRecordType::Snippet {
        if value["variables"].is_null() {
            value["variables"] = json!([]);
        }
        if value["tags"].is_null() {
            value["tags"] = json!([]);
        }
    }
    if kind == SyncRecordType::Session && value["tags"].is_null() {
        value["tags"] = json!([]);
    }
    Ok(LocalSyncRecord {
        record_id: id,
        record_type: kind,
        schema_version: SYNC_SCHEMA_VERSION,
        revision: 0,
        updated_at: now_ms(),
        device_id: None,
        deleted: false,
        payload: value,
    })
}

impl Archive {
    fn records(&self) -> DomainResult<Vec<LocalSyncRecord>> {
        let mut records = Vec::new();
        for entity in &self.bundle.groups {
            records.push(record(SyncRecordType::Group, entity)?);
        }
        for entity in &self.credentials {
            records.push(record(SyncRecordType::Credential, entity)?);
        }
        for entity in &self.ssh_keys {
            records.push(record(SyncRecordType::SshKey, entity)?);
        }
        for entity in &self.bundle.sessions {
            records.push(record(SyncRecordType::Session, entity)?);
        }
        for entity in &self.bundle.snippets {
            records.push(record(SyncRecordType::Snippet, entity)?);
        }
        for entity in &self.bundle.port_forwards {
            records.push(record(SyncRecordType::PortForward, entity)?);
        }
        Ok(records)
    }

    fn validate_and_sanitize(&mut self) -> DomainResult<Vec<String>> {
        if self.bundle.schema_version != 1
            || self.recovery_version.is_some_and(|version| version != 1)
        {
            return Err(invalid());
        }
        let mut ids = HashMap::new();
        for record in self.records()? {
            if ids
                .insert(record.record_id, record.record_type.as_str())
                .is_some()
            {
                return Err(invalid());
            }
        }
        for secret in &self.secrets {
            if ids.insert(secret.id.to_string(), "secret").is_some() {
                return Err(invalid());
            }
        }
        for proxy in &self.bundle.proxies {
            if proxy.id.trim().is_empty()
                || proxy.host.trim().is_empty()
                || proxy.port == 0
                || proxy.password.is_some()
                || ids.insert(proxy.id.clone(), "proxy").is_some()
            {
                return Err(invalid());
            }
        }
        let mut warnings = Vec::new();
        let require = |id: Option<&str>, kind: &str| -> DomainResult<()> {
            if id.is_some_and(|id| ids.get(id).copied() != Some(kind)) {
                Err(invalid())
            } else {
                Ok(())
            }
        };
        for group in &self.bundle.groups {
            require(group.parent_id.as_ref().map(|id| id.as_str()), "group")?;
        }
        // A foreign key alone does not reject a parent cycle.
        for group in &self.bundle.groups {
            let mut next = group.parent_id.as_ref();
            let mut visited = HashSet::from([group.id.as_str()]);
            while let Some(id) = next {
                if !visited.insert(id.as_str()) {
                    return Err(invalid());
                }
                next = self
                    .bundle
                    .groups
                    .iter()
                    .find(|group| &group.id == id)
                    .and_then(|group| group.parent_id.as_ref());
            }
        }
        for credential in &self.credentials {
            require(Some(credential.secret_id.as_str()), "secret")?;
        }
        for key in &self.ssh_keys {
            require(Some(key.secret_id.as_str()), "secret")?;
            require(
                key.passphrase_credential_id.as_ref().map(|id| id.as_str()),
                "credential",
            )?;
        }
        for session in &mut self.bundle.sessions {
            if session.name.trim().is_empty()
                || session.name.chars().count() > 128
                || session
                    .host
                    .as_ref()
                    .is_some_and(|host| host.contains(['\r', '\n', '\0']))
                || (session.protocol.requires_host()
                    && session
                        .host
                        .as_deref()
                        .is_none_or(|host| host.trim().is_empty()))
                || session.port == Some(0)
            {
                return Err(invalid());
            }
            require(session.group_id.as_ref().map(|id| id.as_str()), "group")?;
            if session
                .credential_id
                .as_ref()
                .is_some_and(|id| ids.get(id.as_str()).copied() != Some("credential"))
            {
                if self.recovery_version.is_some() {
                    return Err(invalid());
                }
                session.credential_id = None;
                warnings.push("归档不含密码凭据，导入后需要补录".into());
            }
            if session
                .ssh_key_id
                .as_ref()
                .is_some_and(|id| ids.get(id.as_str()).copied() != Some("ssh_key"))
            {
                if self.recovery_version.is_some() {
                    return Err(invalid());
                }
                session.ssh_key_id = None;
                warnings.push("归档不含 SSH 私钥，导入后需要补录".into());
            }
            if session
                .proxy_id
                .as_ref()
                .is_some_and(|id| ids.get(id).copied() != Some("proxy"))
            {
                return Err(DomainError::validation(
                    "归档缺少代理服务器，不能改为直连；请补齐代理后重试",
                ));
            }
            if let Some(jump) = session
                .proxy_jump_json
                .as_ref()
                .filter(|value| !value.is_null())
            {
                require(
                    Some(jump["session_id"].as_str().ok_or_else(invalid)?),
                    "session",
                )?;
            }
            if session.terminal_profile_id.is_some() {
                if self.recovery_version.is_some() {
                    return Err(DomainError::validation(
                        "归档不支持终端配置档依赖，请先移除该引用",
                    ));
                }
                session.terminal_profile_id = None;
                warnings.push("旧归档不含终端配置档，需要重新选择".into());
            }
        }
        for snippet in &self.bundle.snippets {
            require(snippet.group_id.as_ref().map(|id| id.as_str()), "group")?;
        }
        for rule in &mut self.bundle.port_forwards {
            require(rule.session_id.as_ref().map(|id| id.as_str()), "session")?;
            if rule
                .socks_password_ref
                .as_ref()
                .is_some_and(|id| ids.get(id).copied() != Some("secret"))
            {
                if self.recovery_version.is_some() {
                    return Err(invalid());
                }
                rule.socks_password_ref = None;
                rule.has_socks_password = false;
                rule.auto_start = false;
                warnings.push("归档不含 SOCKS 密码，转发需要补录密码后启动".into());
            }
            if let Some(id) = &rule.socks_password_ref {
                if !self.secrets.iter().any(|secret| {
                    secret.id.as_str() == id && secret.record_type == "socks_password"
                }) {
                    return Err(invalid());
                }
            }
        }
        for proxy in &mut self.bundle.proxies {
            if proxy
                .password_ref
                .as_ref()
                .is_some_and(|id| ids.get(id).copied() != Some("secret"))
            {
                if self.recovery_version.is_some() {
                    return Err(invalid());
                }
                proxy.password_ref = None;
                proxy.has_password = false;
                warnings.push("归档不含代理密码，需要补录".into());
            }
            if let Some(id) = &proxy.password_ref {
                if !self.secrets.iter().any(|secret| {
                    secret.id.as_str() == id && secret.record_type == "proxy_password"
                }) {
                    return Err(invalid());
                }
            }
        }
        warnings.sort();
        warnings.dedup();
        Ok(warnings)
    }
}

impl ArchiveService {
    pub fn new(store: Store, vault: Arc<VaultManager>) -> Self {
        Self {
            store,
            vault,
            previews: Mutex::new(HashMap::new()),
        }
    }

    async fn export(&self, with_secrets: bool) -> DomainResult<Archive> {
        let network =
            crate::network_secrets::NetworkSecrets::new(self.store.clone(), self.vault.clone());
        let proxies = network.proxies()?;
        // 元数据导出走脱敏列举：坏行不携带未知 ref 原值，也不阻断整份导出。
        // 含秘密导出仍走严格完整性校验，缺失依赖必须拒绝，不能接受不完整状态。
        let forwards = if with_secrets {
            network.forwards_strict(None).await?
        } else {
            network
                .forwards(None)
                .await?
                .into_iter()
                .map(|view| view.rule)
                .collect()
        };
        let mut groups = GroupRepo::new(self.store.clone())
            .list(GroupKind::Session)
            .await?;
        groups.extend(
            GroupRepo::new(self.store.clone())
                .list(GroupKind::Snippet)
                .await?,
        );
        let mut bundle = OpenShellExportBundle::new(
            SessionRepo::new(self.store.clone())
                .list(&SessionQuery::default())
                .await?,
            groups,
            SnippetRepo::new(self.store.clone()).list(None).await?,
            forwards,
        );
        bundle.app_version = crate::APP_VERSION.into();
        bundle.proxies = proxies;
        let mut archive = Archive {
            recovery_version: with_secrets.then_some(1),
            bundle,
            credentials: Vec::new(),
            ssh_keys: Vec::new(),
            secrets: Vec::new(),
        };
        if with_secrets {
            if !self.vault.is_unlocked() {
                return Err(DomainError::new(ErrorCode::VaultLocked, "请先解锁保险库"));
            }
            archive.credentials = CredentialRepo::new(self.store.clone()).list().await?;
            archive.ssh_keys = SshKeyRepo::new(self.store.clone()).list().await?;
            let mut ids: HashSet<SecretId> = archive
                .credentials
                .iter()
                .map(|c| c.secret_id.clone())
                .collect();
            ids.extend(archive.ssh_keys.iter().map(|key| key.secret_id.clone()));
            for reference in archive
                .bundle
                .proxies
                .iter()
                .filter_map(|p| p.password_ref.as_ref())
                .chain(
                    archive
                        .bundle
                        .port_forwards
                        .iter()
                        .filter_map(|p| p.socks_password_ref.as_ref()),
                )
            {
                ids.insert(SecretId::from_string(reference)?);
            }
            for id in ids {
                let secret = SecretRepo::new(self.store.clone())
                    .get(&id)?
                    .ok_or_else(invalid)?;
                archive.secrets.push(ArchivedSecret {
                    id,
                    record_type: secret.record_type.clone(),
                    data: self.vault.decrypt_secret(&secret)?,
                });
            }
        }
        Ok(archive)
    }

    pub async fn export_json(&self) -> DomainResult<String> {
        self.export(false)
            .await?
            .bundle
            .to_json_string()
            .map_err(|_| invalid())
    }
    pub async fn export_encrypted(&self, password: &str) -> DomainResult<Vec<u8>> {
        let mut archive = self.export(true).await?;
        archive.validate_and_sanitize()?;
        let bytes = Zeroizing::new(serde_json::to_vec(&archive).map_err(|_| invalid())?);
        seal_package(password, &bytes, KdfParams::default())
    }
    pub async fn preview_json(
        &self,
        json: &str,
        strategy: ConflictStrategy,
    ) -> DomainResult<ImportPreviewReport> {
        let bundle = OpenShellExportBundle::from_json_str(json).map_err(|_| invalid())?;
        self.preview(
            Archive {
                recovery_version: None,
                bundle,
                credentials: Vec::new(),
                ssh_keys: Vec::new(),
                secrets: Vec::new(),
            },
            strategy,
        )
        .await
    }
    pub async fn preview_encrypted(
        &self,
        bytes: &[u8],
        password: &str,
        strategy: ConflictStrategy,
    ) -> DomainResult<ImportPreviewReport> {
        let plain = Zeroizing::new(open_package(password, bytes)?);
        let archive: Archive = serde_json::from_slice(&plain).map_err(|_| invalid())?;
        self.preview(archive, strategy).await
    }

    async fn preview(
        &self,
        mut archive: Archive,
        strategy: ConflictStrategy,
    ) -> DomainResult<ImportPreviewReport> {
        let warnings = archive.validate_and_sanitize()?;
        let inputs = archive
            .bundle
            .sessions
            .iter()
            .map(|session| serde_json::from_value(encoded(session)?).map_err(|_| invalid()))
            .collect::<DomainResult<Vec<SessionInput>>>()?;
        let existing = SessionRepo::new(self.store.clone())
            .list(&SessionQuery::default())
            .await?;
        let mut report =
            ImportPreviewEngine::generate_preview(inputs, &existing, strategy, warnings);
        let mut ids = HashMap::new();
        for record in archive.records()? {
            ids.insert(record.record_id, new_id());
        }
        for secret in &archive.secrets {
            ids.insert(secret.id.to_string(), new_id());
        }
        for proxy in &archive.bundle.proxies {
            ids.insert(proxy.id.clone(), new_id());
        }
        let mut reused = HashSet::new();
        let mut expected_entities = sync_codec::ArchiveExpected::new();
        self.store.with_conn(|conn| {
            let groups=conn.prepare("SELECT g.id,g.parent_id,g.name,g.kind,g.version,g.updated_at,COALESCE(r.local_rev,0) FROM session_group g LEFT JOIN sync_record r ON r.record_id=g.id WHERE g.deleted_at IS NULL").map_err(|_|invalid())?.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?,row.get::<_,i64>(6)?))).map_err(|_|invalid())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|invalid())?;
            // SQLite NOCASE folds ASCII only; preserve the displayed spelling.
            let mut names:HashSet<_>=groups.iter().map(|group|(group.1.clone(),group.2.to_ascii_lowercase())).collect();
            let mut processed=HashSet::new();
            while processed.len()<archive.bundle.groups.len() {
                let index=archive.bundle.groups.iter().position(|group| !processed.contains(group.id.as_str()) && group.parent_id.as_ref().is_none_or(|parent|processed.contains(parent.as_str()))).ok_or_else(invalid)?;
                let group=&mut archive.bundle.groups[index];
                let parent=group.parent_id.as_ref().map(|parent|ids.get(parent.as_str()).cloned().ok_or_else(invalid)).transpose()?;
                let kind=encoded(&group.kind)?.as_str().ok_or_else(invalid)?.to_owned();
                let existing=groups.iter().find(|existing|existing.1==parent && existing.2.eq_ignore_ascii_case(&group.name) && existing.3==kind);
                if let Some(existing)=existing.filter(|_| !matches!(strategy,ConflictStrategy::KeepBoth)) {
                    ids.insert(group.id.to_string(),existing.0.clone());
                    reused.insert(group.id.to_string());
                    expected_entities.insert((SyncRecordType::Group,existing.0.clone()),(existing.4,existing.5,existing.6,None));
                } else {
                    let base=group.name.clone();let mut suffix=2;
                    while names.contains(&(parent.clone(),group.name.to_ascii_lowercase())) {group.name=format!("{base} ({suffix})");suffix+=1;}
                    names.insert((parent,group.name.to_ascii_lowercase()));
                }
                processed.insert(group.id.to_string());
            }
            for key in &archive.ssh_keys {
                use rusqlite::OptionalExtension;
                let existing:Option<(String,i64,i64,i64,Option<i64>,String)>=conn.query_row("SELECT k.id,k.version,k.updated_at,COALESCE(r.local_rev,0),k.deleted_at,k.secret_id FROM ssh_key k LEFT JOIN sync_record r ON r.record_id=k.id WHERE k.fingerprint_sha256=?1",[&key.fingerprint_sha256],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(|_|invalid())?;
                if let Some(existing)=existing {
                    ids.insert(key.id.to_string(),existing.0.clone());
                    expected_entities.insert((SyncRecordType::SshKey,existing.0),(existing.1,existing.2,existing.3,existing.4));
                    if !matches!(strategy,ConflictStrategy::Overwrite) && existing.4.is_none() {
                        reused.insert(key.id.to_string());reused.insert(key.secret_id.to_string());
                        ids.insert(key.secret_id.to_string(),existing.5);
                    }
                }
            }
            Ok(())
        })?;
        for (session, candidate) in archive.bundle.sessions.iter().zip(&report.candidates) {
            if let Some(existing) = &candidate.existing_session_id {
                ids.insert(session.id.to_string(), existing.clone());
            }
        }
        for (session, candidate) in archive.bundle.sessions.iter().zip(&report.candidates) {
            if candidate.action == CandidateAction::Skip && candidate.existing_session_id.is_none()
            {
                let matched =
                    archive
                        .bundle
                        .sessions
                        .iter()
                        .zip(&report.candidates)
                        .find(|(_, other)| {
                            other.action != CandidateAction::Skip
                                && openshell_importer::preview::same_connection(
                                    &candidate.input,
                                    &other.input,
                                )
                        });
                if let Some((other, _)) = matched {
                    let id = ids.get(other.id.as_str()).ok_or_else(invalid)?.clone();
                    ids.insert(session.id.to_string(), id);
                } else {
                    return Err(DomainError::validation("归档会话有未解决的导入依赖"));
                }
            }
        }
        let mut expected_sessions = HashMap::new();
        self.store.with_conn(|conn| {
            for candidate in &report.candidates {
                if candidate.existing_session_id.is_some() {
                    let id = candidate.existing_session_id.as_ref().ok_or_else(invalid)?;
                    let expected = conn.query_row("SELECT s.version,s.updated_at,COALESCE(r.local_rev,0) FROM session s LEFT JOIN sync_record r ON r.record_id=s.id WHERE s.id=?1 AND s.deleted_at IS NULL",
                        [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_| invalid())?;
                    expected_sessions.insert(id.clone(), expected);
                }
            }
            Ok(())
        })?;
        let token = new_id();
        self.previews.lock().insert(
            token.clone(),
            Preview {
                archive,
                candidates: report.candidates.clone(),
                ids,
                expected_sessions,
                expected_entities,
                reused,
            },
        );
        report.archive_token = Some(token);
        Ok(report)
    }

    pub fn discard(&self, token: &str) {
        self.previews.lock().remove(token);
    }

    pub fn commit(&self, candidates: &[ImportCandidate], token: &str) -> DomainResult<usize> {
        let mut previews = self.previews.lock();
        let preview = previews
            .get_mut(token)
            .ok_or_else(|| DomainError::validation("归档预览已失效，请重新预览"))?;
        if encoded(&candidates)? != encoded(&preview.candidates)? {
            return Err(DomainError::validation("归档候选已变化，请重新预览"));
        }
        preview.archive.validate_and_sanitize()?;
        let mut records = preview.archive.records()?;
        let skipped: HashSet<_> = preview
            .archive
            .bundle
            .sessions
            .iter()
            .zip(candidates)
            .filter(|(_, candidate)| candidate.action == CandidateAction::Skip)
            .map(|(session, _)| session.id.to_string())
            .collect();
        records.retain(|record| {
            !preview.reused.contains(&record.record_id)
                && (record.record_type != SyncRecordType::Session
                    || !skipped.contains(&record.record_id))
        });
        for record in &mut records {
            if record.record_type == SyncRecordType::Session {
                let (_, candidate) = preview
                    .archive
                    .bundle
                    .sessions
                    .iter()
                    .zip(candidates)
                    .find(|(session, _)| session.id.as_str() == record.record_id)
                    .ok_or_else(invalid)?;
                record.payload["name"] = json!(candidate.input.name);
            }
            record.record_id = preview
                .ids
                .get(&record.record_id)
                .ok_or_else(invalid)?
                .clone();
            for field in [
                "parent_id",
                "group_id",
                "session_id",
                "credential_id",
                "ssh_key_id",
                "secret_id",
                "passphrase_credential_id",
                "socks_password_ref",
                "proxy_id",
            ] {
                if let Some(id) = record.payload[field].as_str() {
                    record.payload[field] = json!(preview.ids.get(id).ok_or_else(invalid)?);
                }
            }
            if let Some(jump) = record
                .payload
                .get_mut("proxy_jump")
                .filter(|value| !value.is_null())
            {
                let id = jump["session_id"].as_str().ok_or_else(invalid)?;
                jump["session_id"] = json!(preview.ids.get(id).ok_or_else(invalid)?);
            }
            if let Some(expected) = preview.expected_sessions.get(&record.record_id) {
                record.revision = expected.0 as u64;
            }
            if let Some(expected) = preview
                .expected_entities
                .get(&(record.record_type, record.record_id.clone()))
            {
                record.revision = expected.0 as u64;
            }
        }
        for secret in &preview.archive.secrets {
            if preview.reused.contains(secret.id.as_str()) {
                continue;
            }
            let id =
                SecretId::from_string(preview.ids.get(secret.id.as_str()).ok_or_else(invalid)?)?;
            let encrypted = self
                .vault
                .encrypt_secret(&id, &secret.record_type, &secret.data)?;
            records.push(LocalSyncRecord { record_id: id.to_string(), record_type: SyncRecordType::Secret,
                schema_version: SYNC_SCHEMA_VERSION, revision: 0, updated_at: now_ms(), device_id: None, deleted: false,
                payload: json!({"record_type":encrypted.record_type,"ciphertext":encrypted.ciphertext,"nonce":encrypted.nonce,"aad":encrypted.aad,"crypto_suite":encrypted.crypto_suite,"key_version":encrypted.key_version,"created_at":encrypted.created_at}) });
        }
        let mut proxies = preview.archive.bundle.proxies.clone();
        for proxy in &mut proxies {
            proxy.id = preview.ids.get(&proxy.id).ok_or_else(invalid)?.clone();
            proxy.password_ref = proxy
                .password_ref
                .as_ref()
                .map(|id| preview.ids.get(id).cloned().ok_or_else(invalid))
                .transpose()?;
            proxy.password = None;
            proxy.has_password = proxy.password_ref.is_some();
        }
        sync_codec::apply_archive_records(
            &self.store,
            &records,
            &preview.expected_sessions,
            &preview.expected_entities,
            &proxies,
        )?;
        let count = candidates
            .iter()
            .filter(|candidate| candidate.action != CandidateAction::Skip)
            .count();
        previews.remove(token);
        Ok(count)
    }
}
