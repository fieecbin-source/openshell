//! 可替换的数据源。
//!
//! 数据源只负责「交出一份候选版本清单」，不关心版本比较、平台匹配、UI 与安装。
//! 顺序回退由 [`SourceChain`] 完成：只有可重试或不可用的源才会被跳过，
//! 真正拿到结果就立刻返回，避免浪费限流额度。

pub mod github;
pub mod server;
pub mod static_manifest;

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::Channel;
use async_trait::async_trait;
use std::sync::Arc;

/// 数据源返回的资产条目。
#[derive(Debug, Clone, Default)]
pub struct SourceAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// 十六进制小写 sha256（GitHub 的 `digest` 字段或 latest.json 自带）。
    pub sha256: Option<String>,
    /// 仅 latest.json 会显式声明平台/架构；GitHub 资产靠文件名推断。
    pub platform: Option<String>,
    pub arch: Option<String>,
}

/// 强更声明（来自 Release 内嵌的 `update-meta.json` 或 latest.json）。
#[derive(Debug, Clone, Default)]
pub struct SourceMeta {
    pub mandatory: bool,
    pub min_supported_version: Option<String>,
    /// 说明文本覆盖（`update-meta.json` 里可放更精炼的说明）。
    pub notes_markdown: Option<String>,
}

/// 一个候选版本。
#[derive(Debug, Clone, Default)]
pub struct SourceRelease {
    /// 数据源标识（`github` / `manifest` / `server`）。
    pub source: &'static str,
    /// 原始 tag（可能带 `v` 前缀）。
    pub tag: String,
    pub name: String,
    pub notes_markdown: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub prerelease: bool,
    pub assets: Vec<SourceAsset>,
    pub meta: SourceMeta,
}

/// 一次取数的结果。
#[derive(Debug, Clone, Default)]
pub struct SourceOutcome {
    /// `None` 表示数据源明确表示「没有更新」（例如测试通道没找到预发布）。
    pub release: Option<SourceRelease>,
    /// 下次条件请求使用的 ETag。
    pub etag: Option<String>,
    /// 命中 304：内容未变化，调用方应复用本地缓存。
    pub not_modified: bool,
}

/// 取数请求。
#[derive(Debug, Clone)]
pub struct SourceRequest {
    pub channel: Channel,
    pub etag: Option<String>,
}

/// 更新数据源。
///
/// 实现约束：
/// * 错误必须区分 `Retryable` / `RateLimited` / `NotFound` / `InvalidPayload` / `NotConfigured`；
/// * 不得在此层做版本比较或平台匹配；
/// * 不得缓存（缓存统一由 `UpdateService` 负责，避免状态分散）。
#[async_trait]
pub trait UpdateSource: Send + Sync {
    fn id(&self) -> &'static str;
    async fn fetch(&self, request: &SourceRequest) -> Result<SourceOutcome, UpdaterError>;
}

/// 顺序回退链。
pub struct SourceChain {
    sources: Vec<Arc<dyn UpdateSource>>,
}

impl SourceChain {
    pub fn new(sources: Vec<Arc<dyn UpdateSource>>) -> Self {
        Self { sources }
    }

    /// 已配置的数据源标识（按尝试顺序）。
    pub fn ids(&self) -> Vec<&'static str> {
        self.sources.iter().map(|source| source.id()).collect()
    }

    /// 依次尝试；成功即返回，失败记录后继续下一个。
    ///
    /// 返回的 `failed` 用于日志与「所有源都失败」时的错误聚合。
    pub async fn fetch(&self, request: &SourceRequest) -> Result<ChainOutcome, UpdaterError> {
        let mut failed: Vec<(String, UpdaterError)> = Vec::new();

        for source in &self.sources {
            match source.fetch(request).await {
                Ok(outcome) => {
                    return Ok(ChainOutcome { outcome, failed });
                }
                Err(err) if err.kind == UpdaterErrorKind::NotConfigured => {
                    tracing::debug!(source = source.id(), "update source not configured");
                    failed.push((source.id().to_string(), err));
                }
                Err(err) => {
                    tracing::warn!(
                        source = source.id(),
                        kind = ?err.kind,
                        retryable = err.retryable,
                        "update source failed, falling back"
                    );
                    failed.push((source.id().to_string(), err));
                }
            }
        }

        // 返回「第一个真实失败」（主源最贴近用户预期），跳过占位源的 NotConfigured
        let primary = failed
            .iter()
            .find(|(_, err)| err.kind != UpdaterErrorKind::NotConfigured)
            .map(|(_, err)| err.clone());
        Err(primary.unwrap_or_else(|| {
            UpdaterError::not_configured("no update source is configured or reachable")
        }))
    }
}

