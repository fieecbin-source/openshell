//! 值对象与枚举（线值与 `spec/data-model.md` 一致）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Ssh,
    Sftp,
    Telnet,
    Serial,
    LocalShell,
    Rdp,
}

impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::Ssh => "ssh",
            Protocol::Sftp => "sftp",
            Protocol::Telnet => "telnet",
            Protocol::Serial => "serial",
            Protocol::LocalShell => "local_shell",
            Protocol::Rdp => "rdp",
        }
    }

    pub fn default_port(&self) -> Option<u16> {
        match self {
            Protocol::Ssh => Some(22),
            Protocol::Sftp => Some(22),
            Protocol::Telnet => Some(23),
            Protocol::Rdp => Some(3389),
            Protocol::Serial | Protocol::LocalShell => None,
        }
    }

    pub fn requires_host(&self) -> bool {
        matches!(
            self,
            Protocol::Ssh | Protocol::Sftp | Protocol::Telnet | Protocol::Rdp
        )
    }
}

impl std::str::FromStr for Protocol {
    type Err = crate::DomainError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ssh" => Ok(Protocol::Ssh),
            "sftp" => Ok(Protocol::Sftp),
            "telnet" => Ok(Protocol::Telnet),
            "serial" => Ok(Protocol::Serial),
            "local_shell" => Ok(Protocol::LocalShell),
            "rdp" | "mstsc" | "windows" => Ok(Protocol::Rdp),
            other => Err(crate::DomainError::validation(format!(
                "unknown protocol: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    #[serde(alias = "publickey")]
    PublicKey,
    KeyboardInteractive,
    Agent,
    None,
}

impl AuthMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::PublicKey => "publickey",
            AuthMethod::KeyboardInteractive => "keyboard_interactive",
            AuthMethod::Agent => "agent",
            AuthMethod::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyPolicy {
    Strict,
    AcceptNew,
    Insecure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

impl TermSize {
    pub const DEFAULT: TermSize = TermSize { cols: 80, rows: 24 };

    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }
}

impl Default for TermSize {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// 分组类型：会话分组 / 片段分组。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    Session,
    Snippet,
}

impl GroupKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            GroupKind::Session => "session",
            GroupKind::Snippet => "snippet",
        }
    }
}

/// 凭据类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Password,
    KeyboardInteractive,
    Passphrase,
}

impl CredentialKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialKind::Password => "password",
            CredentialKind::KeyboardInteractive => "keyboard_interactive",
            CredentialKind::Passphrase => "passphrase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SavePolicy {
    Always,
    Ask,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownHostStatus {
    Trusted,
    Changed,
    Revoked,
}

impl KnownHostStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            KnownHostStatus::Trusted => "trusted",
            KnownHostStatus::Changed => "changed",
            KnownHostStatus::Revoked => "revoked",
        }
    }
}

/// 连接阶段状态（对齐 SESS-009）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPhase {
    Idle,
    Resolving,
    Tcp,
    Handshake,
    Auth,
    Ready,
    Degraded,
    Closed,
}

impl ConnectionPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionPhase::Idle => "idle",
            ConnectionPhase::Resolving => "resolving",
            ConnectionPhase::Tcp => "tcp",
            ConnectionPhase::Handshake => "handshake",
            ConnectionPhase::Auth => "auth",
            ConnectionPhase::Ready => "ready",
            ConnectionPhase::Degraded => "degraded",
            ConnectionPhase::Closed => "closed",
        }
    }
}

/// 片段与宏类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnippetKind {
    Snippet,
    Macro,
}

impl SnippetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SnippetKind::Snippet => "snippet",
            SnippetKind::Macro => "macro",
        }
    }
}

/// 发送模式（插入或回车执行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    Insert,
    Execute,
}

impl SendMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SendMode::Insert => "insert",
            SendMode::Execute => "execute",
        }
    }
}

/// 端口转发类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortForwardType {
    Local,
    Remote,
    Dynamic,
}

impl PortForwardType {
    pub fn as_str(&self) -> &'static str {
        match self {
            PortForwardType::Local => "local",
            PortForwardType::Remote => "remote",
            PortForwardType::Dynamic => "dynamic",
        }
    }
}

/// SOCKS5 认证方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocksAuth {
    None,
    Userpass,
}

impl SocksAuth {
    pub fn as_str(&self) -> &'static str {
        match self {
            SocksAuth::None => "none",
            SocksAuth::Userpass => "userpass",
        }
    }
}

/// 传输方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

/// 传输状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

/// SFTP 文件项类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryType {
    Regular,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyType {
    Http,
    Socks4,
    Socks5,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyServerConfig {
    pub id: String,
    pub name: String,
    pub proxy_type: ProxyType,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub message: String,
}

#[cfg(test)]
mod task1_tests {
    use super::*;

    #[test]
    fn rdp_wire_value_and_aliases() {
        for alias in ["rdp", "mstsc", "windows"] {
            let protocol: Protocol = alias.parse().unwrap();
            assert_eq!(protocol, Protocol::Rdp);
            assert_eq!(protocol.default_port(), Some(3389));
            assert!(protocol.requires_host());
            assert_eq!(protocol.as_str(), "rdp");
        }
        assert_eq!(serde_json::to_string(&Protocol::Rdp).unwrap(), "\"rdp\"");
        assert_eq!(
            serde_json::from_str::<Protocol>("\"rdp\"").unwrap(),
            Protocol::Rdp
        );
    }
}
