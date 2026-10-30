//! 本地 SQLite 业务记录与同步明文载荷之间的确定性编解码。
//!
//! 此模块只处理已经解密的记录；网络信封和 AEAD 加解密仍由 sync-client 负责。

use openshell_core_domain::{now_ms, DomainError, DomainResult};
use openshell_store::Store;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use ulid::Ulid;

pub const SYNC_SCHEMA_VERSION: u32 = 2;

const SYNCABLE_SETTING_KEYS: &[&str] = &[
    "terminal.theme",
    "terminal.font_size",
    "terminal.font_family",
    "terminal.cursor_blink",
    "terminal.cursor_style",
    "terminal.scrollback",
    "terminal.keepalive_default_sec",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRecordType {
    Group,
    Secret,
    Credential,
    SshKey,
    Session,
    KnownHost,
    Snippet,
    PortForward,
    Setting,
}

impl SyncRecordType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Group => "group",
            Self::Secret => "secret",
            Self::Credential => "credential",
            Self::SshKey => "ssh_key",
            Self::Session => "session",
            Self::KnownHost => "known_host",
            Self::Snippet => "snippet",
            Self::PortForward => "port_forward",
            Self::Setting => "setting",
        }
    }

    pub fn parse(value: &str) -> DomainResult<Self> {
        match value {
            "group" | "session_group" => Ok(Self::Group),
            "secret" => Ok(Self::Secret),
            "credential" => Ok(Self::Credential),
            "ssh_key" => Ok(Self::SshKey),
            "session" => Ok(Self::Session),
            "known_host" => Ok(Self::KnownHost),
            "snippet" => Ok(Self::Snippet),
            "port_forward" => Ok(Self::PortForward),
            "setting" => Ok(Self::Setting),
            _ => Err(DomainError::validation("unsupported sync record type")),
        }
    }

    fn apply_order(self) -> u8 {
        match self {
            Self::Group => 0,
            Self::Secret => 1,
            Self::Credential => 2,
            Self::SshKey => 3,
            Self::Session => 4,
            Self::KnownHost => 5,
            Self::Snippet => 6,
            Self::PortForward => 7,
            Self::Setting => 8,
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Group => "session_group",
            Self::Secret => "secret",
            Self::Credential => "credential",
            Self::SshKey => "ssh_key",
            Self::Session => "session",
            Self::KnownHost => "known_host",
            Self::Snippet => "snippet",
            Self::PortForward => "port_forward",
            Self::Setting => "setting",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalSyncRecord {
    pub record_id: String,
    pub record_type: SyncRecordType,
    pub schema_version: u32,
    pub revision: u64,
    pub updated_at: i64,
    pub device_id: Option<String>,
    pub deleted: bool,
    pub payload: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplySummary {
    pub applied: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone)]
pub struct AppliedSyncRecord {
    pub record_id: String,
    pub record_type: SyncRecordType,
    pub revision: u64,
    pub key_version: u64,
    pub checksum: Option<String>,
    pub deleted: bool,
}

#[derive(Debug, Clone)]
pub struct ConflictBackupInput {
    pub record_id: String,
    pub record_type: SyncRecordType,
    pub local_snapshot: Option<Value>,
    pub remote_ciphertext_b64: String,
    pub remote_checksum: String,
    pub remote_revision: u64,
    pub remote_device_id: Option<String>,
    pub remote_deleted: bool,
    pub remote_updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GroupPayload {
    parent_id: Option<String>,
    name: String,
    kind: String,
    sort_order: i64,
    color: Option<String>,
    icon_key: Option<String>,
    notes: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionPayload {
    group_id: Option<String>,
    name: String,
    protocol: String,
    host: Option<String>,
    port: Option<i64>,
    username: Option<String>,
    auth_method: String,
    credential_id: Option<String>,
    ssh_key_id: Option<String>,
    host_key_policy: String,
    proxy_jump: Option<Value>,
    proxy_id: Option<String>,
    terminal_profile_id: Option<String>,
    encoding: String,
    startup_command: Option<String>,
    working_dir: Option<String>,
    keepalive_sec: i64,
    keepalive_max_miss: i64,
    auto_reconnect: bool,
    reconnect_max: i64,
    compression: bool,
    agent_forwarding: bool,
    x11_forwarding: bool,
    tags: Value,
    favorite: bool,
    color: Option<String>,
    icon_key: Option<String>,
    notes: Option<String>,
    protocol_options: Option<Value>,
    sort_order: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CredentialPayload {
    name: String,
    kind: String,
    username: Option<String>,
    secret_id: String,
    hint: Option<String>,
    save_policy: String,
    expires_at: Option<i64>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretPayload {
    record_type: String,
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    aad: Vec<u8>,
    crypto_suite: String,
    key_version: u32,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SshKeyPayload {
    name: String,
    algorithm: String,
    key_size: Option<i64>,
    public_key: String,
    fingerprint_sha256: String,
    secret_id: String,
    passphrase_credential_id: Option<String>,
    has_passphrase: bool,
    comment: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownHostPayload {
    host: String,
    port: i64,
    key_type: String,
    public_key: String,
    fingerprint_sha256: String,
    status: String,
    previous_fingerprint: Option<String>,
    first_seen_at: i64,
    last_seen_at: i64,
    changed_at: Option<i64>,
    source: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnippetPayload {
    group_id: Option<String>,
    kind: String,
    name: String,
    body: Option<String>,
    variables: Value,
    macro_steps: Option<Value>,
    send_mode: String,
    shortcut: Option<String>,
    sort_order: i64,
    tags: Value,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortForwardPayload {
    session_id: Option<String>,
    name: String,
    forward_type: String,
    bind_host: String,
    bind_port: i64,
    dest_host: Option<String>,
    dest_port: Option<i64>,
    auto_start: bool,
    auto_reconnect: bool,
    reconnect_max: i64,
    socks_auth: String,
    socks_username: Option<String>,
    socks_password_ref: Option<String>,
    expose_warning_ack: bool,
    sort_order: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SettingPayload {
    scope: String,
    scope_id: Option<String>,
    key: String,
    value: Value,
    value_type: String,
}

fn db_error(error: impl std::fmt::Display) -> DomainError {
    DomainError::internal(format!("sync database operation failed: {error}"))
}

fn json_error(error: impl std::fmt::Display) -> DomainError {
    DomainError::validation(format!("invalid sync record payload: {error}"))
}

fn json_text(value: String) -> Value {
    serde_json::from_str(&value).unwrap_or(Value::String(value))
}

fn optional_json_text(value: Option<String>) -> Option<Value> {
    value.map(json_text)
}

fn encode_json(value: &Value) -> DomainResult<String> {
    serde_json::to_string(value).map_err(json_error)
}

fn encode_optional_json(value: &Option<Value>) -> DomainResult<Option<String>> {
    value.as_ref().map(encode_json).transpose()
}

fn decode_payload<T: DeserializeOwned>(record: &LocalSyncRecord) -> DomainResult<T> {
    serde_json::from_value(record.payload.clone()).map_err(json_error)
}

fn make_record<T: Serialize>(
    record_type: SyncRecordType,
    record_id: String,
    revision: i64,
    updated_at: i64,
    device_id: Option<String>,
    deleted_at: Option<i64>,
    payload: T,
) -> rusqlite::Result<LocalSyncRecord> {
    Ok(LocalSyncRecord {
        record_id,
        record_type,
        schema_version: SYNC_SCHEMA_VERSION,
        revision: u64::try_from(revision.max(0)).unwrap_or(0),
        updated_at,
        device_id,
        deleted: deleted_at.is_some(),
        payload: serde_json::to_value(payload)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
    })
}

fn collect_rows(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<LocalSyncRecord>,
) -> DomainResult<Vec<LocalSyncRecord>> {
    let mut statement = conn.prepare(sql).map_err(db_error)?;
    let rows = statement.query_map([], map).map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

pub fn collect_dirty_records(store: &Store) -> DomainResult<Vec<LocalSyncRecord>> {
    store.with_conn(|conn| {
        let mut records = Vec::new();

        records.extend(collect_rows(
            conn,
            "SELECT id, parent_id, name, kind, sort_order, color, icon_key, notes, created_at, \
             updated_at, deleted_at, version, origin_device_id FROM session_group WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::Group,
                    row.get(0)?,
                    row.get(11)?,
                    row.get(9)?,
                    row.get(12)?,
                    row.get(10)?,
                    GroupPayload {
                        parent_id: row.get(1)?,
                        name: row.get(2)?,
                        kind: row.get(3)?,
                        sort_order: row.get(4)?,
                        color: row.get(5)?,
                        icon_key: row.get(6)?,
                        notes: row.get(7)?,
                        created_at: row.get(8)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, record_type, ciphertext, nonce, aad, crypto_suite, key_version, created_at, \
             updated_at, deleted_at, version, origin_device_id FROM secret WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::Secret,
                    row.get(0)?,
                    row.get(10)?,
                    row.get(8)?,
                    row.get(11)?,
                    row.get(9)?,
                    SecretPayload {
                        record_type: row.get(1)?,
                        ciphertext: row.get(2)?,
                        nonce: row.get(3)?,
                        aad: row.get(4)?,
                        crypto_suite: row.get(5)?,
                        key_version: row.get(6)?,
                        created_at: row.get(7)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, name, kind, username, secret_id, hint, save_policy, expires_at, created_at, \
             updated_at, deleted_at, version, origin_device_id FROM credential WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::Credential,
                    row.get(0)?,
                    row.get(11)?,
                    row.get(9)?,
                    row.get(12)?,
                    row.get(10)?,
                    CredentialPayload {
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        username: row.get(3)?,
                        secret_id: row.get(4)?,
                        hint: row.get(5)?,
                        save_policy: row.get(6)?,
                        expires_at: row.get(7)?,
                        created_at: row.get(8)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, name, algorithm, key_size, public_key, fingerprint_sha256, secret_id, \
             passphrase_credential_id, has_passphrase, comment, created_at, updated_at, deleted_at, \
             version, origin_device_id FROM ssh_key WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::SshKey,
                    row.get(0)?,
                    row.get(13)?,
                    row.get(11)?,
                    row.get(14)?,
                    row.get(12)?,
                    SshKeyPayload {
                        name: row.get(1)?,
                        algorithm: row.get(2)?,
                        key_size: row.get(3)?,
                        public_key: row.get(4)?,
                        fingerprint_sha256: row.get(5)?,
                        secret_id: row.get(6)?,
                        passphrase_credential_id: row.get(7)?,
                        has_passphrase: row.get::<_, i64>(8)? != 0,
                        comment: row.get(9)?,
                        created_at: row.get(10)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, group_id, name, protocol, host, port, username, auth_method, credential_id, \
             ssh_key_id, host_key_policy, proxy_jump_json, proxy_id, terminal_profile_id, encoding, \
             startup_command, working_dir, keepalive_sec, keepalive_max_miss, auto_reconnect, \
             reconnect_max, compression, agent_forwarding, x11_forwarding, tags_json, favorite, \
             color, icon_key, notes, protocol_options_json, sort_order, created_at, updated_at, \
             deleted_at, version, origin_device_id FROM session WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::Session,
                    row.get(0)?,
                    row.get(34)?,
                    row.get(32)?,
                    row.get(35)?,
                    row.get(33)?,
                    SessionPayload {
                        group_id: row.get(1)?,
                        name: row.get(2)?,
                        protocol: row.get(3)?,
                        host: row.get(4)?,
                        port: row.get(5)?,
                        username: row.get(6)?,
                        auth_method: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "none".into()),
                        credential_id: row.get(8)?,
                        ssh_key_id: row.get(9)?,
                        host_key_policy: row.get(10)?,
                        proxy_jump: optional_json_text(row.get(11)?),
                        proxy_id: row.get(12)?,
                        terminal_profile_id: row.get(13)?,
                        encoding: row.get(14)?,
                        startup_command: row.get(15)?,
                        working_dir: row.get(16)?,
                        keepalive_sec: row.get(17)?,
                        keepalive_max_miss: row.get(18)?,
                        auto_reconnect: row.get::<_, i64>(19)? != 0,
                        reconnect_max: row.get(20)?,
                        compression: row.get::<_, i64>(21)? != 0,
                        agent_forwarding: row.get::<_, i64>(22)? != 0,
                        x11_forwarding: row.get::<_, i64>(23)? != 0,
                        tags: json_text(row.get(24)?),
                        favorite: row.get::<_, i64>(25)? != 0,
                        color: row.get(26)?,
                        icon_key: row.get(27)?,
                        notes: row.get(28)?,
                        protocol_options: optional_json_text(row.get(29)?),
                        sort_order: row.get(30)?,
                        created_at: row.get(31)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, host, port, key_type, public_key, fingerprint_sha256, status, \
             previous_fingerprint, first_seen_at, last_seen_at, changed_at, source, created_at, \
             updated_at, deleted_at, version, origin_device_id FROM known_host WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::KnownHost,
                    row.get(0)?,
                    row.get(15)?,
                    row.get(13)?,
                    row.get(16)?,
                    row.get(14)?,
                    KnownHostPayload {
                        host: row.get(1)?,
                        port: row.get(2)?,
                        key_type: row.get(3)?,
                        public_key: row.get(4)?,
                        fingerprint_sha256: row.get(5)?,
                        status: row.get(6)?,
                        previous_fingerprint: row.get(7)?,
                        first_seen_at: row.get(8)?,
                        last_seen_at: row.get(9)?,
                        changed_at: row.get(10)?,
                        source: row.get(11)?,
                        created_at: row.get(12)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, group_id, kind, name, body, variables_json, macro_steps_json, send_mode, \
             shortcut, sort_order, tags_json, created_at, updated_at, deleted_at, version, \
             origin_device_id FROM snippet WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::Snippet,
                    row.get(0)?,
                    row.get(14)?,
                    row.get(12)?,
                    row.get(15)?,
                    row.get(13)?,
                    SnippetPayload {
                        group_id: row.get(1)?,
                        kind: row.get(2)?,
                        name: row.get(3)?,
                        body: row.get(4)?,
                        variables: json_text(row.get(5)?),
                        macro_steps: optional_json_text(row.get(6)?),
                        send_mode: row.get(7)?,
                        shortcut: row.get(8)?,
                        sort_order: row.get(9)?,
                        tags: json_text(row.get(10)?),
                        created_at: row.get(11)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, session_id, name, type, bind_host, bind_port, dest_host, dest_port, \
             auto_start, auto_reconnect, reconnect_max, socks_auth, socks_username, \
             socks_password_ref, expose_warning_ack, sort_order, created_at, updated_at, deleted_at, \
             version, origin_device_id FROM port_forward WHERE dirty = 1",
            |row| {
                make_record(
                    SyncRecordType::PortForward,
                    row.get(0)?,
                    row.get(19)?,
                    row.get(17)?,
                    row.get(20)?,
                    row.get(18)?,
                    PortForwardPayload {
                        session_id: row.get(1)?,
                        name: row.get(2)?,
                        forward_type: row.get(3)?,
                        bind_host: row.get(4)?,
                        bind_port: row.get(5)?,
                        dest_host: row.get(6)?,
                        dest_port: row.get(7)?,
                        auto_start: row.get::<_, i64>(8)? != 0,
                        auto_reconnect: row.get::<_, i64>(9)? != 0,
                        reconnect_max: row.get(10)?,
                        socks_auth: row.get(11)?,
                        socks_username: row.get(12)?,
                        socks_password_ref: row.get(13)?,
                        expose_warning_ack: row.get::<_, i64>(14)? != 0,
                        sort_order: row.get(15)?,
                        created_at: row.get(16)?,
                    },
                )
            },
        )?);

        records.extend(collect_rows(
            conn,
            "SELECT id, scope, scope_id, key, value_json, value_type, updated_at, version, \
             origin_device_id FROM setting WHERE dirty = 1 AND syncable = 1 AND scope = 'user' \
             AND key IN ('terminal.theme', 'terminal.font_size', 'terminal.font_family', \
             'terminal.cursor_blink', 'terminal.cursor_style', 'terminal.scrollback', \
             'terminal.keepalive_default_sec')",
            |row| {
                make_record(
                    SyncRecordType::Setting,
                    row.get(0)?,
                    row.get(7)?,
                    row.get(6)?,
                    row.get(8)?,
                    None,
                    SettingPayload {
                        scope: row.get(1)?,
                        scope_id: row.get(2)?,
                        key: row.get(3)?,
                        value: json_text(row.get(4)?),
                        value_type: row.get(5)?,
                    },
                )
            },
        )?);

        records.sort_by_key(|record| (record.record_type.apply_order(), record.updated_at));
        Ok(records)
    })
}

fn revision_i64(revision: u64) -> DomainResult<i64> {
    i64::try_from(revision).map_err(|_| DomainError::validation("sync revision is out of range"))
}

fn validate_remote_record(record: &LocalSyncRecord) -> DomainResult<()> {
    if record.record_id.trim().is_empty() {
        return Err(DomainError::validation("sync record id is empty"));
    }
    if record.schema_version != SYNC_SCHEMA_VERSION {
        return Err(DomainError::validation(format!(
            "unsupported sync schema version {}; expected {}",
            record.schema_version, SYNC_SCHEMA_VERSION
        )));
    }
    revision_i64(record.revision)?;
    Ok(())
}

fn upsert_group(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: GroupPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO session_group (id, parent_id, name, kind, sort_order, color, icon_key, \
         expanded, notes, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, NULL, ?11, ?12, 0) \
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, \
         kind = excluded.kind, sort_order = excluded.sort_order, color = excluded.color, \
         icon_key = excluded.icon_key, notes = excluded.notes, updated_at = excluded.updated_at, \
         deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.parent_id,
            payload.name,
            payload.kind,
            payload.sort_order,
            payload.color,
            payload.icon_key,
            payload.notes,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_secret(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: SecretPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO secret (id, record_type, ciphertext, nonce, aad, crypto_suite, key_version, \
         created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, 0) \
         ON CONFLICT(id) DO UPDATE SET record_type = excluded.record_type, \
         ciphertext = excluded.ciphertext, nonce = excluded.nonce, aad = excluded.aad, \
         crypto_suite = excluded.crypto_suite, key_version = excluded.key_version, \
         updated_at = excluded.updated_at, deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.record_type,
            payload.ciphertext,
            payload.nonce,
            payload.aad,
            payload.crypto_suite,
            payload.key_version,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_credential(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: CredentialPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO credential (id, name, kind, username, secret_id, hint, save_policy, \
         expires_at, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, 0) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, \
         username = excluded.username, secret_id = excluded.secret_id, hint = excluded.hint, \
         save_policy = excluded.save_policy, expires_at = excluded.expires_at, \
         updated_at = excluded.updated_at, deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.name,
            payload.kind,
            payload.username,
            payload.secret_id,
            payload.hint,
            payload.save_policy,
            payload.expires_at,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_ssh_key(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: SshKeyPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO ssh_key (id, name, algorithm, key_size, public_key, fingerprint_sha256, \
         secret_id, passphrase_credential_id, has_passphrase, comment, created_at, updated_at, \
         deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14, 0) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, algorithm = excluded.algorithm, \
         key_size = excluded.key_size, public_key = excluded.public_key, \
         fingerprint_sha256 = excluded.fingerprint_sha256, secret_id = excluded.secret_id, \
         passphrase_credential_id = excluded.passphrase_credential_id, \
         has_passphrase = excluded.has_passphrase, comment = excluded.comment, \
         updated_at = excluded.updated_at, deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.name,
            payload.algorithm,
            payload.key_size,
            payload.public_key,
            payload.fingerprint_sha256,
            payload.secret_id,
            payload.passphrase_credential_id,
            payload.has_passphrase,
            payload.comment,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_session(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: SessionPayload = decode_payload(record)?;
    let proxy_jump = encode_optional_json(&payload.proxy_jump)?;
    let tags = encode_json(&payload.tags)?;
    let protocol_options = encode_optional_json(&payload.protocol_options)?;
    tx.execute(
        "INSERT INTO session (id, group_id, name, protocol, host, port, username, auth_method, \
         credential_id, ssh_key_id, host_key_policy, proxy_jump_json, proxy_id, \
         terminal_profile_id, encoding, startup_command, working_dir, keepalive_sec, \
         keepalive_max_miss, auto_reconnect, reconnect_max, compression, agent_forwarding, \
         x11_forwarding, tags_json, favorite, color, icon_key, notes, protocol_options_json, \
         sort_order, created_at, updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
         ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, \
         ?31, ?32, ?33, NULL, ?34, ?35, 0) \
         ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, name = excluded.name, \
         protocol = excluded.protocol, host = excluded.host, port = excluded.port, \
         username = excluded.username, auth_method = excluded.auth_method, \
         credential_id = excluded.credential_id, ssh_key_id = excluded.ssh_key_id, \
         host_key_policy = excluded.host_key_policy, proxy_jump_json = excluded.proxy_jump_json, \
         proxy_id = excluded.proxy_id, terminal_profile_id = excluded.terminal_profile_id, \
         encoding = excluded.encoding, startup_command = excluded.startup_command, \
         working_dir = excluded.working_dir, keepalive_sec = excluded.keepalive_sec, \
         keepalive_max_miss = excluded.keepalive_max_miss, \
         auto_reconnect = excluded.auto_reconnect, reconnect_max = excluded.reconnect_max, \
         compression = excluded.compression, agent_forwarding = excluded.agent_forwarding, \
         x11_forwarding = excluded.x11_forwarding, tags_json = excluded.tags_json, \
         favorite = excluded.favorite, color = excluded.color, icon_key = excluded.icon_key, \
         notes = excluded.notes, protocol_options_json = excluded.protocol_options_json, \
         sort_order = excluded.sort_order, updated_at = excluded.updated_at, deleted_at = NULL, \
         version = excluded.version, origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.group_id,
            payload.name,
            payload.protocol,
            payload.host,
            payload.port,
            payload.username,
            payload.auth_method,
            payload.credential_id,
            payload.ssh_key_id,
            payload.host_key_policy,
            proxy_jump,
            payload.proxy_id,
            payload.terminal_profile_id,
            payload.encoding,
            payload.startup_command,
            payload.working_dir,
            payload.keepalive_sec,
            payload.keepalive_max_miss,
            payload.auto_reconnect,
            payload.reconnect_max,
            payload.compression,
            payload.agent_forwarding,
            payload.x11_forwarding,
            tags,
            payload.favorite,
            payload.color,
            payload.icon_key,
            payload.notes,
            protocol_options,
            payload.sort_order,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_known_host(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: KnownHostPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO known_host (id, host, port, key_type, public_key, fingerprint_sha256, status, \
         previous_fingerprint, first_seen_at, last_seen_at, changed_at, source, created_at, \
         updated_at, deleted_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, \
         ?15, ?16, 0) \
         ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port, \
         key_type = excluded.key_type, public_key = excluded.public_key, \
         fingerprint_sha256 = excluded.fingerprint_sha256, status = excluded.status, \
         previous_fingerprint = excluded.previous_fingerprint, \
         first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, \
         changed_at = excluded.changed_at, source = excluded.source, updated_at = excluded.updated_at, \
         deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.host,
            payload.port,
            payload.key_type,
            payload.public_key,
            payload.fingerprint_sha256,
            payload.status,
            payload.previous_fingerprint,
            payload.first_seen_at,
            payload.last_seen_at,
            payload.changed_at,
            payload.source,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_snippet(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: SnippetPayload = decode_payload(record)?;
    let variables = encode_json(&payload.variables)?;
    let macro_steps = encode_optional_json(&payload.macro_steps)?;
    let tags = encode_json(&payload.tags)?;
    tx.execute(
        "INSERT INTO snippet (id, group_id, kind, name, body, variables_json, macro_steps_json, \
         send_mode, shortcut, sort_order, tags_json, created_at, updated_at, deleted_at, version, \
         origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?15, 0) \
         ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, kind = excluded.kind, \
         name = excluded.name, body = excluded.body, variables_json = excluded.variables_json, \
         macro_steps_json = excluded.macro_steps_json, send_mode = excluded.send_mode, \
         shortcut = excluded.shortcut, sort_order = excluded.sort_order, tags_json = excluded.tags_json, \
         updated_at = excluded.updated_at, deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.group_id,
            payload.kind,
            payload.name,
            payload.body,
            variables,
            macro_steps,
            payload.send_mode,
            payload.shortcut,
            payload.sort_order,
            tags,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_port_forward(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: PortForwardPayload = decode_payload(record)?;
    tx.execute(
        "INSERT INTO port_forward (id, session_id, name, type, bind_host, bind_port, dest_host, \
         dest_port, auto_start, auto_reconnect, reconnect_max, socks_auth, socks_username, \
         socks_password_ref, expose_warning_ack, sort_order, created_at, updated_at, deleted_at, \
         version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
         ?17, ?18, NULL, ?19, ?20, 0) \
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, name = excluded.name, \
         type = excluded.type, bind_host = excluded.bind_host, bind_port = excluded.bind_port, \
         dest_host = excluded.dest_host, dest_port = excluded.dest_port, \
         auto_start = excluded.auto_start, auto_reconnect = excluded.auto_reconnect, \
         reconnect_max = excluded.reconnect_max, socks_auth = excluded.socks_auth, \
         socks_username = excluded.socks_username, socks_password_ref = excluded.socks_password_ref, \
         expose_warning_ack = excluded.expose_warning_ack, sort_order = excluded.sort_order, \
         updated_at = excluded.updated_at, deleted_at = NULL, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.session_id,
            payload.name,
            payload.forward_type,
            payload.bind_host,
            payload.bind_port,
            payload.dest_host,
            payload.dest_port,
            payload.auto_start,
            payload.auto_reconnect,
            payload.reconnect_max,
            payload.socks_auth,
            payload.socks_username,
            payload.socks_password_ref,
            payload.expose_warning_ack,
            payload.sort_order,
            payload.created_at,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_setting(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    let payload: SettingPayload = decode_payload(record)?;
    if payload.scope != "user" || !SYNCABLE_SETTING_KEYS.contains(&payload.key.as_str()) {
        return Err(DomainError::validation(
            "setting is not in the sync allowlist",
        ));
    }
    let value = encode_json(&payload.value)?;
    tx.execute(
        "DELETE FROM setting WHERE scope = ?1 AND scope_id IS ?2 AND key = ?3 AND id <> ?4",
        params![
            &payload.scope,
            &payload.scope_id,
            &payload.key,
            &record.record_id
        ],
    )
    .map_err(db_error)?;
    tx.execute(
        "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, \
         updated_at, version, origin_device_id, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, 0) \
         ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, scope_id = excluded.scope_id, \
         key = excluded.key, value_json = excluded.value_json, value_type = excluded.value_type, \
         syncable = 1, updated_at = excluded.updated_at, version = excluded.version, \
         origin_device_id = excluded.origin_device_id, dirty = 0",
        params![
            &record.record_id,
            payload.scope,
            payload.scope_id,
            payload.key,
            value,
            payload.value_type,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn upsert_record(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    match record.record_type {
        SyncRecordType::Group => upsert_group(tx, record),
        SyncRecordType::Secret => upsert_secret(tx, record),
        SyncRecordType::Credential => upsert_credential(tx, record),
        SyncRecordType::SshKey => upsert_ssh_key(tx, record),
        SyncRecordType::Session => upsert_session(tx, record),
        SyncRecordType::KnownHost => upsert_known_host(tx, record),
        SyncRecordType::Snippet => upsert_snippet(tx, record),
        SyncRecordType::PortForward => upsert_port_forward(tx, record),
        SyncRecordType::Setting => upsert_setting(tx, record),
    }
}

fn apply_tombstone(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    if record.record_type == SyncRecordType::Setting {
        tx.execute(
            "DELETE FROM setting WHERE id = ?1",
            params![&record.record_id],
        )
        .map_err(db_error)?;
        return Ok(());
    }

    let sql = format!(
        "UPDATE {} SET deleted_at = ?2, updated_at = ?2, version = ?3, \
         origin_device_id = ?4, dirty = 0 WHERE id = ?1",
        record.record_type.table()
    );
    tx.execute(
        &sql,
        params![
            &record.record_id,
            record.updated_at,
            revision_i64(record.revision)?,
            &record.device_id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn update_sync_record(tx: &Transaction<'_>, record: &LocalSyncRecord) -> DomainResult<()> {
    tx.execute(
        "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, sync_state, \
         conflict_json, updated_at, schema_version, revision, device_id, deleted) \
         VALUES (?1, ?2, ?3, ?3, 'clean', NULL, ?4, ?5, ?3, ?6, ?7) \
         ON CONFLICT(record_id) DO UPDATE SET record_type = excluded.record_type, \
         base_version = excluded.base_version, local_rev = excluded.local_rev, \
         sync_state = 'clean', conflict_json = NULL, updated_at = excluded.updated_at, \
         schema_version = excluded.schema_version, revision = excluded.revision, \
         device_id = excluded.device_id, deleted = excluded.deleted",
        params![
            &record.record_id,
            record.record_type.as_str(),
            revision_i64(record.revision)?,
            record.updated_at,
            record.schema_version,
            &record.device_id,
            record.deleted,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

/// 把已解密的远端记录按外键依赖顺序原子写入本地业务表。
pub fn apply_remote_records(
    store: &Store,
    records: &[LocalSyncRecord],
) -> DomainResult<ApplySummary> {
    for record in records {
        validate_remote_record(record)?;
    }

    let mut ordered: Vec<&LocalSyncRecord> = records.iter().collect();
    ordered.sort_by_key(|record| (record.record_type.apply_order(), record.updated_at));

    store.with_conn(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.pragma_update(None, "defer_foreign_keys", 1i64)
            .map_err(db_error)?;

        let mut summary = ApplySummary::default();
        for record in ordered {
            let current_revision: Option<i64> = tx
                .query_row(
                    "SELECT revision FROM sync_record WHERE record_id = ?1",
                    params![&record.record_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if current_revision.is_some_and(|revision| revision >= record.revision as i64) {
                continue;
            }

            if record.deleted {
                apply_tombstone(&tx, record)?;
                summary.deleted += 1;
            } else {
                upsert_record(&tx, record)?;
                summary.applied += 1;
            }
            update_sync_record(&tx, record)?;
        }

        tx.commit().map_err(db_error)?;
        Ok(summary)
    })
}

/// 服务端确认提交后，把对应业务记录与同步元数据一并标记为 clean。
pub fn mark_records_applied(store: &Store, applied: &[AppliedSyncRecord]) -> DomainResult<()> {
    store.with_conn(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let updated_at = now_ms();

        for record in applied {
            let revision = revision_i64(record.revision)?;
            let table = record.record_type.table();
            tx.execute(
                &format!("UPDATE {table} SET dirty = 0, version = ?2 WHERE id = ?1"),
                params![&record.record_id, revision],
            )
            .map_err(db_error)?;
            tx.execute(
                "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, \
                 server_checksum, sync_state, conflict_json, updated_at, schema_version, \
                 key_version, revision, deleted) \
                 VALUES (?1, ?2, ?3, ?3, ?4, 'clean', NULL, ?5, ?6, ?7, ?3, ?8) \
                 ON CONFLICT(record_id) DO UPDATE SET record_type = excluded.record_type, \
                 base_version = excluded.base_version, local_rev = excluded.local_rev, \
                 server_checksum = excluded.server_checksum, sync_state = 'clean', \
                 conflict_json = NULL, updated_at = excluded.updated_at, \
                 schema_version = excluded.schema_version, key_version = excluded.key_version, \
                 revision = excluded.revision, deleted = excluded.deleted",
                params![
                    &record.record_id,
                    record.record_type.as_str(),
                    revision,
                    &record.checksum,
                    updated_at,
                    SYNC_SCHEMA_VERSION,
                    revision_i64(record.key_version)?,
                    record.deleted,
                ],
            )
            .map_err(db_error)?;
        }

        tx.commit().map_err(db_error)?;
        Ok(())
    })
}

/// 保存冲突双方，供界面恢复；远端内容始终保持密文。
pub fn backup_conflict(store: &Store, input: ConflictBackupInput) -> DomainResult<String> {
    let conflict_id = Ulid::new().to_string();
    let local_snapshot = input
        .local_snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(json_error)?;
    let conflict_json = serde_json::to_string(&serde_json::json!({
        "conflict_id": conflict_id,
        "remote_revision": input.remote_revision,
        "remote_device_id": input.remote_device_id,
        "remote_deleted": input.remote_deleted,
        "remote_updated_at": input.remote_updated_at,
    }))
    .map_err(json_error)?;
    let remote_revision = revision_i64(input.remote_revision)?;
    let created_at = now_ms();

    store.with_conn(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute(
            "INSERT INTO sync_conflict (id, record_id, record_type, local_snapshot_json, \
             remote_ciphertext_b64, remote_checksum, remote_revision, remote_device_id, \
             remote_deleted, remote_updated_at, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &conflict_id,
                &input.record_id,
                input.record_type.as_str(),
                local_snapshot,
                &input.remote_ciphertext_b64,
                &input.remote_checksum,
                remote_revision,
                &input.remote_device_id,
                input.remote_deleted,
                input.remote_updated_at,
                created_at,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, \
             server_checksum, sync_state, conflict_json, updated_at, schema_version, revision, \
             device_id, deleted, remote_ciphertext_b64) \
             VALUES (?1, ?2, ?3, ?3, ?4, 'conflict', ?5, ?6, ?7, ?3, ?8, ?9, ?10) \
             ON CONFLICT(record_id) DO UPDATE SET record_type = excluded.record_type, \
             base_version = excluded.base_version, server_checksum = excluded.server_checksum, \
             sync_state = 'conflict', conflict_json = excluded.conflict_json, \
             updated_at = excluded.updated_at, schema_version = excluded.schema_version, \
             revision = excluded.revision, device_id = excluded.device_id, \
             deleted = excluded.deleted, remote_ciphertext_b64 = excluded.remote_ciphertext_b64",
            params![
                &input.record_id,
                input.record_type.as_str(),
                remote_revision,
                &input.remote_checksum,
                conflict_json,
                created_at,
                SYNC_SCHEMA_VERSION,
                &input.remote_device_id,
                input.remote_deleted,
                &input.remote_ciphertext_b64,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE sync_meta SET conflict_count = \
             (SELECT COUNT(*) FROM sync_conflict WHERE resolved_at IS NULL), \
             sync_state = 'conflict'",
            [],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(conflict_id.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_store() -> Store {
        let store = Store::open_in_memory().expect("open in-memory store");
        store.migrate().expect("migrate store");
        store
    }

    fn remote_record<T: Serialize>(
        record_type: SyncRecordType,
        record_id: &str,
        revision: u64,
        updated_at: i64,
        deleted: bool,
        payload: T,
    ) -> LocalSyncRecord {
        LocalSyncRecord {
            record_id: record_id.to_string(),
            record_type,
            schema_version: SYNC_SCHEMA_VERSION,
            revision,
            updated_at,
            device_id: Some("remote-device".to_string()),
            deleted,
            payload: serde_json::to_value(payload).expect("serialize test payload"),
        }
    }

    #[test]
    fn collects_all_supported_dirty_entities() {
        let store = fresh_store();
        store
            .with_conn(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO session_group
                      (id, name, kind, created_at, updated_at, version, origin_device_id, dirty)
                    VALUES ('group', 'Servers', 'session', 10, 20, 1, 'local-device', 1);
                    INSERT INTO secret
                      (id, record_type, ciphertext, nonce, aad, crypto_suite, key_version,
                       created_at, updated_at, version, origin_device_id, dirty)
                    VALUES ('secret', 'credential', X'0102', X'03', X'04',
                            'xchacha20poly1305', 1, 10, 20, 1, 'local-device', 1);
                    INSERT INTO credential
                      (id, name, kind, secret_id, created_at, updated_at, version,
                       origin_device_id, dirty)
                    VALUES ('credential', 'Root', 'password', 'secret', 10, 20, 1,
                            'local-device', 1);
                    INSERT INTO ssh_key
                      (id, name, algorithm, public_key, fingerprint_sha256, secret_id,
                       created_at, updated_at, version, origin_device_id, dirty)
                    VALUES ('key', 'Deploy', 'ed25519', 'ssh-ed25519 AAAA', 'SHA256:key',
                            'secret', 10, 20, 1, 'local-device', 1);
                    INSERT INTO session
                      (id, group_id, name, protocol, host, port, username, credential_id,
                       ssh_key_id, created_at, updated_at, version, origin_device_id, dirty)
                    VALUES ('session', 'group', 'Prod', 'ssh', 'prod.invalid', 22, 'root',
                            'credential', 'key', 10, 20, 1, 'local-device', 1);
                    INSERT INTO known_host
                      (id, host, port, key_type, public_key, fingerprint_sha256,
                       first_seen_at, last_seen_at, created_at, updated_at, version,
                       origin_device_id, dirty)
                    VALUES ('known', 'prod.invalid', 22, 'ssh-ed25519', 'AAAA', 'SHA256:host',
                            10, 20, 10, 20, 1, 'local-device', 1);
                    INSERT INTO snippet
                      (id, group_id, name, body, created_at, updated_at, version,
                       origin_device_id, dirty)
                    VALUES ('snippet', 'group', 'Uptime', 'uptime', 10, 20, 1,
                            'local-device', 1);
                    INSERT INTO port_forward
                      (id, session_id, name, type, bind_port, dest_host, dest_port,
                       created_at, updated_at, version, origin_device_id, dirty)
                    VALUES ('forward', 'session', 'Web', 'local', 8080, '127.0.0.1', 80,
                            10, 20, 1, 'local-device', 1);
                    INSERT INTO setting
                      (id, scope, key, value_json, value_type, syncable, updated_at,
                       version, origin_device_id, dirty)
                    VALUES ('setting', 'user', 'terminal.theme', '"dark"', 'string', 1,
                            20, 1, 'local-device', 1);
                    INSERT INTO setting
                      (id, scope, key, value_json, value_type, syncable, updated_at,
                       version, origin_device_id, dirty)
                    VALUES ('wallpaper', 'user', 'appearance.wallpaper', '"local.jpg"',
                            'string', 1, 20, 1, 'local-device', 1);
                    "#,
                )
                .map_err(db_error)?;
                Ok(())
            })
            .expect("seed entities");

        let records = collect_dirty_records(&store).expect("collect dirty records");
        let record_types: Vec<_> = records.iter().map(|record| record.record_type).collect();
        assert_eq!(
            record_types,
            vec![
                SyncRecordType::Group,
                SyncRecordType::Secret,
                SyncRecordType::Credential,
                SyncRecordType::SshKey,
                SyncRecordType::Session,
                SyncRecordType::KnownHost,
                SyncRecordType::Snippet,
                SyncRecordType::PortForward,
                SyncRecordType::Setting,
            ]
        );
        assert!(records.iter().all(|record| record.record_id != "wallpaper"));
    }

    #[test]
    fn applies_remote_records_in_one_deferred_foreign_key_transaction() {
        let store = fresh_store();
        let child_group = remote_record(
            SyncRecordType::Group,
            "child",
            1,
            10,
            false,
            GroupPayload {
                parent_id: Some("parent".to_string()),
                name: "Child".to_string(),
                kind: "session".to_string(),
                sort_order: 1,
                color: None,
                icon_key: None,
                notes: None,
                created_at: 10,
            },
        );
        let parent_group = remote_record(
            SyncRecordType::Group,
            "parent",
            1,
            20,
            false,
            GroupPayload {
                parent_id: None,
                name: "Parent".to_string(),
                kind: "session".to_string(),
                sort_order: 0,
                color: None,
                icon_key: None,
                notes: None,
                created_at: 10,
            },
        );
        let secret = remote_record(
            SyncRecordType::Secret,
            "secret",
            1,
            10,
            false,
            SecretPayload {
                record_type: "credential".to_string(),
                ciphertext: vec![1, 2],
                nonce: vec![3],
                aad: vec![4],
                crypto_suite: "xchacha20poly1305".to_string(),
                key_version: 1,
                created_at: 10,
            },
        );
        let credential = remote_record(
            SyncRecordType::Credential,
            "credential",
            1,
            10,
            false,
            CredentialPayload {
                name: "Root".to_string(),
                kind: "password".to_string(),
                username: Some("root".to_string()),
                secret_id: "secret".to_string(),
                hint: None,
                save_policy: "ask".to_string(),
                expires_at: None,
                created_at: 10,
            },
        );
        let session = remote_record(
            SyncRecordType::Session,
            "session",
            1,
            10,
            false,
            SessionPayload {
                group_id: Some("child".to_string()),
                name: "Prod".to_string(),
                protocol: "ssh".to_string(),
                host: Some("prod.invalid".to_string()),
                port: Some(22),
                username: Some("root".to_string()),
                auth_method: "password".to_string(),
                credential_id: Some("credential".to_string()),
                ssh_key_id: None,
                host_key_policy: "strict".to_string(),
                proxy_jump: None,
                proxy_id: None,
                terminal_profile_id: None,
                encoding: "UTF-8".to_string(),
                startup_command: None,
                working_dir: None,
                keepalive_sec: 30,
                keepalive_max_miss: 3,
                auto_reconnect: false,
                reconnect_max: 7,
                compression: false,
                agent_forwarding: false,
                x11_forwarding: false,
                tags: serde_json::json!([]),
                favorite: false,
                color: None,
                icon_key: None,
                notes: None,
                protocol_options: None,
                sort_order: 0,
                created_at: 10,
            },
        );

        let summary = apply_remote_records(
            &store,
            &[session, credential, secret, child_group, parent_group],
        )
        .expect("apply dependency graph");
        assert_eq!(summary.applied, 5);
        assert_eq!(summary.deleted, 0);

        store
            .with_conn(|conn| {
                let row: (String, String, i64, String) = conn
                    .query_row(
                        "SELECT s.group_id, s.credential_id, s.version, s.origin_device_id \
                         FROM session s WHERE s.id = 'session'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(
                    row,
                    (
                        "child".to_string(),
                        "credential".to_string(),
                        1,
                        "remote-device".to_string()
                    )
                );
                let dirty: i64 = conn
                    .query_row(
                        "SELECT dirty FROM session WHERE id = 'session'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                assert_eq!(dirty, 0);
                Ok(())
            })
            .expect("verify applied graph");
    }

    #[test]
    fn tombstone_is_idempotent_and_blocks_older_resurrection() {
        let store = fresh_store();
        let live = remote_record(
            SyncRecordType::Group,
            "group",
            1,
            10,
            false,
            GroupPayload {
                parent_id: None,
                name: "Live".to_string(),
                kind: "session".to_string(),
                sort_order: 0,
                color: None,
                icon_key: None,
                notes: None,
                created_at: 10,
            },
        );
        apply_remote_records(&store, std::slice::from_ref(&live)).expect("apply live record");

        let tombstone = LocalSyncRecord {
            revision: 2,
            updated_at: 20,
            deleted: true,
            payload: Value::Null,
            ..live.clone()
        };
        let summary = apply_remote_records(&store, &[tombstone]).expect("apply tombstone");
        assert_eq!(summary.deleted, 1);

        let stale = LocalSyncRecord {
            updated_at: 30,
            payload: serde_json::to_value(GroupPayload {
                parent_id: None,
                name: "Stale".to_string(),
                kind: "session".to_string(),
                sort_order: 0,
                color: None,
                icon_key: None,
                notes: None,
                created_at: 10,
            })
            .expect("serialize stale payload"),
            ..live
        };
        let stale_summary =
            apply_remote_records(&store, &[stale]).expect("ignore stale resurrection");
        assert_eq!(stale_summary, ApplySummary::default());

        store
            .with_conn(|conn| {
                let state: (String, i64, i64) = conn
                    .query_row(
                        "SELECT name, deleted_at, version FROM session_group WHERE id = 'group'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(state, ("Live".to_string(), 20, 2));
                let sync_state: (i64, i64) = conn
                    .query_row(
                        "SELECT revision, deleted FROM sync_record WHERE record_id = 'group'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(sync_state, (2, 1));
                Ok(())
            })
            .expect("verify tombstone");
    }

    #[test]
    fn marks_applied_records_and_backs_up_remote_tombstone_conflicts() {
        let store = fresh_store();
        store
            .with_conn(|conn| {
                conn.execute_batch(
                    "INSERT INTO session_group \
                     (id, name, kind, created_at, updated_at, version, dirty) \
                     VALUES ('group', 'Local', 'session', 10, 20, 1, 1); \
                     INSERT INTO sync_meta (vault_id) VALUES ('default');",
                )
                .map_err(db_error)?;
                Ok(())
            })
            .expect("seed local record");

        mark_records_applied(
            &store,
            &[AppliedSyncRecord {
                record_id: "group".to_string(),
                record_type: SyncRecordType::Group,
                revision: 3,
                key_version: 2,
                checksum: Some("checksum".to_string()),
                deleted: false,
            }],
        )
        .expect("mark applied");

        let conflict_id = backup_conflict(
            &store,
            ConflictBackupInput {
                record_id: "group".to_string(),
                record_type: SyncRecordType::Group,
                local_snapshot: Some(serde_json::json!({ "name": "Local" })),
                remote_ciphertext_b64: "ciphertext".to_string(),
                remote_checksum: "remote-checksum".to_string(),
                remote_revision: 4,
                remote_device_id: Some("other-device".to_string()),
                remote_deleted: true,
                remote_updated_at: 40,
            },
        )
        .expect("backup conflict");
        assert_eq!(conflict_id.len(), 26);

        store
            .with_conn(|conn| {
                let local: (i64, i64) = conn
                    .query_row(
                        "SELECT dirty, version FROM session_group WHERE id = 'group'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(local, (0, 3));
                let conflict: (i64, i64, String) = conn
                    .query_row(
                        "SELECT remote_deleted, remote_updated_at, remote_device_id \
                         FROM sync_conflict WHERE id = ?1",
                        params![&conflict_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(conflict, (1, 40, "other-device".to_string()));
                let sync_state: (String, i64, i64) = conn
                    .query_row(
                        "SELECT sync_state, revision, deleted FROM sync_record WHERE record_id = 'group'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(db_error)?;
                assert_eq!(sync_state, ("conflict".to_string(), 4, 1));
                let count: i64 = conn
                    .query_row(
                        "SELECT conflict_count FROM sync_meta WHERE vault_id = 'default'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                assert_eq!(count, 1);
                Ok(())
            })
            .expect("verify conflict backup");
    }
}
