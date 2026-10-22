//! 领域实体（字段语义对齐 `spec/data-model.md`）。

use crate::ids::*;
use crate::value_objects::*;
use crate::SyncMeta;
use serde::{Deserialize, Serialize};

/// 保险库元数据（密钥槽见 `openshell-vault`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultRecord {
    pub id: VaultId,
    pub name: String,
    pub schema_version: i64,
    pub crypto_suite: String,
    pub kdf_alg: String,
    pub kdf_mem_kib: i64,
    pub kdf_time: i64,
    pub kdf_parallelism: i64,
    #[serde(skip_serializing)]
    pub kdf_salt: Vec<u8>,
    #[serde(skip_serializing)]
    pub wrapped_vault_key: Vec<u8>,
    #[serde(skip_serializing)]
    pub key_check: Vec<u8>,
    pub keychain_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: Option<i64>,
    pub sync_enabled: bool,
    pub server_url: Option<String>,
    pub account_id: Option<String>,
    pub quota_bytes: Option<i64>,
}

/// 会话分组。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    pub parent_id: Option<GroupId>,
    pub name: String,
    pub kind: GroupKind,
    pub sort_order: i64,
    pub color: Option<String>,
    pub icon_key: Option<String>,
    pub expanded: bool,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub group_id: Option<GroupId>,
    pub name: String,
    pub protocol: Protocol,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub credential_id: Option<CredentialId>,
    pub ssh_key_id: Option<SshKeyId>,
    pub host_key_policy: HostKeyPolicy,
    pub proxy_jump_json: Option<serde_json::Value>,
    pub proxy_id: Option<String>,
    pub terminal_profile_id: Option<String>,
    pub encoding: String,
    pub startup_command: Option<String>,
    pub working_dir: Option<String>,
    pub keepalive_sec: i64,
    pub keepalive_max_miss: i64,
    pub auto_reconnect: bool,
    pub reconnect_max: i64,
    pub compression: bool,
    pub agent_forwarding: bool,
    pub x11_forwarding: bool,
    pub tags_json: Option<serde_json::Value>,
    pub favorite: bool,
    pub color: Option<String>,
    pub icon_key: Option<String>,
    pub notes: Option<String>,
    pub protocol_options_json: Option<serde_json::Value>,
    pub last_used_at: Option<i64>,
    pub last_result: Option<String>,
    pub use_count: i64,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 新建会话输入。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionInput {
    pub group_id: Option<GroupId>,
    pub name: Option<String>,
    pub protocol: Option<Protocol>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: Option<AuthMethod>,
    pub credential_id: Option<CredentialId>,
    pub ssh_key_id: Option<SshKeyId>,
    pub host_key_policy: Option<HostKeyPolicy>,
    pub proxy_jump_json: Option<serde_json::Value>,
    pub terminal_profile_id: Option<String>,
    pub encoding: Option<String>,
    pub startup_command: Option<String>,
    pub working_dir: Option<String>,
    pub keepalive_sec: Option<i64>,
    pub keepalive_max_miss: Option<i64>,
    pub auto_reconnect: Option<bool>,
    pub reconnect_max: Option<i64>,
    pub compression: Option<bool>,
    pub agent_forwarding: Option<bool>,
    pub tags_json: Option<serde_json::Value>,
    pub favorite: Option<bool>,
    pub color: Option<String>,
    pub icon_key: Option<String>,
    pub notes: Option<String>,
    pub protocol_options_json: Option<serde_json::Value>,
    pub sort_order: Option<i64>,
}

/// 会话局部更新；`None` 表示保持原值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionPatch {
    pub group_id: Option<Option<GroupId>>,
    pub name: Option<String>,
    pub protocol: Option<Protocol>,
    pub host: Option<Option<String>>,
    pub port: Option<Option<u16>>,
    pub username: Option<Option<String>>,
    pub auth_method: Option<AuthMethod>,
    pub credential_id: Option<Option<CredentialId>>,
    pub ssh_key_id: Option<Option<SshKeyId>>,
    pub host_key_policy: Option<HostKeyPolicy>,
    pub proxy_jump_json: Option<Option<serde_json::Value>>,
    pub terminal_profile_id: Option<Option<String>>,
    pub encoding: Option<String>,
    pub startup_command: Option<Option<String>>,
    pub working_dir: Option<Option<String>>,
    pub keepalive_sec: Option<i64>,
    pub keepalive_max_miss: Option<i64>,
    pub auto_reconnect: Option<bool>,
    pub reconnect_max: Option<i64>,
    pub compression: Option<bool>,
    pub agent_forwarding: Option<bool>,
    pub tags_json: Option<Option<serde_json::Value>>,
    pub favorite: Option<bool>,
    pub color: Option<Option<String>>,
    pub icon_key: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub protocol_options_json: Option<Option<serde_json::Value>>,
    pub sort_order: Option<i64>,
}

