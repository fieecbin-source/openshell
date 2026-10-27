//! 静态清单数据源（`latest.json`）。
//!
//! 适用于国内网络环境下的备用检测：把 `latest.json` 同步到 jsDelivr / 自建镜像，
//! 用户只要在设置里填地址即可切换，无需重新安装客户端。
//!
//! 清单格式见 `docs/UPDATE.md`「latest.json 字段说明」。

use super::{SourceAsset, SourceOutcome, SourceRelease, SourceRequest, UpdateSource};
use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::http::{fetch_with_retry, HttpClient, HttpRequest, RetryPolicy};
use crate::version;
use async_trait::async_trait;
use serde::Deserialize;
use std::sync::Arc;

pub const SOURCE_ID: &str = "manifest";

/// `latest.json` 的顶层结构。所有字段都有默认值以便向前兼容。
#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    mandatory: bool,
    #[serde(default)]
    min_supported_version: Option<String>,
    #[serde(default)]
    release_page: Option<String>,
    #[serde(default)]
    assets: Vec<ManifestAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestAsset {
    name: String,
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    arch: Option<String>,
}

/// 读取远端 `latest.json` 的源。
pub struct StaticManifestSource {
    http: Arc<dyn HttpClient>,
    url: String,
    retry: RetryPolicy,
}

impl StaticManifestSource {
    pub fn new(http: Arc<dyn HttpClient>, url: impl Into<String>) -> Self {
        Self {
            http,
            url: url.into(),
            retry: RetryPolicy::default(),
        }
    }
}

#[async_trait]
impl UpdateSource for StaticManifestSource {
    fn id(&self) -> &'static str {
        SOURCE_ID
    }

    async fn fetch(&self, request: &SourceRequest) -> Result<SourceOutcome, UpdaterError> {
        let response = fetch_with_retry(
            self.http.as_ref(),
            HttpRequest::json(self.url.clone()).with_etag(request.etag.as_deref()),
            self.retry,
        )
        .await?;

        if response.is_not_modified() {
            return Ok(SourceOutcome {
                release: None,
                etag: request.etag.clone(),
                not_modified: true,
            });
        }
        if response.status == 404 {
            return Err(
                UpdaterError::new(UpdaterErrorKind::NotFound, "latest.json was not found")
                    .with_status(404),
            );
        }
        if !response.is_success() {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Http,
                format!("manifest source returned {}", response.status),
            )
            .with_status(response.status));
        }

        let manifest: Manifest = serde_json::from_slice(&response.body).map_err(|err| {
            UpdaterError::invalid_payload(format!("latest.json is not valid: {err}"))
        })?;
        // 版本号必须能被 semver 解析，否则直接判定清单损坏
        version::normalize(&manifest.version)?;

        let release = SourceRelease {
            source: SOURCE_ID,
            tag: manifest
                .tag
                .unwrap_or_else(|| format!("v{}", manifest.version.trim_start_matches('v'))),
            name: manifest.name.unwrap_or_default(),
            notes_markdown: manifest.notes.unwrap_or_default(),
            published_at: manifest.published_at,
            html_url: manifest.release_page.unwrap_or_default(),
            prerelease: manifest.version.contains('-'),
            assets: manifest
                .assets
                .into_iter()
                .map(|asset| SourceAsset {
                    name: asset.name,
                    url: asset.url,
                    size: asset.size,
                    sha256: asset.sha256,
                    platform: asset.platform,
                    arch: asset.arch,
                })
                .collect(),
            meta: super::SourceMeta {
                mandatory: manifest.mandatory,
                min_supported_version: manifest.min_supported_version,
                notes_markdown: None,
            },
        };

        Ok(SourceOutcome {
            release: Some(release),
            etag: response.etag(),
            not_modified: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{HttpClient, HttpResponse};
    use crate::model::Channel;
    use std::collections::HashMap;

    struct StaticClient {
        response: HttpResponse,
    }

    #[async_trait]
    impl HttpClient for StaticClient {
        async fn execute(&self, _request: HttpRequest) -> Result<HttpResponse, UpdaterError> {
            Ok(self.response.clone())
        }
    }

    fn source(status: u16, body: &str) -> StaticManifestSource {
        StaticManifestSource::new(
            Arc::new(StaticClient {
                response: HttpResponse {
                    status,
                    headers: HashMap::new(),
                    body: body.as_bytes().to_vec(),
                },
            }),
            "https://cdn.jsdelivr.net/gh/a/b@updater/latest.json",
        )
    }

    fn request() -> SourceRequest {
        SourceRequest {
            channel: Channel::Stable,
            etag: None,
        }
    }

    #[tokio::test]
    async fn parses_manifest_with_metadata() {
        let body = r#"{
            "version": "1.1.0",
            "tag": "v1.1.0",
            "name": "OpenShell 1.1.0",
            "notes": "- 自动更新",
            "published_at": "2026-10-27T08:00:00Z",
            "mandatory": true,
            "min_supported_version": "1.0.5",
            "release_page": "https://github.com/a/b/releases/tag/v1.1.0",
            "assets": [
                {"name":"OpenShell-1.1.0-windows-x86_64.exe","url":"https://github.com/a/b/releases/download/v1.1.0/OpenShell-1.1.0-windows-x86_64.exe","size":1024,"sha256":"aa","platform":"windows","arch":"x86_64"}
            ]
        }"#;
        let outcome = source(200, body).fetch(&request()).await.expect("fetch");
        let release = outcome.release.expect("release");
        assert_eq!(release.tag, "v1.1.0");
        assert!(release.meta.mandatory);
        assert_eq!(release.meta.min_supported_version.as_deref(), Some("1.0.5"));
        assert_eq!(release.assets[0].platform.as_deref(), Some("windows"));
        assert_eq!(release.assets[0].arch.as_deref(), Some("x86_64"));
    }

    #[tokio::test]
    async fn rejects_invalid_version() {
        let body = r#"{"version":"nightly","assets":[]}"#;
        let err = source(200, body)
            .fetch(&request())
            .await
            .expect_err("bad version");
        assert_eq!(err.kind, UpdaterErrorKind::InvalidPayload);
    }

    #[tokio::test]
    async fn rejects_broken_json() {
        let err = source(200, "{oops")
            .fetch(&request())
            .await
            .expect_err("bad json");
        assert_eq!(err.kind, UpdaterErrorKind::InvalidPayload);
    }

    #[tokio::test]
    async fn maps_404_to_not_found() {
        let err = source(404, "").fetch(&request()).await.expect_err("404");
        assert_eq!(err.kind, UpdaterErrorKind::NotFound);
    }
}
