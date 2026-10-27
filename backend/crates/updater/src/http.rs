//! HTTP 抽象：域名白名单、单次请求实现、带退避的重试包装。
//!
//! 拆成 trait + 纯函数重试有两个目的：
//! 1. 逻辑可离线单测（测试用假 client，不碰真实网络）；
//! 2. 下载器与检测器共用同一套「只允许 HTTPS + 白名单域名」的约束。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::proxy::ProxyMode;
use async_trait::async_trait;
use reqwest::Url;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// 允许访问的官方域名（仅 HTTPS）。
///
/// * `api.github.com` 只用于检测；
/// * `github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com`
///   是 Release 资产的下载域名；
/// * `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 用于可选的 `latest.json` 备用源。
pub const ALLOWED_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "raw.githubusercontent.com",
    "cdn.jsdelivr.net",
    "codeload.github.com",
];

/// JSON 响应的最大体积，防止被超大响应打爆内存。
pub const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;

/// 域名白名单。
#[derive(Debug, Clone)]
pub struct HostPolicy {
    hosts: HashSet<String>,
    mirror_host: Option<String>,
}

impl HostPolicy {
    /// 构造白名单；`mirror_prefix` 是用户配置的下载镜像前缀（可为空）。
    pub fn new(mirror_prefix: Option<&str>) -> Self {
        let mirror_host = mirror_prefix
            .and_then(|raw| Url::parse(raw.trim()).ok())
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
        Self {
            hosts: ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect(),
            mirror_host,
        }
    }

    /// 校验并解析 URL：必须是 HTTPS，且 host 在白名单内。
    pub fn check(&self, raw: &str) -> Result<Url, UpdaterError> {
        let url = Url::parse(raw.trim()).map_err(|err| {
            UpdaterError::new(
                UpdaterErrorKind::InvalidPayload,
                format!("invalid url: {err}"),
            )
        })?;
        self.check_url(&url)?;
        Ok(url)
    }

    /// 校验已解析的 URL（重定向逐跳校验也走这里）。
    pub fn check_url(&self, url: &Url) -> Result<(), UpdaterError> {
        if url.scheme() != "https" {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Http,
                "only https endpoints are allowed",
            )
            .with_details(serde_json::json!({ "scheme": url.scheme(), "host": url.host_str() })));
        }
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return Err(UpdaterError::new(UpdaterErrorKind::Http, "url has no host"));
        };
        if self.hosts.contains(&host) || self.mirror_host.as_deref() == Some(host.as_str()) {
            Ok(())
        } else {
            Err(UpdaterError::new(
                UpdaterErrorKind::Http,
                "download host is not in the allow list",
            )
            .with_details(serde_json::json!({ "host": host })))
        }
    }

    /// 用户是否配置了下载镜像。
    pub fn mirror_host(&self) -> Option<&str> {
        self.mirror_host.as_deref()
    }
}

/// 一次 HTTP 请求。
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub url: String,
    /// 条件请求的 `If-None-Match`。
    pub etag: Option<String>,
    pub accept: Option<String>,
    pub max_bytes: usize,
}

impl HttpRequest {
    /// 普通 JSON GET。
    pub fn json(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            etag: None,
            accept: Some("application/json".to_string()),
            max_bytes: MAX_JSON_BYTES,
        }
    }

    /// 文本 GET（`SHA256SUMS.txt` 等小文件）。
    pub fn text(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            etag: None,
            accept: Some("text/plain".to_string()),
            max_bytes: 512 * 1024,
        }
    }

    pub fn with_etag(mut self, etag: Option<&str>) -> Self {
        self.etag = etag.map(str::to_string);
        self
    }
}

/// 一次 HTTP 响应。
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// 头名统一小写，便于大小写无关查找。
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn is_not_modified(&self) -> bool {
        self.status == 304
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn etag(&self) -> Option<String> {
        self.header("etag").map(str::to_string)
    }
}

