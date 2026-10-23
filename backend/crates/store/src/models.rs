//! 行映射、通用 SQL 辅助与错误转换。

use openshell_core_domain::{
    now_ms, AuthMethod, Credential, CredentialKind, DomainError, DomainResult, ErrorCode, Group,
    GroupKind, HostKeyPolicy, KnownHost, KnownHostStatus, PortForwardRule, PortForwardType,
    Protocol, SavePolicy, SecretRecord, SendMode, Session, Snippet, SnippetKind, SocksAuth, SshKey,
    SyncMeta, VaultRecord,
};
use rusqlite::types::Type;
use rusqlite::{Error as SqlError, ErrorCode as SqlErrorCode, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;

/// 把 rusqlite 错误转换为领域错误；不把 SQL 文本透出给上层。
pub(crate) fn map_sql_error(e: SqlError) -> DomainError {
    match e {
        SqlError::QueryReturnedNoRows => DomainError::not_found("record not found"),
        SqlError::SqliteFailure(err, _) => match err.code {
            SqlErrorCode::ConstraintViolation => {
                if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY {
                    DomainError::conflict("referenced record does not exist")
                } else {
                    DomainError::conflict("record conflicts with an existing record")
                }
            }
            SqlErrorCode::DatabaseBusy | SqlErrorCode::DatabaseLocked => {
                DomainError::new(ErrorCode::Io, "database is busy").with_retryable(true)
            }
            SqlErrorCode::CannotOpen
            | SqlErrorCode::SystemIoFailure
            | SqlErrorCode::DiskFull
            | SqlErrorCode::ReadOnly => {
                DomainError::new(ErrorCode::Io, "database is not accessible")
            }
            SqlErrorCode::NotFound => DomainError::not_found("record not found"),
            _ => DomainError::internal("database error"),
        },
        _ => DomainError::internal("database error"),
    }
}

/// 校验 ULID 文本；各仓储写入前调用。
pub(crate) fn ensure_id<T: FromStr<Err = DomainError>>(s: &str) -> DomainResult<()> {
    s.parse::<T>()
        .map(|_| ())
        .map_err(|_| DomainError::validation("invalid id"))
}

fn bad_value(col: usize, what: &'static str) -> SqlError {
    SqlError::FromSqlConversionFailure(
        col,
        Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, what)),
    )
}

fn parse_id<T: FromStr<Err = DomainError>>(s: String, col: usize) -> rusqlite::Result<T> {
    s.parse::<T>().map_err(|_| bad_value(col, "invalid id"))
}

fn parse_opt_id<T: FromStr<Err = DomainError>>(
    s: Option<String>,
    col: usize,
) -> rusqlite::Result<Option<T>> {
    match s {
        Some(v) => Ok(Some(parse_id(v, col)?)),
        None => Ok(None),
    }
}

fn parse_protocol(s: String) -> rusqlite::Result<Protocol> {
    match s.as_str() {
        "ssh" => Ok(Protocol::Ssh),
        "sftp" => Ok(Protocol::Sftp),
        "telnet" => Ok(Protocol::Telnet),
        "serial" => Ok(Protocol::Serial),
        "local_shell" => Ok(Protocol::LocalShell),
        _ => Err(bad_value(3, "invalid protocol")),
    }
}

fn parse_auth_method(s: String) -> rusqlite::Result<AuthMethod> {
    match s.as_str() {
        "password" => Ok(AuthMethod::Password),
        "publickey" | "public_key" => Ok(AuthMethod::PublicKey),
        "keyboard_interactive" => Ok(AuthMethod::KeyboardInteractive),
        "agent" => Ok(AuthMethod::Agent),
        "none" => Ok(AuthMethod::None),
        _ => Err(bad_value(7, "invalid auth method")),
    }
}

fn parse_host_key_policy(s: String) -> rusqlite::Result<HostKeyPolicy> {
    match s.as_str() {
        "strict" => Ok(HostKeyPolicy::Strict),
        "accept_new" => Ok(HostKeyPolicy::AcceptNew),
        "insecure" => Ok(HostKeyPolicy::Insecure),
        _ => Err(bad_value(10, "invalid host key policy")),
    }
}

