//! 更新服务：把「源链 + 缓存 + 策略 + 资产匹配 + 元数据」组装成 UI 唯一依赖的接口。
//!
//! 这一层不实现下载与安装（见 `download` / `install`），只回答两个问题：
//! 1. 有没有新版本？
//! 2. 现在应该用哪种方式提示用户？

use crate::asset::{self, AssetCandidate};
use crate::cache::{StateStore, UpdaterState};
use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::http::{
    fetch_with_retry, HostPolicy, HttpClient, HttpRequest, ReqwestClient, RetryPolicy,
};
use crate::log::UpdateLog;
use crate::meta::{self, ReleaseMetaFile};
use crate::model::{Arch, Channel, Platform, UpdateAsset, UpdateCheckResult, UpdateConfig};
use crate::notes;
use crate::policy::{self, NotifyDecision};
use crate::source::github::GitHubSource;
use crate::source::server::ServerSource;
use crate::source::static_manifest::StaticManifestSource;
use crate::source::{SourceAsset, SourceChain, SourceRelease, SourceRequest};
use crate::version;
use openshell_core_domain::now_ms;
use semver::Version;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 按配置构造 HTTP 客户端（默认跟随系统代理；测试可注入固定实现）。
pub type HttpClientFactory =
    Arc<dyn Fn(&UpdateConfig) -> Result<Arc<dyn HttpClient>, UpdaterError> + Send + Sync>;

/// 一次检查的完整结果。
#[derive(Debug, Clone)]
pub struct CheckOutcome {
    pub result: UpdateCheckResult,
    /// 自动检查时是否应该打扰用户（跳过/稍后提醒/已最新都会静默）。
    pub decision: NotifyDecision,
    /// 是否命中了本地缓存（含 304 条件请求）。
    pub from_cache: bool,
}

enum FetchResult {
    /// 说明与资产列表可能很大，装箱避免让整个枚举跟着变宽。
    Fresh {
        release: Box<SourceRelease>,
        etag: Option<String>,
    },
    NotModified,
}

/// 更新服务句柄；创建代价很低，但建议全局复用以共享状态文件与日志。
pub struct UpdateService {
    dir: PathBuf,
    current_version: Version,
    platform: Platform,
    arch: Arch,
    state_store: StateStore,
    log: UpdateLog,
    http_for: HttpClientFactory,
    retry: RetryPolicy,
}

impl UpdateService {
    /// 生产环境构造：跟随配置里的代理设置。
    pub fn new(dir: impl Into<PathBuf>, current_version: &str) -> Result<Self, UpdaterError> {
        let http_for: HttpClientFactory = Arc::new(|cfg: &UpdateConfig| {
            let policy = HostPolicy::new(cfg.mirror_prefix.as_deref());
            Ok(Arc::new(ReqwestClient::new(&cfg.proxy, policy)?) as Arc<dyn HttpClient>)
        });
        Self::build(dir.into(), current_version, http_for)
    }

    /// 测试/自定义传输：固定使用同一个 `HttpClient`。
    pub fn with_http(
        dir: impl Into<PathBuf>,
        current_version: &str,
        http: Arc<dyn HttpClient>,
    ) -> Result<Self, UpdaterError> {
        let http_for: HttpClientFactory = Arc::new(move |_cfg: &UpdateConfig| Ok(http.clone()));
        Self::build(dir.into(), current_version, http_for)
    }

    fn build(
        dir: PathBuf,
        current_version: &str,
        http_for: HttpClientFactory,
    ) -> Result<Self, UpdaterError> {
        let current = version::normalize(current_version)?;
        let platform = Platform::current().ok_or_else(|| {
            UpdaterError::new(
                UpdaterErrorKind::NotConfigured,
                "updates are not supported on this platform",
            )
        })?;
        Ok(Self {
            state_store: StateStore::new(&dir),
            log: UpdateLog::new(&dir),
            dir,
            current_version: current,
            platform,
            arch: Arch::current(),
            http_for,
            retry: RetryPolicy::default(),
        })
    }

    /// 工作目录（`<app_data_dir>/updater`）。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 日志文件路径（设置页「打开日志目录」使用其父目录）。
    pub fn log(&self) -> &UpdateLog {
        &self.log
    }