/// HTTP 传输抽象（生产环境是 reqwest，测试里是内存假实现）。
#[async_trait]
pub trait HttpClient: Send + Sync {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, UpdaterError>;
}

/// 重试策略（默认 3 次尝试，指数退避 400ms / 1.2s，带轻微抖动）。
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 400,
        }
    }
}

/// 带重试地执行一次请求。
///
/// 只在「网络错误 / 超时 / 5xx / 限流」时重试；4xx（除 403/429）立即返回给调用方判断。
pub async fn fetch_with_retry(
    client: &dyn HttpClient,
    request: HttpRequest,
    policy: RetryPolicy,
) -> Result<HttpResponse, UpdaterError> {
    let max_attempts = policy.max_attempts.max(1);
    let mut attempt = 0u32;

    loop {
        attempt += 1;
        match client.execute(request.clone()).await {
            Ok(response) => {
                if response.is_not_modified() || response.is_success() {
                    return Ok(response);
                }
                if matches!(response.status, 403 | 429) {
                    let err = rate_limit_error(&response);
                    if attempt >= max_attempts {
                        return Err(err);
                    }
                    let wait_ms = err
                        .retry_after_ms
                        .map(|ms| ms.max(1) as u64)
                        .unwrap_or_else(|| backoff_ms(&policy, attempt));
                    sleep_ms(wait_ms).await;
                    continue;
                }
                if response.status >= 500 {
                    if attempt >= max_attempts {
                        return Err(UpdaterError::new(
                            UpdaterErrorKind::Http,
                            format!("server error {}", response.status),
                        )
                        .with_status(response.status)
                        .with_retryable(true));
                    }
                    sleep_ms(backoff_ms(&policy, attempt)).await;
                    continue;
                }
                return Ok(response);
            }
            Err(err) => {
                if !err.retryable || attempt >= max_attempts {
                    return Err(err);
                }
                sleep_ms(backoff_ms(&policy, attempt)).await;
            }
        }
    }
}

/// 用响应头构造限流错误（含重置时间，前端可提示「X 分后再试」）。
pub fn rate_limit_error(response: &HttpResponse) -> UpdaterError {
    let retry_after_ms = response
        .header("retry-after")
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map(|secs| secs.saturating_mul(1000));
    let reset_at_ms = response
        .header("x-ratelimit-reset")
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map(|secs| secs.saturating_mul(1000));

    UpdaterError::new(
        UpdaterErrorKind::RateLimited,
        "GitHub API rate limit reached",
    )
    .with_status(response.status)
    .with_retry_after_ms(
        retry_after_ms
            .or_else(|| {
                // 没有 Retry-After 时用重置时间估算（不超过 1 小时）
                reset_at_ms.map(|reset| {
                    let now = openshell_core_domain::now_ms();
                    (reset - now).clamp(1_000, 3_600_000)
                })
            })
            .unwrap_or(60_000),
    )
    .with_reset_at_ms(reset_at_ms.unwrap_or(0))
}

fn backoff_ms(policy: &RetryPolicy, attempt: u32) -> u64 {
    let factor = 3u64.saturating_pow(attempt.saturating_sub(1));
    let base = policy.base_delay_ms.saturating_mul(factor);
    // 抖动 ±20%，避免多客户端同时重试
    let jitter = (base / 5).max(1);
    base.saturating_add(jitter)
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms.min(5_000))).await;
}

/// 生产实现：reqwest + rustls，支持系统代理与逐跳重定向校验。
pub struct ReqwestClient {
    client: reqwest::Client,
    policy: HostPolicy,
}

