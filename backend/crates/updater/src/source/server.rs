//! 自有服务端数据源（**占位，本版本未启用**）。
//!
//! 上线自有服务端后，只需要：
//! 1. 服务端提供与 `latest.json` 同构的接口（或复用现有同步服务的
//!    `GET /updates/{target}/latest`，见 `backend/server/src/routes/updates.rs`）；
//! 2. 把本文件的 `fetch` 换成真实请求，并在 `UpdateService::build_chain` 里把
//!    `ServerSource::new(..)` 放进源链；
//! 3. UI 与安装流程**无需任何改动**——这正是 `UpdateSource` 抽象存在的意义。
//!
//! 现在它永远返回 `NotConfigured`，源链会自动跳过，不影响 GitHub 源。

use super::{SourceOutcome, SourceRequest, UpdateSource};
use crate::error::UpdaterError;
use async_trait::async_trait;

/// 数据源标识。
pub const SOURCE_ID: &str = "server";

/// 服务端源占位实现。
pub struct ServerSource {
    /// 服务端基址（保留字段，方便后续实现直接使用）。
    #[allow(dead_code)]
    base_url: String,
}

impl ServerSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }
}

#[async_trait]
impl UpdateSource for ServerSource {
    fn id(&self) -> &'static str {
        SOURCE_ID
    }

    async fn fetch(&self, _request: &SourceRequest) -> Result<SourceOutcome, UpdaterError> {
        Err(UpdaterError::not_configured(
            "self-hosted update server is not implemented in this build",
        ))
    }
}