fn parse_group_kind(s: String) -> rusqlite::Result<GroupKind> {
    match s.as_str() {
        "session" => Ok(GroupKind::Session),
        "snippet" => Ok(GroupKind::Snippet),
        _ => Err(bad_value(3, "invalid group kind")),
    }
}

fn parse_credential_kind(s: String) -> rusqlite::Result<CredentialKind> {
    match s.as_str() {
        "password" => Ok(CredentialKind::Password),
        "keyboard_interactive" => Ok(CredentialKind::KeyboardInteractive),
        "passphrase" => Ok(CredentialKind::Passphrase),
        _ => Err(bad_value(2, "invalid credential kind")),
    }
}

fn parse_save_policy(s: String) -> rusqlite::Result<SavePolicy> {
    match s.as_str() {
        "always" => Ok(SavePolicy::Always),
        "ask" => Ok(SavePolicy::Ask),
        "never" => Ok(SavePolicy::Never),
        _ => Err(bad_value(6, "invalid save policy")),
    }
}

fn parse_known_host_status(s: String) -> rusqlite::Result<KnownHostStatus> {
    match s.as_str() {
        "trusted" => Ok(KnownHostStatus::Trusted),
        "changed" => Ok(KnownHostStatus::Changed),
        "revoked" => Ok(KnownHostStatus::Revoked),
        _ => Err(bad_value(6, "invalid known host status")),
    }
}

/// 主机密钥策略的存储值（core-domain 未提供 `as_str`）。
pub(crate) fn host_key_policy_str(v: HostKeyPolicy) -> &'static str {
    match v {
        HostKeyPolicy::Strict => "strict",
        HostKeyPolicy::AcceptNew => "accept_new",
        HostKeyPolicy::Insecure => "insecure",
    }
}

/// 保存策略的存储值。
pub(crate) fn save_policy_str(v: SavePolicy) -> &'static str {
    match v {
        SavePolicy::Always => "always",
        SavePolicy::Ask => "ask",
        SavePolicy::Never => "never",
    }
}

fn opt_u16(row: &Row<'_>, idx: usize) -> rusqlite::Result<Option<u16>> {
    let raw: Option<i64> = row.get(idx)?;
    match raw {
        None => Ok(None),
        Some(v) => u16::try_from(v)
            .map(Some)
            .map_err(|_| bad_value(idx, "integer out of range")),
    }
}

fn req_u16(row: &Row<'_>, idx: usize) -> rusqlite::Result<u16> {
    let raw: i64 = row.get(idx)?;
    u16::try_from(raw).map_err(|_| bad_value(idx, "integer out of range"))
}

fn sync_meta(row: &Row<'_>, base: usize) -> rusqlite::Result<SyncMeta> {
    Ok(SyncMeta {
        version: row.get(base)?,
        origin_device_id: row.get(base + 1)?,
        dirty: row.get::<_, i64>(base + 2)? != 0,
    })
}

pub(crate) const SESSION_COLUMNS: &str = "id, group_id, name, protocol, host, port, username, \
    auth_method, credential_id, ssh_key_id, host_key_policy, proxy_jump_json, proxy_id, \
    terminal_profile_id, encoding, startup_command, working_dir, keepalive_sec, \
    keepalive_max_miss, auto_reconnect, reconnect_max, compression, agent_forwarding, \
    x11_forwarding, tags_json, favorite, color, icon_key, notes, protocol_options_json, \
    last_used_at, last_result, use_count, sort_order, created_at, updated_at, deleted_at, \
    version, origin_device_id, dirty";

/// 请求级会话行（列顺序见 `SESSION_COLUMNS`）。
pub(crate) fn session_from_row(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: parse_id(row.get(0)?, 0)?,
        group_id: parse_opt_id(row.get(1)?, 1)?,
        name: row.get(2)?,
        protocol: parse_protocol(row.get(3)?)?,
        host: row.get(4)?,
        port: opt_u16(row, 5)?,
        username: row.get(6)?,
        auth_method: parse_auth_method(row.get(7)?)?,
        credential_id: parse_opt_id(row.get(8)?, 8)?,
        ssh_key_id: parse_opt_id(row.get(9)?, 9)?,
        host_key_policy: parse_host_key_policy(row.get(10)?)?,
        proxy_jump_json: row.get(11)?,
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
        tags_json: Some(row.get(24)?),
        favorite: row.get::<_, i64>(25)? != 0,
        color: row.get(26)?,
        icon_key: row.get(27)?,
        notes: row.get(28)?,
        protocol_options_json: row.get(29)?,
        last_used_at: row.get(30)?,
        last_result: row.get(31)?,
        use_count: row.get(32)?,
        sort_order: row.get(33)?,
        created_at: row.get(34)?,
        updated_at: row.get(35)?,
        deleted_at: row.get(36)?,
        sync: sync_meta(row, 37)?,
    })
}

