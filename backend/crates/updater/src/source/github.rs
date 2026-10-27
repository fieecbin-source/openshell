//! GitHub Release 数据源。
//!
//! * 稳定通道：`GET /repos/{owner}/{repo}/releases/latest`（GitHub 本身不会返回 draft/prerelease）
//! * 测试通道：`GET /repos/{owner}/{repo}/releases?per_page=30`，筛出 `prerelease && !draft`，
//!   取 semver 最大的一个；没有预发布时返回 `release: None`，由上层回落到稳定版。
//!
//! 注意：客户端**不携带任何 token**。匿名额度每小时 60 次，由 `UpdateService` 的缓存与
//! ETag 条件请求兜住。

use super::{SourceAsset, SourceOutcome, SourceRelease, SourceRequest, UpdateSource};
use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::http::{fetch_with_retry, HttpClient, HttpRequest, RetryPolicy};
use crate::model::Channel;
use crate::version;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

/// 数据源标识。
pub const SOURCE_ID: &str = "github";

/// `<owner>/<repo>` 的 GitHub Release 源。
pub struct GitHubSource {
    http: Arc<dyn HttpClient>,
    owner: String,
    repo: String,
    retry: RetryPolicy,
}

impl GitHubSource {
    pub fn new(
        http: Arc<dyn HttpClient>,
        owner: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            http,
            owner: owner.into(),
            repo: repo.into(),
            retry: RetryPolicy::default(),
        }
    }

    fn api_url(&self, channel: Channel) -> String {
        match channel {
            Channel::Stable => format!(
                "https://api.github.com/repos/{}/{}/releases/latest",
                self.owner, self.repo
            ),
            Channel::Beta => format!(
                "https://api.github.com/repos/{}/{}/releases?per_page=30",
                self.owner, self.repo
            ),
        }
    }

    fn release_page_url(&self) -> String {
        format!("https://github.com/{}/{}/releases", self.owner, self.repo)
    }
}

#[async_trait]
impl UpdateSource for GitHubSource {
    fn id(&self) -> &'static str {
        SOURCE_ID
    }

    async fn fetch(&self, request: &SourceRequest) -> Result<SourceOutcome, UpdaterError> {
        let response = fetch_with_retry(
            self.http.as_ref(),
            HttpRequest::json(self.api_url(request.channel)).with_etag(request.etag.as_deref()),
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

        match response.status {
            404 => {
                return Err(UpdaterError::new(
                    UpdaterErrorKind::NotFound,
                    "repository has no published release yet",
                )
                .with_status(404));
            }
            200 => {}
            status => {
                return Err(UpdaterError::new(
                    UpdaterErrorKind::Http,
                    format!("github api returned {status}"),
                )
                .with_status(status));
            }
        }

        let payload: Value = serde_json::from_slice(&response.body).map_err(|err| {
            UpdaterError::invalid_payload(format!("github response is not valid json: {err}"))
        })?;

        let release = match request.channel {
            Channel::Stable => parse_release(&payload, self.release_page_url())?,
            Channel::Beta => pick_prerelease(&payload, self.release_page_url())?,
        };

        Ok(SourceOutcome {
            release,
            etag: response.etag(),
            not_modified: false,
        })
    }
}

/// 解析单个 release 对象；draft 返回 `Ok(None)`。
fn parse_release(
    value: &Value,
    fallback_page: String,
) -> Result<Option<SourceRelease>, UpdaterError> {
    if value.get("draft").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(None);
    }
    Ok(Some(release_from_json(value, fallback_page)?))
}

/// 从列表里挑 semver 最大的预发布版本。
fn pick_prerelease(
    value: &Value,
    fallback_page: String,
) -> Result<Option<SourceRelease>, UpdaterError> {
    let Some(items) = value.as_array() else {
        return Err(UpdaterError::invalid_payload(
            "github releases response is not an array",
        ));
    };

    let mut best: Option<(semver::Version, SourceRelease)> = None;
    for item in items {
        if item.get("draft").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        if !item
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(tag) = item.get("tag_name").and_then(Value::as_str) else {
            continue;
        };
        let Some(parsed) = version::normalize_opt(tag) else {
            continue;
        };
        let release = release_from_json(item, fallback_page.clone())?;
        match &best {
            Some((current, _)) if *current >= parsed => {}
            _ => best = Some((parsed, release)),
        }
    }
    Ok(best.map(|(_, release)| release))
}

fn release_from_json(value: &Value, fallback_page: String) -> Result<SourceRelease, UpdaterError> {
    let tag = value
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| UpdaterError::invalid_payload("release has no tag_name"))?
        .to_string();

    let notes = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Ok(SourceRelease {
        source: SOURCE_ID,
        tag,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        notes_markdown: notes,
        published_at: value
            .get("published_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        html_url: value
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(fallback_page),
        prerelease: value
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        assets: parse_assets(value),
        meta: Default::default(),
    })
}

fn parse_assets(value: &Value) -> Vec<SourceAsset> {
    let Some(items) = value.get("assets").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?.to_string();
            let url = item
                .get("browser_download_url")
                .and_then(Value::as_str)?
                .to_string();
            let size = item.get("size").and_then(Value::as_u64).unwrap_or(0);
            Some(SourceAsset {
                name,
                url,
                size,
                // GitHub 新版 API 直接给出 `digest: "sha256:<hex>"`
                sha256: item
                    .get("digest")
                    .and_then(Value::as_str)
                    .and_then(parse_digest),
                platform: None,
                arch: None,
            })
        })
        .collect()
}

