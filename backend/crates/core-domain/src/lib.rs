//! OpenShell 领域层：实体、值对象、错误与端口契约。
//!
//! 本 crate 不依赖任何适配器（存储、网络、加密库实现），只定义上层与适配层共同遵守的契约。

pub mod entities;
pub mod errors;
pub mod events;
pub mod extension;
pub mod ids;
pub mod ports;
pub mod value_objects;

pub use entities::*;
pub use errors::{DomainError, DomainResult, ErrorCode};
pub use events::{AppEvent, ConnectionState, TerminalNoticeKind, VaultLifecycle};
pub use extension::*;
pub use ids::*;
pub use ports::*;
pub use value_objects::*;

/// 同步元数据（所有可同步实体共用）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SyncMeta {
    /// 服务端分配版本号；0 表示尚未推送。
    pub version: i64,
    pub origin_device_id: Option<String>,
    pub dirty: bool,
}

impl Default for SyncMeta {
    fn default() -> Self {
        Self {
            version: 0,
            origin_device_id: None,
            dirty: true,
        }
    }
}

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