pub(crate) const GROUP_COLUMNS: &str = "id, parent_id, name, kind, sort_order, color, icon_key, \
    expanded, notes, created_at, updated_at, deleted_at, version, origin_device_id, dirty";

pub(crate) fn group_from_row(row: &Row<'_>) -> rusqlite::Result<Group> {
    Ok(Group {
        id: parse_id(row.get(0)?, 0)?,
        parent_id: parse_opt_id(row.get(1)?, 1)?,
        name: row.get(2)?,
        kind: parse_group_kind(row.get(3)?)?,
        sort_order: row.get(4)?,
        color: row.get(5)?,
        icon_key: row.get(6)?,
        expanded: row.get::<_, i64>(7)? != 0,
        notes: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        deleted_at: row.get(11)?,
        sync: sync_meta(row, 12)?,
    })
}

pub(crate) const CREDENTIAL_COLUMNS: &str = "id, name, kind, username, secret_id, hint, \
    save_policy, expires_at, created_at, updated_at, deleted_at, version, origin_device_id, dirty";

pub(crate) fn credential_from_row(row: &Row<'_>) -> rusqlite::Result<Credential> {
    Ok(Credential {
        id: parse_id(row.get(0)?, 0)?,
        name: row.get(1)?,
        kind: parse_credential_kind(row.get(2)?)?,
        username: row.get(3)?,
        secret_id: parse_id(row.get(4)?, 4)?,
        hint: row.get(5)?,
        save_policy: parse_save_policy(row.get(6)?)?,
        expires_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        deleted_at: row.get(10)?,
        sync: sync_meta(row, 11)?,
    })
}

pub(crate) const SSH_KEY_COLUMNS: &str = "id, name, algorithm, key_size, public_key, \
    fingerprint_sha256, secret_id, passphrase_credential_id, has_passphrase, comment, \
    created_at, updated_at, deleted_at, version, origin_device_id, dirty";

pub(crate) fn ssh_key_from_row(row: &Row<'_>) -> rusqlite::Result<SshKey> {
    Ok(SshKey {
        id: parse_id(row.get(0)?, 0)?,
        name: row.get(1)?,
        algorithm: row.get(2)?,
        key_size: row.get(3)?,
        public_key: row.get(4)?,
        fingerprint_sha256: row.get(5)?,
        secret_id: parse_id(row.get(6)?, 6)?,
        passphrase_credential_id: parse_opt_id(row.get(7)?, 7)?,
        has_passphrase: row.get::<_, i64>(8)? != 0,
        comment: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        deleted_at: row.get(12)?,
        sync: sync_meta(row, 13)?,
    })
}

pub(crate) const KNOWN_HOST_COLUMNS: &str = "id, host, port, key_type, public_key, \
    fingerprint_sha256, status, previous_fingerprint, first_seen_at, last_seen_at, changed_at, \
    source, created_at, updated_at, deleted_at, version, origin_device_id, dirty";

pub(crate) fn known_host_from_row(row: &Row<'_>) -> rusqlite::Result<KnownHost> {
    Ok(KnownHost {
        id: parse_id(row.get(0)?, 0)?,
        host: row.get(1)?,
        port: req_u16(row, 2)?,
        key_type: row.get(3)?,
        public_key: row.get(4)?,
        fingerprint_sha256: row.get(5)?,
        status: parse_known_host_status(row.get(6)?)?,
        previous_fingerprint: row.get(7)?,
        first_seen_at: row.get(8)?,
        last_seen_at: row.get(9)?,
        changed_at: row.get(10)?,
        source: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        deleted_at: row.get(14)?,
        sync: sync_meta(row, 15)?,
    })
}

pub(crate) const SECRET_COLUMNS: &str = "id, record_type, ciphertext, nonce, aad, crypto_suite, \
    key_version, created_at, updated_at";

