//! 更新模块的错误类型。
//!
//! 设计原则：
//! * 错误分「可重试」与「不可重试」，调用方（源链、前台重试按钮）据此决策；
//! * 面向用户的 `message` 必须可展示且已脱敏（不含 token / 完整 URL query / 本机路径）；
//! * 通过 `From<UpdaterError> for DomainError` 映射到统一 IPC 错误码，前端只需认 `code`。

use openshell_core_domain::{DomainError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::fmt;

/// 更新失败的分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdaterErrorKind {
    /// 网络不可达 / DNS 失败 / 连接被重置。
    Network,
    /// 请求超时（含重试后仍超时）。
    Timeout,
    /// 触发 GitHub 限流（403/429）。
    RateLimited,
    /// 非 2xx 且不属于上面的 HTTP 错误。
    Http,
    /// 远端资源不存在（404）。
    NotFound,
    /// 远端返回了无法解析的内容（HTML 错误页、字段缺失、JSON 畸形）。
    InvalidPayload,
    /// 当前平台/架构没有匹配的安装包。
    AssetNotFound,
    /// sha256 校验失败（内容与清单不符）。
    ChecksumMismatch,
    /// 清单未提供 sha256，或提供的值不是 64 位十六进制（无法校验，拒绝安装）。
    ChecksumMissing,
    /// 磁盘空间不足。
    InsufficientDisk,
    /// 安装器启动失败。
    Install,
    /// 用户取消。
    Cancelled,
    /// 本地读写失败。
    Io,
    /// 该数据源尚未配置或不受支持（如占位的服务端源）。
    NotConfigured,
    /// 其他内部错误。
    Internal,
}

impl UpdaterErrorKind {
    /// 是否值得重试（回退到下一个源，或让用户点「重试」）。
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::Network | Self::Timeout | Self::RateLimited | Self::Http | Self::Io
        )
    }
}

/// 更新错误。所有字段都可序列化，便于前端精确渲染与日志记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdaterError {
    pub kind: UpdaterErrorKind,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// 服务端 `Retry-After` 换算出的等待毫秒数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
    /// GitHub 限流窗口重置时间（Unix 毫秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl UpdaterError {
    pub fn new(kind: UpdaterErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable: kind.is_retryable(),
            status: None,
            retry_after_ms: None,
            reset_at_ms: None,
            details: None,
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::Network, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::Timeout, message)
    }

    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::InvalidPayload, message)
    }

    pub fn asset_not_found(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::AssetNotFound, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::Io, message)
    }

    pub fn not_configured(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::NotConfigured, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(UpdaterErrorKind::Internal, message)
    }

    pub fn cancelled() -> Self {
        Self::new(UpdaterErrorKind::Cancelled, "operation cancelled by user")
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_retry_after_ms(mut self, ms: i64) -> Self {
        self.retry_after_ms = Some(ms);
        self
    }

    pub fn with_reset_at_ms(mut self, ms: i64) -> Self {
        self.reset_at_ms = Some(ms);
        self
    }

    /// 覆盖「是否可重试」的默认判定（例如 5xx 一定可重试）。
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl fmt::Display for UpdaterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for UpdaterError {}

impl From<std::io::Error> for UpdaterError {
    fn from(err: std::io::Error) -> Self {
        Self::io(err.to_string())
    }
}

impl From<UpdaterError> for DomainError {
    fn from(err: UpdaterError) -> Self {
        let code = match err.kind {
            UpdaterErrorKind::Network | UpdaterErrorKind::Timeout | UpdaterErrorKind::Http => {
                ErrorCode::UpdateCheckFailed
            }
            UpdaterErrorKind::RateLimited => ErrorCode::RateLimited,
            UpdaterErrorKind::NotFound => ErrorCode::NotFound,
            UpdaterErrorKind::InvalidPayload => ErrorCode::UpdateCheckFailed,
            UpdaterErrorKind::AssetNotFound => ErrorCode::UpdateAssetNotFound,
            UpdaterErrorKind::ChecksumMismatch => ErrorCode::UpdateChecksumMismatch,
            UpdaterErrorKind::ChecksumMissing => ErrorCode::UpdateChecksumMissing,
            UpdaterErrorKind::InsufficientDisk => ErrorCode::UpdateInsufficientDisk,
            UpdaterErrorKind::Install => ErrorCode::UpdateInstallFailed,
            UpdaterErrorKind::Cancelled => ErrorCode::Cancelled,
            UpdaterErrorKind::Io => ErrorCode::Io,
            UpdaterErrorKind::NotConfigured | UpdaterErrorKind::Internal => ErrorCode::Unsupported,
        };
        DomainError::new(code, err.message)
            .with_retryable(err.retryable)
            .with_details(serde_json::json!({
                "updater_kind": err.kind,
                "status": err.status,
                "retry_after_ms": err.retry_after_ms,
                "reset_at_ms": err.reset_at_ms,
            }))
    }
}
