//! AI 模块统一错误：归一鉴权 / 限流 / 模型不存在 / 网络 / 证书 / 上下文超长等场景。
//!
//! `message` 必须是可直接展示给用户的中文短句，不得包含请求体、密钥或远端原始响应。
//! 原始状态码只记录在 `status` 中用于诊断，不进入用户文案。

use openshell_core_domain::{DomainError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::fmt;

/// 归一后的错误类别（IPC 线值为 `SCREAMING_SNAKE_CASE`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiErrorCode {
    /// 鉴权失败（401/403、Key 无效）。
    Auth,
    /// 触发限流（429）。
    RateLimit,
    /// 模型不存在或无权访问该模型。
    ModelNotFound,
    /// 网络不可达 / DNS / 连接重置。
    Network,
    /// TLS 证书校验失败。
    Certificate,
    /// 上下文超长。
    ContextTooLong,
    /// 请求超时。
    Timeout,
    /// 用户取消。
    Cancelled,
    /// 参数不合法。
    BadRequest,
    /// 服务端 5xx。
    Server,
    /// 配置缺失或不合法（如 base_url 为空）。
    Config,
    /// 系统凭据后端不可用。
    KeyringUnavailable,
    /// 密钥写入失败。
    KeyWriteFailed,
    /// 密钥读取/解密失败。
    KeyDecryptFailed,
    /// 保险库未解锁（回退通道需要主密码）。
    VaultLocked,
    /// 响应解析失败。
    Parse,
    /// 当前阶段未实现。
    NotImplemented,
    /// 其他内部错误。
    Internal,
}

impl AiErrorCode {
    pub fn as_str(&self) -> &'static str {
        use AiErrorCode::*;
        match self {
            Auth => "AI_AUTH",
            RateLimit => "AI_RATE_LIMIT",
            ModelNotFound => "AI_MODEL_NOT_FOUND",
            Network => "AI_NETWORK",
            Certificate => "AI_CERTIFICATE",
            ContextTooLong => "AI_CONTEXT_TOO_LONG",
            Timeout => "AI_TIMEOUT",
            Cancelled => "AI_CANCELLED",
            BadRequest => "AI_BAD_REQUEST",
            Server => "AI_SERVER",
            Config => "AI_CONFIG",
            KeyringUnavailable => "AI_KEYRING_UNAVAILABLE",
            KeyWriteFailed => "AI_KEY_WRITE_FAILED",
            KeyDecryptFailed => "AI_KEY_DECRYPT_FAILED",
            VaultLocked => "AI_VAULT_LOCKED",
            Parse => "AI_PARSE",
            NotImplemented => "AI_NOT_IMPLEMENTED",
            Internal => "AI_INTERNAL",
        }
    }

    /// 映射到 `core-domain` 错误码，供 IPC 层直接复用。
    pub fn to_domain_code(&self) -> ErrorCode {
        use AiErrorCode::*;
        match self {
            Auth => ErrorCode::AuthFailed,
            RateLimit => ErrorCode::RateLimited,
            ModelNotFound => ErrorCode::NotFound,
            Network | Certificate => ErrorCode::Network,
            ContextTooLong | BadRequest | Config | Parse => ErrorCode::Validation,
            Timeout => ErrorCode::Timeout,
            Cancelled => ErrorCode::Cancelled,
            Server => ErrorCode::ServerUnreachable,
            KeyringUnavailable => ErrorCode::KeychainUnavailable,
            KeyWriteFailed => ErrorCode::Internal,
            KeyDecryptFailed => ErrorCode::VaultDecryptFailed,
            VaultLocked => ErrorCode::VaultLocked,
            NotImplemented => ErrorCode::Unsupported,
            Internal => ErrorCode::Internal,
        }
    }

    pub fn default_retryable(&self) -> bool {
        use AiErrorCode::*;
        matches!(
            self,
            RateLimit | Network | Timeout | Server | KeyringUnavailable
        )
    }
}

/// AI 模块错误。构造时即给出中文用户文案。
#[derive(Debug, Clone)]
pub struct AiError {
    pub code: AiErrorCode,
    pub message: String,
    pub retryable: bool,
    pub status: Option<u16>,
}

impl AiError {
    pub fn new(code: AiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: code.default_retryable(),
            status: None,
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Auth, message)
    }

    pub fn rate_limit(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::RateLimit, message)
    }

    pub fn model_not_found(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::ModelNotFound, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Network, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Timeout, message)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Config, message)
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Parse, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AiErrorCode::Internal, message)
    }

    /// 转为 IPC 可直接序列化的领域错误。
    pub fn to_domain_error(&self) -> DomainError {
        DomainError {
            code: self.code.to_domain_code(),
            message: self.message.clone(),
            retryable: self.retryable,
            details: Some(
                serde_json::json!({ "ai_code": self.code.as_str(), "status": self.status }),
            ),
        }
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AiError {}

impl From<AiError> for DomainError {
    fn from(err: AiError) -> Self {
        err.to_domain_error()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_maps_to_domain_codes() {
        assert_eq!(
            AiError::auth("x").code.to_domain_code(),
            ErrorCode::AuthFailed
        );
        assert_eq!(
            AiError::rate_limit("x").code.to_domain_code(),
            ErrorCode::RateLimited
        );
        assert_eq!(
            AiError::model_not_found("x").code.to_domain_code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            AiError::new(AiErrorCode::Certificate, "x")
                .code
                .to_domain_code(),
            ErrorCode::Network
        );
        assert_eq!(
            AiError::new(AiErrorCode::ContextTooLong, "x")
                .code
                .to_domain_code(),
            ErrorCode::Validation
        );
        assert_eq!(
            AiError::timeout("x").code.to_domain_code(),
            ErrorCode::Timeout
        );
    }

    #[test]
    fn domain_error_carries_ai_code_without_secret() {
        let err = AiError::auth("API Key 无效或已过期，请重新填写").with_status(401);
        let domain = err.to_domain_error();
        assert_eq!(domain.code, ErrorCode::AuthFailed);
        assert!(domain.message.contains("API Key"));
        let details = domain.details.unwrap();
        assert_eq!(details["ai_code"], "AI_AUTH");
        assert_eq!(details["status"], 401);
    }
}
