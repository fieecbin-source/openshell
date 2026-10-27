//! OpenShell 更新模块。
//!
//! # 分层
//!
//! ```text
//!  ┌──────────── UI (React) ────────────┐
//!  │ 只依赖 UpdateService 的返回值与状态 │
//!  └───────────────┬────────────────────┘
//!        ┌─────────▼──────────┐
//!        │ service::UpdateService │  组装修复：缓存 → 源链 → 策略 → 资产 → 元数据
//!        └───┬───────┬───────┬───┘
//!   ┌────────▼──┐ ┌──▼─────┐ ┌▼──────────┐
//!   │ source    │ │ cache  │ │ policy    │
//!   │ GitHub /  │ │ ETag/  │ │ 跳过/稍后 │
//!   │ manifest  │ │ 6h TTL │ │ 强制更新  │
//!   └────────┬──┘ └────────┘ └───────────┘
//!        ┌───▼────┐
//!        │ http   │  仅 HTTPS + 域名白名单 + 退避重试
//!        └───┬────┘
//!   ┌────────▼─────────┐
//!   │ download / verify │  断点续传 + sha256
//!   │ install           │  备份 → 退出 → 运行安装包
//!   └───────────────────┘
//! ```
//!
//! # 安全约束
//!
//! * 客户端不含任何 GitHub token；
//! * 只允许 HTTPS，且 host 必须命中白名单或用户配置的镜像；
//! * Release 说明在 Rust 侧完成 Markdown → 白名单 HTML 的转换，前端不执行任何脚本；
//! * 安装前必须先做数据快照，且哈希不匹配的包永不执行。

pub mod asset;
pub mod cache;
pub mod download;
pub mod error;
pub mod guard;
pub mod http;
pub mod install;
pub mod log;
pub mod meta;
pub mod model;
pub mod notes;
pub mod policy;
pub mod precheck;
pub mod proxy;
pub mod service;
pub mod source;
pub mod verify;
pub mod version;

/// 重新导出 `async_trait`，方便上层（命令层/测试）实现 [`http::HttpClient`] 与 [`source::UpdateSource`]。
pub use async_trait::async_trait;
pub use download::{
    DownloadOutcome, DownloadProgress, DownloadRequest, Downloader, RangeFetcher, RangeMeta,
    ReqwestFetcher,
};
pub use error::{UpdaterError, UpdaterErrorKind};
pub use guard::{ExitDecision, InstallGate, InstallPermit, SingleFlight};
pub use install::{InstallContext, InstallManager, InstallOutcome, InstallStrategy, StrategyKind};
pub use model::{
    Arch, Channel, Platform, UpdateAsset, UpdateCheckResult, UpdateConfig, APP_NAME,
    DEFAULT_INTERVAL_HOURS, STARTUP_DELAY_SECS,
};
pub use policy::NotifyDecision;
pub use precheck::{normalize_sha256, validate_installer};
pub use proxy::ProxyMode;
pub use service::{CheckOutcome, UpdateService};
pub use verify::{Sha256Verifier, SignatureVerifier, Verifier};
