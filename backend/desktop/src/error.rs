//! IPC 错误定义与领域错误映射（对齐架构 §6.6）。

use openshell_core_domain::{DomainError, ErrorCode};
use serde::Serialize;
use ulid::Ulid;

#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
    pub correlation_id: String,
}

impl From<DomainError> for IpcError {
    fn from(err: DomainError) -> Self {
        Self {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            details: err.details,
            correlation_id: Ulid::new().to_string(),
        }
    }
}

/// 更新模块的错误沿用同一套 IPC 形态（`UPDATE_*` 错误码由 `UpdaterError` 映射而来）。
impl From<openshell_updater::UpdaterError> for IpcError {
    fn from(err: openshell_updater::UpdaterError) -> Self {
        DomainError::from(err).into()
    }
}