/// 凭据（秘密本体在 `secret` 表，只能经 `SecretResolver` 解密）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub id: CredentialId,
    pub name: String,
    pub kind: CredentialKind,
    pub username: Option<String>,
    pub secret_id: SecretId,
    pub hint: Option<String>,
    pub save_policy: SavePolicy,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// SSH 密钥（私钥在 `secret` 表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshKey {
    pub id: SshKeyId,
    pub name: String,
    pub algorithm: String,
    pub key_size: Option<i64>,
    pub public_key: String,
    pub fingerprint_sha256: String,
    pub secret_id: SecretId,
    pub passphrase_credential_id: Option<CredentialId>,
    pub has_passphrase: bool,
    pub comment: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 已知主机。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub id: KnownHostId,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    pub fingerprint_sha256: String,
    pub status: KnownHostStatus,
    pub previous_fingerprint: Option<String>,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub changed_at: Option<i64>,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 加密秘密载荷行（唯一允许存密文的表）。
#[derive(Debug, Clone)]
pub struct SecretRecord {
    pub id: SecretId,
    pub record_type: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub aad: Vec<u8>,
    pub crypto_suite: String,
    pub key_version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 解密后的凭据秘密。
#[derive(Debug, Clone)]
pub enum SecretMaterial {
    Password(zeroize::Zeroizing<String>),
    PrivateKey {
        pem: zeroize::Zeroizing<Vec<u8>>,
        passphrase: Option<zeroize::Zeroizing<String>>,
    },
    KeyboardInteractive(serde_json::Value),
}

/// 同步用的单条记录封装（服务端只见不透明 ID / 密文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEntityRecord {
    pub record_id: String,
    pub record_type: String,
    pub base_version: i64,
    pub deleted: bool,
    pub encrypted_payload: String,
}

/// 命令片段与宏。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: SnippetId,
    pub group_id: Option<GroupId>,
    pub kind: SnippetKind,
    pub name: String,
    pub body: Option<String>,
    pub variables_json: Option<serde_json::Value>,
    pub macro_steps_json: Option<serde_json::Value>,
    pub send_mode: SendMode,
    pub shortcut: Option<String>,
    pub sort_order: i64,
    pub tags_json: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 新建片段输入。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetInput {
    pub group_id: Option<GroupId>,
    pub kind: Option<SnippetKind>,
    pub name: String,
    pub body: Option<String>,
    pub variables_json: Option<serde_json::Value>,
    pub macro_steps_json: Option<serde_json::Value>,
    pub send_mode: Option<SendMode>,
    pub shortcut: Option<String>,
    pub sort_order: Option<i64>,
    pub tags_json: Option<serde_json::Value>,
}

/// 端口转发规则。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardRule {
    pub id: PortForwardId,
    pub session_id: Option<SessionId>,
    pub name: String,
    pub rule_type: PortForwardType,
    pub bind_host: String,
    pub bind_port: u16,
    pub dest_host: Option<String>,
    pub dest_port: Option<u16>,
    pub auto_start: bool,
    pub auto_reconnect: bool,
    pub reconnect_max: i64,
    pub socks_auth: SocksAuth,
    pub socks_username: Option<String>,
    pub socks_password_ref: Option<String>,
    pub expose_warning_ack: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    #[serde(flatten)]
    pub sync: SyncMeta,
}

/// 新建端口转发规则输入。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PortForwardRuleInput {
    pub session_id: Option<SessionId>,
    pub name: String,
    pub rule_type: Option<PortForwardType>,
    pub bind_host: Option<String>,
    pub bind_port: u16,
    pub dest_host: Option<String>,
    pub dest_port: Option<u16>,
    pub auto_start: Option<bool>,
    pub auto_reconnect: Option<bool>,
    pub reconnect_max: Option<i64>,
    pub socks_auth: Option<SocksAuth>,
    pub socks_username: Option<String>,
    pub socks_password_ref: Option<String>,
    pub expose_warning_ack: Option<bool>,
    pub sort_order: Option<i64>,
}

/// SFTP 文件项。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub file_type: FileEntryType,
    pub permissions: u32,
    pub modified_at: i64,
    pub accessed_at: i64,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

/// 文件传输任务。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferTask {
    pub id: String,
    pub session_id: SessionId,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub speed_bps: u64,
    pub state: TransferState,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 主机监控快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostMetrics {
    pub session_id: SessionId,
    pub timestamp_ms: i64,
    pub cpu_percent: f64,
    pub cpu_cores: Vec<f64>,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_cached_bytes: u64,
    pub load_1: f64,
    pub load_5: f64,
    pub load_15: f64,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub net_rx_total: u64,
    pub net_tx_total: u64,
    pub disk_mounts: Vec<DiskMountMetrics>,
    pub top_processes: Vec<ProcessMetrics>,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskMountMetrics {
    pub mount_point: String,
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub use_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessMetrics {
    pub pid: u32,
    pub user: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub name: String,
    pub command: String,
}
