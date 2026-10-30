//! 服务层集成测试：缓存、ETag/304、限流、强制更新、资产匹配、备用源回退、跳过版本。
//!
//! 全部使用内存假 HTTP 客户端，不访问网络，可在 CI 离线运行。

use openshell_updater::http::{HttpClient, HttpRequest, HttpResponse};
use openshell_updater::{
    async_trait, NotifyDecision, UpdateConfig, UpdateService, UpdaterError, UpdaterErrorKind,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const API_URL: &str = "https://api.github.com/repos/fieecbin-source/openshell/releases/latest";

/// 当前主机可安装的资产名。
///
/// 资源匹配是按「平台 + 架构」打分的，测试若写死 `.exe`，在 Linux/macOS 的 CI 上
/// 会匹配不到资产（`asset == None`）。这里跟随宿主机，保证三个平台都成立。
fn exe_name() -> &'static str {
    if cfg!(windows) {
        "OpenShell-1.1.0-windows-x86_64.exe"
    } else if cfg!(target_os = "macos") {
        "OpenShell-1.1.0-macos-universal.dmg"
    } else {
        "OpenShell-1.1.0-linux-x86_64.AppImage"
    }
}

fn exe_url() -> String {
    format!(
        "https://github.com/fieecbin-source/openshell/releases/download/v1.1.0/{}",
        exe_name()
    )
}
const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const META_URL: &str =
    "https://github.com/fieecbin-source/openshell/releases/download/v1.1.0/update-meta.json";
const SUMS_URL: &str =
    "https://github.com/fieecbin-source/openshell/releases/download/v1.1.0/SHA256SUMS.txt";

/// 按 URL 路由的假客户端；同一 URL 可按调用顺序返回不同响应。
struct RoutedClient {
    routes: Mutex<HashMap<String, Vec<HttpResponse>>>,
    calls: Mutex<Vec<String>>,
}

impl RoutedClient {
    fn new() -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn route(self: &Arc<Self>, url: &str, response: HttpResponse) {
        self.routes
            .lock()
            .unwrap()
            .entry(url.to_string())
            .or_default()
            .push(response);
    }

    /// 用单个响应替换该 URL 的整个队列（模拟「服务端状态已变化」）。
    fn replace_route(self: &Arc<Self>, url: &str, response: HttpResponse) {
        self.routes
            .lock()
            .unwrap()
            .insert(url.to_string(), vec![response]);
    }

    fn call_count(&self, url: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|called| called.as_str() == url)
            .count()
    }
}