pub(crate) fn secret_from_row(row: &Row<'_>) -> rusqlite::Result<SecretRecord> {
    Ok(SecretRecord {
        id: parse_id(row.get(0)?, 0)?,
        record_type: row.get(1)?,
        ciphertext: row.get(2)?,
        nonce: row.get(3)?,
        aad: row.get(4)?,
        crypto_suite: row.get(5)?,
        key_version: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub(crate) const VAULT_COLUMNS: &str = "id, name, schema_version, crypto_suite, kdf_alg, \
    kdf_mem_kib, kdf_time, kdf_parallelism, kdf_salt, wrapped_vault_key, key_check, keychain_ref, \
    created_at, updated_at, last_opened_at, sync_enabled, server_url, account_id, quota_bytes";

pub(crate) fn vault_from_row(row: &Row<'_>) -> rusqlite::Result<VaultRecord> {
    Ok(VaultRecord {
        id: parse_id(row.get(0)?, 0)?,
        name: row.get(1)?,
        schema_version: row.get(2)?,
        crypto_suite: row.get(3)?,
        kdf_alg: row.get(4)?,
        kdf_mem_kib: row.get(5)?,
        kdf_time: row.get(6)?,
        kdf_parallelism: row.get(7)?,
        kdf_salt: row.get(8)?,
        wrapped_vault_key: row.get(9)?,
        key_check: row.get(10)?,
        keychain_ref: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        last_opened_at: row.get(14)?,
        sync_enabled: row.get::<_, i64>(15)? != 0,
        server_url: row.get(16)?,
        account_id: row.get(17)?,
        quota_bytes: row.get(18)?,
    })
}

/// 设置行（core-domain 未定义对应实体）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingRecord {
    pub id: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub key: String,
    pub value_json: Value,
    pub value_type: String,
    pub syncable: bool,
    pub updated_at: i64,
    pub version: i64,
    pub origin_device_id: Option<String>,
    pub dirty: bool,
}

pub(crate) const SETTING_COLUMNS: &str = "id, scope, scope_id, key, value_json, value_type, \
    syncable, updated_at, version, origin_device_id, dirty";

pub(crate) fn setting_from_row(row: &Row<'_>) -> rusqlite::Result<SettingRecord> {
    Ok(SettingRecord {
        id: row.get(0)?,
        scope: row.get(1)?,
        scope_id: row.get(2)?,
        key: row.get(3)?,
        value_json: row.get(4)?,
        value_type: row.get(5)?,
        syncable: row.get::<_, i64>(6)? != 0,
        updated_at: row.get(7)?,
        version: row.get(8)?,
        origin_device_id: row.get(9)?,
        dirty: row.get::<_, i64>(10)? != 0,
    })
}

/// JSON 值的类型标签，写入 `setting.value_type`。
pub(crate) fn json_value_type(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        _ => "json",
    }
}

/// 在事务内递增 `sync_record.local_rev` 并标记为 dirty。
///
/// `expected` 为 `Some` 时使用条件更新；受影响行数为 0 表示版本冲突。
pub(crate) fn bump_sync(
    tx: &Transaction<'_>,
    record_id: &str,
    record_type: &str,
    expected_local_rev: Option<i64>,
) -> DomainResult<()> {
    let now = now_ms();
    tx.execute(
        "INSERT INTO sync_record(record_id, record_type, base_version, local_rev, sync_state, updated_at) \
         VALUES(?1, ?2, 0, 0, 'clean', ?3) ON CONFLICT(record_id) DO NOTHING",
        rusqlite::params![record_id, record_type, now],
    )
    .map_err(map_sql_error)?;

    let affected = match expected_local_rev {
        Some(expected) => tx.execute(
            "UPDATE sync_record SET local_rev = local_rev + 1, sync_state = 'dirty', updated_at = ?1 \
             WHERE record_id = ?2 AND local_rev = ?3",
            rusqlite::params![now, record_id, expected],
        ),
        None => tx.execute(
            "UPDATE sync_record SET local_rev = local_rev + 1, sync_state = 'dirty', updated_at = ?1 \
             WHERE record_id = ?2",
            rusqlite::params![now, record_id],
        ),
    }
    .map_err(map_sql_error)?;

    if affected == 0 {
        return Err(DomainError::conflict(
            "record was modified by another operation",
        ));
    }
    Ok(())
}

/// 软删除时把同步状态置为 `deleted`。
pub(crate) fn mark_sync_deleted(
    tx: &Transaction<'_>,
    record_id: &str,
    record_type: &str,
) -> DomainResult<()> {
    let now = now_ms();
    tx.execute(
        "INSERT INTO sync_record(record_id, record_type, base_version, local_rev, sync_state, updated_at) \
         VALUES(?1, ?2, 0, 0, 'clean', ?3) ON CONFLICT(record_id) DO NOTHING",
        rusqlite::params![record_id, record_type, now],
    )
    .map_err(map_sql_error)?;
    tx.execute(
        "UPDATE sync_record SET local_rev = local_rev + 1, sync_state = 'deleted', updated_at = ?1 \
         WHERE record_id = ?2",
        rusqlite::params![now, record_id],
    )
    .map_err(map_sql_error)?;
    Ok(())
}

/// 校验字符串 ID 列表中的每个 ULID。
#[allow(dead_code)]
pub(crate) fn ensure_ids<T: FromStr<Err = DomainError>>(ids: &[String]) -> DomainResult<()> {
    for id in ids {
        ensure_id::<T>(id)?;
    }
    Ok(())
}

pub(crate) const SNIPPET_COLUMNS: &str = "id, group_id, kind, name, body, variables_json, \
    macro_steps_json, send_mode, shortcut, sort_order, tags_json, created_at, updated_at, \
    deleted_at, version, origin_device_id, dirty";

pub(crate) fn snippet_from_row(row: &Row<'_>) -> rusqlite::Result<Snippet> {
    let kind_str: String = row.get(2)?;
    let send_mode_str: String = row.get(7)?;
    let kind = match kind_str.as_str() {
        "macro" => SnippetKind::Macro,
        _ => SnippetKind::Snippet,
    };
    let send_mode = match send_mode_str.as_str() {
        "execute" => SendMode::Execute,
        _ => SendMode::Insert,
    };

    Ok(Snippet {
        id: parse_id(row.get(0)?, 0)?,
        group_id: parse_opt_id(row.get(1)?, 1)?,
        kind,
        name: row.get(3)?,
        body: row.get(4)?,
        variables_json: row.get(5)?,
        macro_steps_json: row.get(6)?,
        send_mode,
        shortcut: row.get(8)?,
        sort_order: row.get(9)?,
        tags_json: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        deleted_at: row.get(13)?,
        sync: sync_meta(row, 14)?,
    })
}

pub(crate) const PORT_FORWARD_COLUMNS: &str = "id, session_id, name, type, bind_host, \
    bind_port, dest_host, dest_port, auto_start, auto_reconnect, reconnect_max, socks_auth, \
    socks_username, socks_password_ref, expose_warning_ack, sort_order, created_at, updated_at, \
    deleted_at, version, origin_device_id, dirty";

pub(crate) fn port_forward_from_row(row: &Row<'_>) -> rusqlite::Result<PortForwardRule> {
    let type_str: String = row.get(3)?;
    let socks_auth_str: String = row.get(11)?;

    let rule_type = match type_str.as_str() {
        "remote" => PortForwardType::Remote,
        "dynamic" => PortForwardType::Dynamic,
        _ => PortForwardType::Local,
    };
    let socks_auth = match socks_auth_str.as_str() {
        "userpass" => SocksAuth::Userpass,
        _ => SocksAuth::None,
    };

    Ok(PortForwardRule {
        id: parse_id(row.get(0)?, 0)?,
        session_id: parse_opt_id(row.get(1)?, 1)?,
        name: row.get(2)?,
        rule_type,
        bind_host: row.get(4)?,
        bind_port: req_u16(row, 5)?,
        dest_host: row.get(6)?,
        dest_port: opt_u16(row, 7)?,
        auto_start: row.get::<_, i64>(8)? != 0,
        auto_reconnect: row.get::<_, i64>(9)? != 0,
        reconnect_max: row.get(10)?,
        socks_auth,
        socks_username: row.get(12)?,
        socks_password_ref: row.get(13)?,
        expose_warning_ack: row.get::<_, i64>(14)? != 0,
        sort_order: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        deleted_at: row.get(18)?,
        sync: sync_meta(row, 19)?,
    })
}
