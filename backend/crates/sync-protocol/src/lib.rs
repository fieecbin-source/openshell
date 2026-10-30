//! OpenShell 同步与线协议定义（共享 DTO 与标准错误码，无外部 IO）

pub mod auth;
pub mod device;
pub mod error;
pub mod ops;
pub mod relay;
pub mod snapshot;
pub mod sync;
pub mod updates;
pub mod vault;

pub use auth::*;
pub use device::*;
pub use error::*;
pub use ops::*;
pub use relay::*;
pub use snapshot::*;
pub use sync::*;
pub use updates::*;
pub use vault::*;

/// API 协议版本号
pub const API_VERSION: u32 = 1;
pub const API_VERSION_V2: u32 = 2;

/// v2 同步记录结构版本。v1 路由仍保持兼容；v2 路由拒绝无法理解的结构版本。
pub const SYNC_SCHEMA_VERSION_V2: u32 = 2;

/// 标准头定义
pub const HEADER_API_VERSION: &str = "x-api-version";
pub const HEADER_DEVICE_ID: &str = "x-device-id";
pub const HEADER_IDEMPOTENCY_KEY: &str = "idempotency-key";
pub const HEADER_REQUEST_ID: &str = "x-request-id";
pub const HEADER_INSTALL_ID: &str = "x-install-id";
pub const HEADER_CHANNEL: &str = "x-channel";
pub const HEADER_CURRENT_VERSION: &str = "x-current-version";

/// 中继 WebSocket 子协议
pub const RELAY_WS_PROTOCOL: &str = "openshell.relay.v1";