#[async_trait]
impl HttpClient for RoutedClient {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, UpdaterError> {
        self.calls.lock().unwrap().push(request.url.clone());
        let mut routes = self.routes.lock().unwrap();
        match routes.get_mut(&request.url) {
            Some(queue) if !queue.is_empty() => {
                if queue.len() > 1 {
                    Ok(queue.remove(0))
                } else {
                    Ok(queue[0].clone())
                }
            }
            _ => Ok(response(404, &[], "not found")),
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

fn release_body(with_windows_asset: bool, notes: &str) -> String {
    let mut assets = vec![
        serde_json::json!({
            "name": "update-meta.json",
            "size": 180,
            "browser_download_url": META_URL
        }),
        serde_json::json!({
            "name": "SHA256SUMS.txt",
            "size": 120,
            "browser_download_url": SUMS_URL
        }),
    ];
    if with_windows_asset {
        assets.push(serde_json::json!({
            "name": exe_name(),
            "size": 52_428_800u64,
            "browser_download_url": exe_url()
        }));
    }
    serde_json::json!({
        "tag_name": "v1.1.0",
        "name": "OpenShell 1.1.0",
        "body": notes,
        "published_at": "2026-10-27T08:00:00Z",
        "draft": false,
        "prerelease": false,
        "html_url": "https://github.com/fieecbin-source/openshell/releases/tag/v1.1.0",
        "assets": assets
    })
    .to_string()
}

fn sums_body() -> String {
    format!("{HASH}  {}\n", exe_name())
}

struct Harness {
    dir: tempfile::TempDir,
    client: Arc<RoutedClient>,
    service: UpdateService,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("temp dir");
    let client = Arc::new(RoutedClient::new());
    let service = UpdateService::with_http(dir.path(), "1.0.1", client.clone()).expect("service");
    Harness {
        dir,
        client,
        service,
    }
}

fn happy_routes(client: &Arc<RoutedClient>) {
    client.route(
        API_URL,
        response(
            200,
            &[("etag", "\"v1\"")],
            &release_body(true, "- 新增自动更新"),
        ),
    );
    client.route(META_URL, response(404, &[], ""));
    client.route(SUMS_URL, response(200, &[], &sums_body()));
}

#[tokio::test]
async fn detects_update_and_resolves_checksum() {
    let h = harness();
    happy_routes(&h.client);

    let outcome = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("check");

    assert!(outcome.result.has_update);
    assert_eq!(outcome.result.current_version, "1.0.1");
    assert_eq!(outcome.result.latest_version, "1.1.0");
    assert_eq!(outcome.result.source, "github");
    assert!(!outcome.from_cache);
    assert_eq!(outcome.decision, NotifyDecision::Notify);
    let asset = outcome.result.asset.expect("asset");
    assert_eq!(asset.name, exe_name());
    assert_eq!(asset.sha256.as_deref(), Some(HASH));
    assert!(asset.is_auto_installable());
    assert!(outcome.result.notes_html.contains("自动更新"));
    // 说明与哈希都取到了，且只请求了必要的地址
    assert_eq!(h.client.call_count(API_URL), 1);
    assert_eq!(h.client.call_count(SUMS_URL), 1);
}

#[tokio::test]
async fn no_update_when_versions_equal() {
    let h = harness();
    h.client.route(
        API_URL,
        response(
            200,
            &[],
            &release_body(true, "").replace("v1.1.0", "v1.0.1"),
        ),
    );
    let outcome = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("check");
    assert!(!outcome.result.has_update);
    assert!(outcome.result.asset.is_none());
    assert_eq!(outcome.decision, NotifyDecision::UpToDate);
}

#[tokio::test]
async fn automatic_check_hits_cache_within_ttl() {
    let h = harness();
    happy_routes(&h.client);

    let first = h
        .service
        .check(&UpdateConfig::default(), false)
        .await
        .expect("first");
    assert!(!first.from_cache);

    let second = h
        .service
        .check(&UpdateConfig::default(), false)
        .await
        .expect("second");
    assert!(second.from_cache);
    assert_eq!(
        h.client.call_count(API_URL),
        1,
        "cache must avoid a second request"
    );

    // 手动检查绕过缓存
    let third = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("third");
    assert!(!third.from_cache);
    assert_eq!(h.client.call_count(API_URL), 2);
}

#[tokio::test]
async fn conditional_request_reuses_cached_result_on_304() {
    let h = harness();
    happy_routes(&h.client);
    h.service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("first check");

    // 第二次强制请求，服务端返回 304（ETag 未变）
    h.client
        .replace_route(API_URL, response(304, &[("etag", "\"v1\"")], ""));
    let outcome = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("second check");
    assert!(outcome.from_cache);
    assert_eq!(h.client.call_count(API_URL), 2);
    assert!(outcome.result.has_update);
    assert_eq!(outcome.result.latest_version, "1.1.0");
}

#[tokio::test]
async fn rate_limited_check_surfaces_retry_hint() {
    let dir = tempfile::tempdir().expect("temp dir");
    let client = Arc::new(RoutedClient::new());
    client.route(
        API_URL,
        response(
            403,
            &[("x-ratelimit-remaining", "0"), ("retry-after", "1")],
            "",
        ),
    );
    let service = UpdateService::with_http(dir.path(), "1.0.1", client).expect("service");
    let err = service
        .check(&UpdateConfig::default(), true)
        .await
        .expect_err("rate limited");
    assert_eq!(err.kind, UpdaterErrorKind::RateLimited);
    assert!(err.retry_after_ms.unwrap_or(0) > 0);

    // 失败也要落一份可诊断的状态，但绝不影响已缓存的数据
    let state = service.state();
    assert!(state.last_error.is_some());
    assert!(state.cached_result.is_none());
}

#[tokio::test]
async fn mandatory_flag_and_minimum_version_from_meta() {
    let h = harness();
    h.client.route(
        API_URL,
        response(200, &[], &release_body(true, "Release 正文")),
    );
    h.client.route(
        META_URL,
        response(
            200,
            &[],
            r#"{"mandatory":false,"min_supported_version":"1.0.5","notes":"- 安全修复，请尽快升级"}"#,
        ),
    );
    h.client.route(SUMS_URL, response(200, &[], &sums_body()));

    let outcome = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("check");
    assert!(outcome.result.mandatory, "current 1.0.1 < min 1.0.5");
    assert_eq!(
        outcome.result.min_supported_version.as_deref(),
        Some("1.0.5")
    );
    // update-meta 的说明优先于 Release 正文
    assert!(outcome.result.notes_html.contains("安全修复"));
    assert!(!outcome.result.notes_html.contains("Release 正文"));
    // 远端强制标记仍尊重用户的跳过选择。
    h.service.skip_version("1.1.0").expect("skip");
    let again = h
        .service
        .check(&UpdateConfig::default(), false)
        .await
        .expect("cached");
    assert_eq!(again.decision, NotifyDecision::Skipped);
}

#[tokio::test]
async fn skipped_version_is_silent_for_automatic_checks_only() {
    let h = harness();
    happy_routes(&h.client);
    h.service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("check");
    h.service.skip_version("1.1.0").expect("skip");

    let auto = h
        .service
        .check(&UpdateConfig::default(), false)
        .await
        .expect("auto");
    assert_eq!(auto.decision, NotifyDecision::Skipped);

    let manual = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("manual");
    assert_eq!(manual.decision, NotifyDecision::Notify);
}

#[tokio::test]
async fn missing_platform_asset_still_returns_notes() {
    let h = harness();
    h.client.route(
        API_URL,
        response(200, &[], &release_body(false, "- 只是说明")),
    );
    h.client.route(META_URL, response(404, &[], ""));

    let outcome = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect("check");
    assert!(outcome.result.has_update);
    assert!(outcome.result.asset.is_none(), "no matching installer");
    assert!(outcome.result.notes_html.contains("只是说明"));
    assert!(!outcome.result.release_page_url.is_empty());
}

#[tokio::test]
async fn falls_back_to_manifest_source_when_github_fails() {
    let h = harness();
    // GitHub 404 不会重试，源链立即尝试备用源
    h.client.route(API_URL, response(404, &[], ""));
    let manifest_url = "https://cdn.jsdelivr.net/gh/fieecbin-source/openshell@updater/latest.json";
    h.client.route(
        manifest_url,
        response(
            200,
            &[],
            &serde_json::json!({
                "version": "1.1.0",
                "tag": "v1.1.0",
                "name": "OpenShell 1.1.0",
                "notes": "- 来自备用源",
                "release_page": "https://github.com/fieecbin-source/openshell/releases/tag/v1.1.0",
                "assets": [{
                    "name": exe_name(),
                    "url": exe_url(),
                    "size": 1024,
                    "sha256": HASH,
                    "platform": "windows",
                    "arch": "x86_64"
                }]
            })
            .to_string(),
        ),
    );

    let config = UpdateConfig {
        fallback_source: Some(manifest_url.to_string()),
        ..Default::default()
    };
    let outcome = h
        .service
        .check(&config, true)
        .await
        .expect("fallback works");
    assert_eq!(outcome.result.source, "manifest");
    assert!(outcome.result.has_update);
    assert_eq!(
        outcome.result.asset.expect("asset").sha256.as_deref(),
        Some(HASH)
    );
    assert!(outcome.result.notes_html.contains("来自备用源"));
}

#[tokio::test]
async fn all_sources_failing_returns_error_and_keeps_state_usable() {
    let h = harness();
    h.client.route(API_URL, response(404, &[], ""));
    // 备用源也 404（默认 jsDelivr 路径）
    let err = h
        .service
        .check(&UpdateConfig::default(), true)
        .await
        .expect_err("all sources failed");
    assert!(matches!(
        err.kind,
        UpdaterErrorKind::NotFound | UpdaterErrorKind::NotConfigured
    ));

    // 失败后仍可正常读取状态（不破坏已有跳过记录等）
    let state = h.service.state();
    assert!(state.cached_result.is_none());
    drop(h.dir);
}