impl ReqwestClient {
    pub fn new(proxy: &ProxyMode, policy: HostPolicy) -> Result<Self, UpdaterError> {
        let redirect_policy = policy.clone();
        let mut builder = reqwest::Client::builder()
            .user_agent(format!(
                "OpenShell/{} (updater; +https://github.com/{}/{})",
                env!("CARGO_PKG_VERSION"),
                crate::model::DEFAULT_OWNER,
                crate::model::DEFAULT_REPO
            ))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects");
                }
                match redirect_policy.check_url(attempt.url()) {
                    Ok(()) => attempt.follow(),
                    Err(_) => attempt.stop(),
                }
            }));

        builder = match proxy {
            ProxyMode::Off => builder.no_proxy(),
            // reqwest 默认即「跟随系统代理 + 环境变量」
            ProxyMode::System => builder,
            ProxyMode::Env => match env_proxy_url() {
                Some(url) => builder.proxy(reqwest::Proxy::all(&url).map_err(|err| {
                    UpdaterError::new(UpdaterErrorKind::Http, format!("invalid env proxy: {err}"))
                })?),
                None => builder.no_proxy(),
            },
            ProxyMode::Custom { url } => {
                let trimmed = url.trim();
                if trimmed.is_empty() {
                    builder.no_proxy()
                } else {
                    builder.proxy(reqwest::Proxy::all(trimmed).map_err(|err| {
                        UpdaterError::new(
                            UpdaterErrorKind::Http,
                            format!("invalid proxy url: {err}"),
                        )
                    })?)
                }
            }
        };

        let client = builder.build().map_err(|err| {
            UpdaterError::new(
                UpdaterErrorKind::Internal,
                format!("failed to build http client: {err}"),
            )
        })?;
        Ok(Self { client, policy })
    }

    /// 供下载器复用同一个连接池与代理配置。
    pub fn raw(&self) -> &reqwest::Client {
        &self.client
    }
}

#[async_trait]
impl HttpClient for ReqwestClient {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, UpdaterError> {
        let url = self.policy.check(&request.url)?;
        let mut builder = self
            .client
            .get(url)
            // GitHub 推荐显式声明 API 版本；对普通文件下载无影响
            .header("x-github-api-version", "2022-11-28");
        if let Some(etag) = request.etag.as_deref() {
            builder = builder.header("if-none-match", etag);
        }
        if let Some(accept) = request.accept.as_deref() {
            builder = builder.header("accept", accept);
        }

        let response = builder.send().await.map_err(map_reqwest_error)?;
        let status = response.status().as_u16();
        let mut headers = HashMap::new();
        for (name, value) in response.headers().iter() {
            if let Ok(text) = value.to_str() {
                headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
            }
        }

        let bytes = response.bytes().await.map_err(map_reqwest_error)?;
        if bytes.len() > request.max_bytes {
            return Err(UpdaterError::invalid_payload(format!(
                "response exceeded {} bytes",
                request.max_bytes
            )));
        }
        Ok(HttpResponse {
            status,
            headers,
            body: bytes.to_vec(),
        })
    }
}

/// 把 reqwest 错误映射成更新模块的错误分类（下载器也复用）。
pub fn map_reqwest_error(err: reqwest::Error) -> UpdaterError {
    if err.is_timeout() {
        UpdaterError::timeout("request timed out")
    } else if err.is_connect() {
        UpdaterError::network("failed to connect to update server")
    } else if err.is_redirect() {
        UpdaterError::new(
            UpdaterErrorKind::Http,
            "redirect to a host outside the allow list",
        )
    } else {
        UpdaterError::network("network error while contacting update server")
    }
}

