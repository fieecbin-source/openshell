use serde::{Deserialize, Serialize};

/// 标准 API 错误码枚举（严格遵照 spec/sync-api.md §1.4）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApiErrorCode {
    InvalidRequest,
    Unauthenticated,
    TokenExpired,
    TokenRevoked,
    Forbidden,
    DeviceRevoked,
    DeviceMismatch,
    DeviceNameConflict,
    RegistrationClosed,
    RelayDisabled,
    DestinationNotAllowed,
    NotFound,
    MethodNotAllowed,
    SyncConflict,
    AccountExists,
    VaultExists,
    IdempotencyKeyReused,
    SnapshotExists,
    PreconditionFailed,
    PayloadTooLarge,
    ValidationFailed,
    UpgradeRequired,
    RateLimited,
    QuotaExceeded,
    VersionConflict,
    Internal,
    Unavailable,
    UpstreamTimeout,
}

impl ApiErrorCode {
    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidRequest => 400,
            Self::Unauthenticated | Self::TokenExpired | Self::TokenRevoked => 401,
            Self::Forbidden
            | Self::DeviceRevoked
            | Self::DeviceMismatch
            | Self::RegistrationClosed
            | Self::RelayDisabled
            | Self::DestinationNotAllowed => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::SyncConflict
            | Self::AccountExists
            | Self::VaultExists
            | Self::DeviceNameConflict
            | Self::IdempotencyKeyReused
            | Self::SnapshotExists
            | Self::VersionConflict => 409,
            Self::PreconditionFailed => 412,
            Self::PayloadTooLarge => 413,
            Self::ValidationFailed => 422,
            Self::UpgradeRequired => 426,
            Self::RateLimited | Self::QuotaExceeded => 429,
            Self::Internal => 500,
            Self::Unavailable => 503,
            Self::UpstreamTimeout => 504,
        }
    }
}

/// 标准统一错误响应体（spec/sync-api.md §1.3）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorDetail {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl ApiErrorEnvelope {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            error: ApiErrorDetail {
                code,
                message: message.into(),
                details: None,
                request_id: None,
                retry_after: None,
            },
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.error.details = Some(details);
        self
    }

    pub fn with_request_id(mut self, req_id: impl Into<String>) -> Self {
        self.error.request_id = Some(req_id.into());
        self
    }
}