    pub fn current_version(&self) -> &Version {
        &self.current_version
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn arch(&self) -> Arch {
        self.arch
    }

    /// 读取持久化状态（跳过列表、缓存、上次检查时间等）。
    pub fn state(&self) -> UpdaterState {
        self.state_store.load()
    }

    /// 检查更新。
    ///
    /// * `manual = true`：用户点击「检查更新」，忽略本地缓存与「稍后提醒」，但仍使用 ETag；
    /// * `manual = false`：后台自动检查，命中 6 小时缓存时直接返回。
    ///
    /// 错误只代表「这次检查没拿到结果」，调用方应静默处理（手动检查才提示）。
    pub async fn check(
        &self,
        config: &UpdateConfig,
        manual: bool,
    ) -> Result<CheckOutcome, UpdaterError> {
        let cfg = config.normalized()?;
        let now = now_ms();
        let mut state = self.state_store.load();

        if !manual {
            if let Some(cached) = state.cached_result.clone() {
                if state.is_fresh(now) {
                    let decision = policy::evaluate(&cached, &state, manual, now);
                    self.log.info(
                        "check_cache_hit",
                        &[("version", cached.latest_version.clone())],
                    );
                    return Ok(CheckOutcome {
                        result: cached,
                        decision,
                        from_cache: true,
                    });
                }
            }
        }

        let http = (self.http_for)(&cfg)?;
        self.log.info(
            "check_start",
            &[
                ("channel", cfg.channel.as_str().to_string()),
                ("manual", manual.to_string()),
                ("repo", format!("{}/{}", cfg.owner, cfg.repo)),
            ],
        );

        let fetched = self.fetch_release(&cfg, http.clone(), &state).await;
        let (release, etag) = match fetched {
            Ok(FetchResult::NotModified) => {
                let Some(cached) = state.cached_result.clone() else {
                    return Err(UpdaterError::invalid_payload(
                        "update source returned 304 but there is no cached result",
                    ));
                };
                state.last_check_at_ms = Some(now);
                state.last_error = None;
                self.state_store.save(&state)?;
                let decision = policy::evaluate(&cached, &state, manual, now);
                self.log.info("check_not_modified", &[]);
                return Ok(CheckOutcome {
                    result: cached,
                    decision,
                    from_cache: true,
                });
            }
            Ok(FetchResult::Fresh { release, etag }) => (release, etag),
            Err(err) => {
                state.last_error = Some(err.message.clone());
                state.last_check_at_ms = Some(now);
                let _ = self.state_store.save(&state);
                self.log.warn(
                    "check_failed",
                    &[
                        ("kind", format!("{:?}", err.kind)),
                        ("status", err.status.unwrap_or(0).to_string()),
                    ],
                );
                return Err(err);
            }
        };

        let result = self
            .build_result(&cfg, http.as_ref(), &release, state.cached_result.is_some())
            .await?;

        // 更新内部状态：缓存结果本身也标记为「非缓存来源」
        let mut stored = result.clone();
        stored.from_cache = false;
        state.last_check_at_ms = Some(now);
        state.etag = etag;
        state.cached_result = Some(stored);
        state.last_error = None;
        policy::prune_skipped(&mut state, &result.latest_version);
        self.state_store.save(&state)?;

        let decision = policy::evaluate(&result, &state, manual, now);
        self.log.info(
            "check_done",
            &[
                ("latest", result.latest_version.clone()),
                ("has_update", result.has_update.to_string()),
                ("mandatory", result.mandatory.to_string()),
                (
                    "asset",
                    result
                        .asset
                        .as_ref()
                        .map(|a| a.name.clone())
                        .unwrap_or_default(),
                ),
            ],
        );
        Ok(CheckOutcome {
            result,
            decision,
            from_cache: false,
        })
    }

    /// 记录「跳过此版本」，并取消稍后提醒。
    pub fn skip_version(&self, latest_version: &str) -> Result<UpdaterState, UpdaterError> {
        let mut state = self.state_store.load();
        policy::skip_version(&mut state, latest_version);
        self.state_store.save(&state)?;
        self.log
            .info("skip_version", &[("version", latest_version.to_string())]);
        Ok(state)
    }

    /// 记录「稍后提醒」。
    pub fn remind_later(&self, hours: Option<u32>) -> Result<UpdaterState, UpdaterError> {
        let mut state = self.state_store.load();
        policy::remind_later(&mut state, now_ms(), hours);
        self.state_store.save(&state)?;
        self.log.info(
            "remind_later",
            &[("deadline", state.remind_after_ms.unwrap_or(0).to_string())],
        );
        Ok(state)
    }

    /// 记录「已下载待安装」的文件路径（重启后仍能恢复「待安装」状态）。
    ///
    /// 传 `None` 表示清除（安装成功、取消下载或校验失败后调用）。
    pub fn set_pending_install(&self, path: Option<&str>) -> Result<UpdaterState, UpdaterError> {
        let mut state = self.state_store.load();
        state.pending_install_path = path.map(str::to_string);
        self.state_store.save(&state)?;
        Ok(state)
    }

    /// 取消所有跳过记录（设置页「恢复被跳过的版本提示」）。
    pub fn clear_skipped(&self) -> Result<UpdaterState, UpdaterError> {
        let mut state = self.state_store.load();
        state.skipped_versions.clear();
        state.remind_after_ms = None;
        self.state_store.save(&state)?;
        Ok(state)
    }

    async fn fetch_release(
        &self,
        cfg: &UpdateConfig,
        http: Arc<dyn HttpClient>,
        state: &UpdaterState,
    ) -> Result<FetchResult, UpdaterError> {
        let chain = self.build_chain(cfg, http);
        let mut request = SourceRequest {
            channel: cfg.channel,
            etag: state.etag.clone(),
        };

        let outcome = chain.fetch(&request).await?;
        if outcome.outcome.not_modified {
            return Ok(FetchResult::NotModified);
        }
        let etag = outcome.outcome.etag;

        let release = match outcome.outcome.release {
            Some(release) => release,
            // 测试通道没有任何预发布版本时回落到稳定版，而不是报「没有更新」
            None if cfg.channel == Channel::Beta => {
                request.channel = Channel::Stable;
                request.etag = None;
                chain
                    .fetch(&request)
                    .await?
                    .outcome
                    .release
                    .ok_or_else(|| {
                        UpdaterError::new(
                            UpdaterErrorKind::NotFound,
                            "no published release was found",
                        )
                    })?
            }
            None => {
                return Err(UpdaterError::new(
                    UpdaterErrorKind::NotFound,
                    "no published release was found",
                ))
            }
        };

        Ok(FetchResult::Fresh {
            release: Box::new(release),
            etag,
        })
    }

    fn build_chain(&self, cfg: &UpdateConfig, http: Arc<dyn HttpClient>) -> SourceChain {
        let mut sources: Vec<Arc<dyn crate::source::UpdateSource>> = vec![Arc::new(
            GitHubSource::new(http.clone(), cfg.owner.clone(), cfg.repo.clone()),
        )];
        if let Some(url) = cfg.fallback_url() {
            sources.push(Arc::new(StaticManifestSource::new(http.clone(), url)));
        }
        // 预留的自有服务端源：当前永远返回 NotConfigured，源链会自动跳过。
        sources.push(Arc::new(ServerSource::new(String::new())));
        SourceChain::new(sources)
    }

    async fn build_result(
        &self,
        cfg: &UpdateConfig,
        http: &dyn HttpClient,
        release: &SourceRelease,
        had_cache: bool,
    ) -> Result<UpdateCheckResult, UpdaterError> {
        let latest = version::normalize(&release.tag)?;
        let declared = self.fetch_release_meta(http, release).await;

        let min_supported = declared
            .as_ref()
            .and_then(|meta| meta.min_supported_version.clone())
            .or_else(|| release.meta.min_supported_version.clone());

        let notes_markdown = declared
            .as_ref()
            .and_then(|meta| meta.notes.clone())
            .or_else(|| release.meta.notes_markdown.clone())
            .unwrap_or_else(|| release.notes_markdown.clone());

        let has_update =
            version::is_update_available(&latest, &self.current_version, cfg.allow_downgrade);

        let declared_mandatory = release.meta.mandatory
            || declared
                .as_ref()
                .map(|meta| meta.mandatory)
                .unwrap_or(false);
        let mandatory = policy::is_mandatory(
            &self.current_version.to_string(),
            declared_mandatory,
            min_supported.as_deref(),
        );

        let asset = if has_update {
            self.resolve_asset(http, release, &latest, declared.as_ref())
                .await
        } else {
            None
        };

        Ok(UpdateCheckResult {
            has_update,
            current_version: self.current_version.to_string(),
            latest_version: latest.to_string(),
            tag: release.tag.clone(),
            release_name: if release.name.is_empty() {
                format!("OpenShell {}", latest)
            } else {
                release.name.clone()
            },
            release_notes: notes_markdown.clone(),
            notes_html: notes::render(&notes_markdown),
            published_at: release.published_at.clone(),
            asset,
            mandatory,
            min_supported_version: min_supported,
            channel: cfg.channel,
            from_cache: had_cache,
            release_page_url: if release.html_url.is_empty() {
                cfg.release_page_url()
            } else {
                release.html_url.clone()
            },
            source: release.source.to_string(),
            checked_at_ms: now_ms(),
        })
    }

    async fn resolve_asset(
        &self,
        http: &dyn HttpClient,
        release: &SourceRelease,
        latest: &Version,
        declared: Option<&ReleaseMetaFile>,
    ) -> Option<UpdateAsset> {
        let mut chosen = match self.select_asset(release, latest) {
            Ok(candidate) => candidate,
            Err(err) => {
                // 匹配不到不等价于「检查失败」：仍展示更新说明，让用户手动下载
                self.log.warn(
                    "asset_not_found",
                    &[
                        ("platform", self.platform.as_str().to_string()),
                        ("arch", self.arch.as_str().to_string()),
                        (
                            "expected",
                            err.details
                                .as_ref()
                                .and_then(|d| d.get("expected"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        ),
                    ],
                );
                return None;
            }
        };

        self.enrich_sha256(http, release, &mut chosen, declared)
            .await;
        Some(UpdateAsset {
            name: chosen.name,
            url: chosen.url,
            size: chosen.size,
            sha256: chosen.sha256,
        })
    }

    fn select_asset(
        &self,
        release: &SourceRelease,
        latest: &Version,
    ) -> Result<AssetCandidate, UpdaterError> {
        // latest.json 可能显式声明 platform/arch：此时优先按声明过滤
        let declared = release
            .assets
            .iter()
            .any(|asset| asset.platform.is_some() || asset.arch.is_some());
        if declared {
            let filtered: Vec<&SourceAsset> = release
                .assets
                .iter()
                .filter(|asset| {
                    let platform_ok = asset
                        .platform
                        .as_deref()
                        .and_then(Platform::parse)
                        .is_none_or(|value| value == self.platform);
                    let arch_ok = asset
                        .arch
                        .as_deref()
                        .and_then(Arch::parse)
                        .is_none_or(|value| self.arch.accepts(value));
                    platform_ok && arch_ok
                })
                .collect();
            if filtered.len() == 1 {
                let asset = filtered[0];
                return Ok(
                    AssetCandidate::new(asset.name.clone(), asset.url.clone(), asset.size)
                        .with_sha256(asset.sha256.as_deref().and_then(meta::normalize_sha256)),
                );
            }
        }

        let candidates: Vec<AssetCandidate> = release
            .assets
            .iter()
            .map(|asset| {
                AssetCandidate::new(asset.name.clone(), asset.url.clone(), asset.size)
                    .with_sha256(asset.sha256.as_deref().and_then(meta::normalize_sha256))
            })
            .collect();
        asset::pick(&candidates, self.platform, self.arch, latest)
    }

    async fn fetch_release_meta(
        &self,
        http: &dyn HttpClient,
        release: &SourceRelease,
    ) -> Option<ReleaseMetaFile> {
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case("update-meta.json"))?;
        match fetch_with_retry(http, HttpRequest::json(asset.url.clone()), self.retry).await {
            Ok(response) if response.is_success() => {
                match meta::parse_update_meta(&response.body) {
                    Ok(parsed) => Some(parsed),
                    Err(err) => {
                        self.log.warn("meta_invalid", &[("error", err.message)]);
                        None
                    }
                }
            }
            Ok(response) => {
                self.log.warn(
                    "meta_http_error",
                    &[("status", response.status.to_string())],
                );
                None
            }
            Err(err) => {
                self.log
                    .warn("meta_fetch_failed", &[("kind", format!("{:?}", err.kind))]);
                None
            }
        }
    }

    async fn enrich_sha256(
        &self,
        http: &dyn HttpClient,
        release: &SourceRelease,
        chosen: &mut AssetCandidate,
        declared: Option<&ReleaseMetaFile>,
    ) {
        if chosen.sha256.is_some() {
            return;
        }
        if let Some(meta) = declared {
            if let Some(hash) = meta.sha256_map().get(&chosen.name) {
                chosen.sha256 = Some(hash.clone());
                return;
            }
        }
        let Some(sums) = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case("SHA256SUMS.txt"))
        else {
            return;
        };
        match fetch_with_retry(http, HttpRequest::text(sums.url.clone()), self.retry).await {
            Ok(response) if response.is_success() => {
                let map = meta::parse_sha256sums(&response.text());
                chosen.sha256 = meta::lookup_sha256(&map, &chosen.name);
            }
            Ok(response) => self.log.warn(
                "sums_http_error",
                &[("status", response.status.to_string())],
            ),
            Err(err) => self
                .log
                .warn("sums_fetch_failed", &[("kind", format!("{:?}", err.kind))]),
        }
    }
}
