//! 统一错误码（IPC 线值 `SCREAMING_SNAKE`）与领域错误。

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // 通用
    Cancelled,
    Timeout,
    Io,
    NotFound,
    Validation,
    Conflict,
    Unsupported,
    Permission,
    Internal,
    QuotaExceeded,
    // 网络 / SSH
    Network,
    Dns,
    HostUnreachable,
    AuthFailed,
    AuthMethodUnsupported,
    HostkeyUnknown,
    HostkeyMismatch,
    SshProtocol,
    ChannelLimit,
    ProxyConnectFailed,
    // 保险库
    VaultUninitialized,
    VaultLocked,
    VaultDecryptFailed,
    VaultCorrupt,
    KeychainUnavailable,
    RateLimited,
    // 文件
    SftpProtocol,
    SftpNoSuchFile,
    SftpPermission,
    // 转发
    ForwardBind,
    ForwardRemoteDenied,
    // 服务端 / 同步
    ServerUnreachable,
    ServerAuth,
    SyncConflict,
    DeviceRevoked,
    DeviceMismatch,
    RegistrationClosed,
    // 更新
    UpdateSignature,
    UpdateDownload,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        use ErrorCode::*;
        match self {
            Cancelled => "CANCELLED",
            Timeout => "TIMEOUT",
            Io => "IO",
            NotFound => "NOT_FOUND",
            Validation => "VALIDATION",
            Conflict => "CONFLICT",
            Unsupported => "UNSUPPORTED",
            Permission => "PERMISSION",
            Internal => "INTERNAL",
            QuotaExceeded => "QUOTA_EXCEEDED",
            Network => "NETWORK",
            Dns => "DNS",
            HostUnreachable => "HOST_UNREACHABLE",
            AuthFailed => "AUTH_FAILED",
            AuthMethodUnsupported => "AUTH_METHOD_UNSUPPORTED",
            HostkeyUnknown => "HOSTKEY_UNKNOWN",
            HostkeyMismatch => "HOSTKEY_MISMATCH",
            SshProtocol => "SSH_PROTOCOL",
            ChannelLimit => "CHANNEL_LIMIT",
            ProxyConnectFailed => "PROXY_CONNECT_FAILED",
            VaultUninitialized => "VAULT_UNINITIALIZED",
            VaultLocked => "VAULT_LOCKED",
            VaultDecryptFailed => "VAULT_DECRYPT_FAILED",
            VaultCorrupt => "VAULT_CORRUPT",
            KeychainUnavailable => "KEYCHAIN_UNAVAILABLE",
            RateLimited => "RATE_LIMITED",
            SftpProtocol => "SFTP_PROTOCOL",
            SftpNoSuchFile => "SFTP_NO_SUCH_FILE",
            SftpPermission => "SFTP_PERMISSION",
            ForwardBind => "FORWARD_BIND",
            ForwardRemoteDenied => "FORWARD_REMOTE_DENIED",
            ServerUnreachable => "SERVER_UNREACHABLE",
            ServerAuth => "SERVER_AUTH",
            SyncConflict => "SYNC_CONFLICT",
            DeviceRevoked => "DEVICE_REVOKED",
            DeviceMismatch => "DEVICE_MISMATCH",
            RegistrationClosed => "REGISTRATION_CLOSED",
            UpdateSignature => "UPDATE_SIGNATURE",
            UpdateDownload => "UPDATE_DOWNLOAD",
        }
    }

    pub fn default_retryable(&self) -> bool {
        use ErrorCode::*;
        matches!(
            self,
            Network | Timeout | Dns | ServerUnreachable | RateLimited | ForwardBind
        )
    }
}

/// 领域错误。`message` 必须是可展示、已脱敏的文本。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl DomainError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: code.default_retryable(),
            details: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Validation, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn vault_locked() -> Self {
        Self::new(ErrorCode::VaultLocked, "vault is locked")
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for DomainError {}

impl From<std::io::Error> for DomainError {
    fn from(e: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, e.to_string())
    }
}

pub type DomainResult<T> = Result<T, DomainError>;
