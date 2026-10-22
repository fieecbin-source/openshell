//! 保险库内部错误映射：统一使用 core-domain 的错误码。

use openshell_core_domain::{DomainError, ErrorCode};

/// 解密/密码校验失败统一错误（不区分具体原因）。
pub(crate) fn decrypt_failed() -> DomainError {
    DomainError::new(
        ErrorCode::VaultDecryptFailed,
        "unable to decrypt vault data",
    )
}

/// 密钥槽或密文结构损坏。
pub(crate) fn corrupt(message: impl Into<String>) -> DomainError {
    DomainError::new(ErrorCode::VaultCorrupt, message)
}

/// 保险库处于锁定状态。
pub(crate) fn locked() -> DomainError {
    DomainError::vault_locked()
}

/// 参数或调用顺序非法。
pub(crate) fn validation(message: impl Into<String>) -> DomainError {
    DomainError::validation(message)
}

/// 内部错误（AEAD 加密失败等理论上不可达的情形）。
pub(crate) fn internal(message: impl Into<String>) -> DomainError {
    DomainError::internal(message)
}