/// 把 `sha256:abcdef...` 解析成 64 位十六进制串。
fn parse_digest(raw: &str) -> Option<String> {
    let hex = raw.strip_prefix("sha256:")?.trim().to_ascii_lowercase();
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{HttpClient, HttpResponse};
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

    fn client_with(status: u16, body: &str, headers: &[(&str, &str)]) -> Arc<dyn HttpClient> {
        Arc::new(StaticClient {
            response: HttpResponse {
                status,
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
                    .collect::<HashMap<_, _>>(),
                body: body.as_bytes().to_vec(),
            },
        })
    }

    fn stable_request() -> SourceRequest {
        SourceRequest {
            channel: Channel::Stable,
            etag: None,
        }
    }

    /// 用 `json!` 构造夹具，避免 Markdown 里的 `#` 破坏 raw string。
    fn stable_json() -> String {
        serde_json::json!({
            "tag_name": "v1.1.0",
            "name": "OpenShell 1.1.0",
            "body": "## 更新亮点\n- 自动更新",
            "published_at": "2026-10-27T08:00:00Z",
            "draft": false,
            "prerelease": false,
            "html_url": "https://github.com/fieecbin-source/openshell/releases/tag/v1.1.0",
            "assets": [
                {"name": "OpenShell-1.1.0-windows-x86_64.exe", "size": 52428800,
                 "browser_download_url": "https://github.com/fieecbin-source/openshell/releases/download/v1.1.0/OpenShell-1.1.0-windows-x86_64.exe",
                 "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
                {"name": "SHA256SUMS.txt", "size": 256,
                 "browser_download_url": "https://github.com/fieecbin-source/openshell/releases/download/v1.1.0/SHA256SUMS.txt"}
            ]
        })
        .to_string()
    }

    #[tokio::test]
    async fn parses_stable_release_with_digest() {
        let body = stable_json();
        let source = GitHubSource::new(
            client_with(200, &body, &[("etag", "\"abc\"")]),
            "fieecbin-source",
            "openshell",
        );
        let outcome = source.fetch(&stable_request()).await.expect("fetch");
        assert!(!outcome.not_modified);
        assert_eq!(outcome.etag.as_deref(), Some("\"abc\""));
        let release = outcome.release.expect("release");
        assert_eq!(release.tag, "v1.1.0");
        assert!(release.notes_markdown.contains("自动更新"));
        assert_eq!(release.assets.len(), 2);
        assert_eq!(release.assets[0].size, 52_428_800);
        assert_eq!(
            release.assets[0].sha256.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert!(release.assets[1].sha256.is_none());
    }

    #[tokio::test]
    async fn honors_not_modified() {
        let source = GitHubSource::new(client_with(304, "", &[("etag", "\"abc\"")]), "a", "b");
        let outcome = source
            .fetch(&SourceRequest {
                channel: Channel::Stable,
                etag: Some("\"abc\"".into()),
            })
            .await
            .expect("fetch");
        assert!(outcome.not_modified);
        assert!(outcome.release.is_none());
    }

    #[tokio::test]
    async fn maps_404_to_not_found() {
        let source = GitHubSource::new(client_with(404, "{}", &[]), "a", "b");
        let err = source.fetch(&stable_request()).await.expect_err("404");
        assert_eq!(err.kind, UpdaterErrorKind::NotFound);
    }

    #[tokio::test]
    async fn rejects_malformed_json() {
        let source = GitHubSource::new(client_with(200, "<html>oops</html>", &[]), "a", "b");
        let err = source.fetch(&stable_request()).await.expect_err("bad json");
        assert_eq!(err.kind, UpdaterErrorKind::InvalidPayload);
    }

    #[tokio::test]
    async fn beta_channel_picks_highest_prerelease() {
        let body = r#"[
            {"tag_name":"v1.2.0-rc.1","prerelease":true,"draft":false,"body":"rc1","assets":[]},
            {"tag_name":"v1.3.0-beta.1","prerelease":true,"draft":false,"body":"beta","assets":[]},
            {"tag_name":"v9.9.9","prerelease":false,"draft":false,"body":"stable","assets":[]},
            {"tag_name":"v1.4.0-rc.9","prerelease":true,"draft":true,"body":"draft","assets":[]}
        ]"#;
        let source = GitHubSource::new(client_with(200, body, &[]), "a", "b");
        let outcome = source
            .fetch(&SourceRequest {
                channel: Channel::Beta,
                etag: None,
            })
            .await
            .expect("fetch");
        let release = outcome.release.expect("prerelease");
        assert_eq!(release.tag, "v1.3.0-beta.1");
        assert!(release.prerelease);
    }

    #[tokio::test]
    async fn beta_channel_without_prerelease_returns_none() {
        let body = r#"[{"tag_name":"v1.1.0","prerelease":false,"draft":false,"assets":[]}]"#;
        let source = GitHubSource::new(client_with(200, body, &[]), "a", "b");
        let outcome = source
            .fetch(&SourceRequest {
                channel: Channel::Beta,
                etag: None,
            })
            .await
            .expect("fetch");
        assert!(outcome.release.is_none());
    }
}