fn env_proxy_url() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct FakeClient {
        calls: AtomicU32,
        /// 第 n 次调用返回的响应（按顺序消费，用尽后重复最后一个）
        responses: Vec<Result<HttpResponse, UpdaterError>>,
    }

    #[async_trait]
    impl HttpClient for FakeClient {
        async fn execute(&self, _request: HttpRequest) -> Result<HttpResponse, UpdaterError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
            let slot = index.min(self.responses.len() - 1);
            match &self.responses[slot] {
                Ok(response) => Ok(response.clone()),
                Err(err) => Err(err.clone()),
            }
        }
    }

    fn response(status: u16, headers: &[(&str, &str)], body: &str) -> HttpResponse {
        HttpResponse {
            status,
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
                .collect(),
            body: body.as_bytes().to_vec(),
        }
    }

    fn fast_policy(max_attempts: u32) -> RetryPolicy {
        RetryPolicy {
            max_attempts,
            base_delay_ms: 1,
        }
    }

    #[tokio::test]
    async fn retries_transient_network_errors() {
        let client = FakeClient {
            calls: AtomicU32::new(0),
            responses: vec![
                Err(UpdaterError::network("boom")),
                Ok(response(200, &[], "{\"ok\":true}")),
            ],
        };
        let out = fetch_with_retry(
            &client,
            HttpRequest::json("https://api.github.com/x"),
            fast_policy(3),
        )
        .await
        .expect("second attempt succeeds");
        assert_eq!(out.status, 200);
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let client = FakeClient {
            calls: AtomicU32::new(0),
            responses: vec![Err(UpdaterError::timeout("slow"))],
        };
        let err = fetch_with_retry(
            &client,
            HttpRequest::json("https://api.github.com/x"),
            fast_policy(3),
        )
        .await
        .expect_err("must fail");
        assert_eq!(err.kind, UpdaterErrorKind::Timeout);
        assert_eq!(client.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn reports_rate_limit_with_reset_hint() {
        let client = FakeClient {
            calls: AtomicU32::new(0),
            responses: vec![Ok(response(
                403,
                &[
                    ("x-ratelimit-remaining", "0"),
                    ("x-ratelimit-reset", "9999999999"),
                ],
                "",
            ))],
        };
        let err = fetch_with_retry(
            &client,
            HttpRequest::json("https://api.github.com/x"),
            fast_policy(1),
        )
        .await
        .expect_err("rate limited");
        assert_eq!(err.kind, UpdaterErrorKind::RateLimited);
        assert!(err.reset_at_ms.unwrap_or(0) > 0);
    }

    #[tokio::test]
    async fn does_not_retry_client_errors() {
        let client = FakeClient {
            calls: AtomicU32::new(0),
            responses: vec![Ok(response(404, &[], "not found"))],
        };
        let out = fetch_with_retry(
            &client,
            HttpRequest::json("https://api.github.com/x"),
            fast_policy(3),
        )
        .await
        .expect("404 is surfaced to caller");
        assert_eq!(out.status, 404);
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn host_policy_enforces_https_and_allow_list() {
        let policy = HostPolicy::new(None);
        assert!(policy.check("https://api.github.com/repos/a/b").is_ok());
        assert!(policy
            .check("https://github.com/a/b/releases/download/v1/x.exe")
            .is_ok());
        assert!(policy.check("http://api.github.com/repos/a/b").is_err());
        assert!(policy
            .check("https://evil.example.com/releases/x.exe")
            .is_err());
        // 用户镜像域名需显式配置后才放行
        assert!(policy.check("https://mirror.example.com/x.exe").is_err());
        let mirror = HostPolicy::new(Some("https://mirror.example.com/gh/"));
        assert!(mirror
            .check("https://mirror.example.com/gh/a/x.exe")
            .is_ok());
        assert!(mirror.check("https://other.example.com/x.exe").is_err());
    }

    #[test]
    fn rate_limit_error_prefers_retry_after() {
        let resp = response(429, &[("retry-after", "42")], "");
        let err = rate_limit_error(&resp);
        assert_eq!(err.retry_after_ms, Some(42_000));
        assert_eq!(err.status, Some(429));
    }

    #[tokio::test]
    async fn not_modified_is_returned_to_caller() {
        let client = Arc::new(FakeClient {
            calls: AtomicU32::new(0),
            responses: vec![Ok(response(304, &[("etag", "abc")], ""))],
        });
        let out = fetch_with_retry(
            client.as_ref(),
            HttpRequest::json("https://api.github.com/x").with_etag(Some("abc")),
            fast_policy(3),
        )
        .await
        .expect("304");
        assert!(out.is_not_modified());
        assert_eq!(out.etag().as_deref(), Some("abc"));
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    }
}