/// 源链执行结果。
#[derive(Debug, Clone)]
pub struct ChainOutcome {
    pub outcome: SourceOutcome,
    pub failed: Vec<(String, UpdaterError)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct FakeSource {
        id: &'static str,
        result: Result<SourceOutcome, UpdaterError>,
        calls: AtomicU32,
    }

    #[async_trait]
    impl UpdateSource for FakeSource {
        fn id(&self) -> &'static str {
            self.id
        }

        async fn fetch(&self, _request: &SourceRequest) -> Result<SourceOutcome, UpdaterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &self.result {
                Ok(outcome) => Ok(outcome.clone()),
                Err(err) => Err(err.clone()),
            }
        }
    }

    fn request() -> SourceRequest {
        SourceRequest {
            channel: Channel::Stable,
            etag: None,
        }
    }

    fn ok_outcome() -> SourceOutcome {
        SourceOutcome {
            release: Some(SourceRelease {
                source: "fake",
                tag: "v1.1.0".into(),
                ..Default::default()
            }),
            etag: Some("\"etag\"".into()),
            not_modified: false,
        }
    }

    #[tokio::test]
    async fn returns_first_successful_source() {
        let primary = Arc::new(FakeSource {
            id: "primary",
            result: Err(UpdaterError::network("down")),
            calls: AtomicU32::new(0),
        });
        let fallback = Arc::new(FakeSource {
            id: "fallback",
            result: Ok(ok_outcome()),
            calls: AtomicU32::new(0),
        });
        let chain = SourceChain::new(vec![primary.clone(), fallback.clone()]);
        let outcome = chain.fetch(&request()).await.expect("fallback works");
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].0, "primary");
        assert!(outcome.outcome.release.is_some());
        assert_eq!(fallback.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn does_not_try_next_source_after_success() {
        let first = Arc::new(FakeSource {
            id: "first",
            result: Ok(ok_outcome()),
            calls: AtomicU32::new(0),
        });
        let second = Arc::new(FakeSource {
            id: "second",
            result: Ok(ok_outcome()),
            calls: AtomicU32::new(0),
        });
        let chain = SourceChain::new(vec![first, second.clone()]);
        chain.fetch(&request()).await.expect("ok");
        assert_eq!(second.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn aggregates_failures_and_prefers_real_error() {
        let unconfigured = Arc::new(FakeSource {
            id: "server",
            result: Err(UpdaterError::not_configured("no server")),
            calls: AtomicU32::new(0),
        });
        let broken = Arc::new(FakeSource {
            id: "github",
            result: Err(UpdaterError::new(UpdaterErrorKind::RateLimited, "limited")),
            calls: AtomicU32::new(0),
        });
        let chain = SourceChain::new(vec![broken, unconfigured]);
        let err = chain.fetch(&request()).await.expect_err("all failed");
        assert_eq!(err.kind, UpdaterErrorKind::RateLimited);
    }

    #[tokio::test]
    async fn reports_not_configured_when_every_source_is_placeholder() {
        let chain = SourceChain::new(vec![Arc::new(FakeSource {
            id: "server",
            result: Err(UpdaterError::not_configured("no server")),
            calls: AtomicU32::new(0),
        })]);
        let err = chain.fetch(&request()).await.expect_err("all failed");
        assert_eq!(err.kind, UpdaterErrorKind::NotConfigured);
    }
}
