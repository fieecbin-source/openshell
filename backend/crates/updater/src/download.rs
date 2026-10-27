//! 安装包下载：断点续传、进度/速度回调、取消、磁盘预检、sha256 校验、原子落地。
//!
//! 流程：
//! ```text
//! 预检磁盘 → 打开 .part（续传则 append）→ Range 请求
//!    ├─ 服务端忽略 Range（200）→ 清空 .part 重下一次
//!    └─ 206/200 → 写完 → 校验 sha256 → rename 成正式文件名
//! ```
//! 失败语义：
//! * 取消 / 断网 → 保留 `.part`，下次可续传；
//! * sha256 不匹配 → 删除 `.part`（文件已不可信）；
//! * 磁盘不足 → 不发起请求，直接报 `InsufficientDisk`。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::verify::Verifier;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 除安装包本身外预留的空间（安装器解压、临时文件）。
pub const EXTRA_SPACE_BYTES: u64 = 64 * 1024 * 1024;
/// 空间安全系数：按待下载体积的 120% 计算。
pub const SPACE_MARGIN_PERCENT: u64 = 120;

/// 推送前端的下载进度。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub percent: f64,
    pub bytes_per_sec: f64,
    /// `downloading` / `verifying` / `done`
    pub phase: String,
}

/// 下载任务描述。
#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub url: String,
    pub file_name: String,
    /// 清单里声明的体积（0 表示未知）。
    pub expected_size: u64,
    /// 期望的 sha256（十六进制小写）。
    pub sha256: String,
    /// 下载目录（通常是 `<app_data_dir>/updater/downloads`）。
    pub dest_dir: PathBuf,
}

impl DownloadRequest {
    /// `.part` 临时文件路径。
    pub fn part_path(&self) -> PathBuf {
        self.dest_dir.join(format!("{}.part", self.file_name))
    }

    /// 最终文件路径。
    pub fn final_path(&self) -> PathBuf {
        self.dest_dir.join(&self.file_name)
    }
}

/// 下载结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadOutcome {
    pub path: String,
    pub bytes: u64,
    /// 本次从第几个字节开始续传（0 表示全新下载）。
    pub resumed_from: u64,
}

/// Range 响应元信息。
#[derive(Debug, Clone)]
pub struct RangeMeta {
    pub status: u16,
    pub total_len: Option<u64>,
}

/// 分块读取 HTTP 响应体并写入目标文件（可 mock）。
#[async_trait]
pub trait RangeFetcher: Send + Sync {
    /// `offset > 0` 时应发送 `Range: bytes=<offset>-`。
    /// 每写入一块都要调用 `on_bytes(累计已写入字节数)`，返回 `Err` 时实现应立即停止。
    async fn fetch_to(
        &self,
        url: &str,
        offset: u64,
        dest: &mut tokio::fs::File,
        on_bytes: &(dyn Fn(u64) -> Result<(), UpdaterError> + Send + Sync),
        cancel: &AtomicBool,
    ) -> Result<RangeMeta, UpdaterError>;
}

/// 磁盘剩余空间探测（可 mock，便于测试「磁盘不足」）。
pub trait SpaceProbe: Send + Sync {
    fn available_bytes(&self, dir: &Path) -> Result<u64, UpdaterError>;
}

/// 生产实现：基于 `fs2`。
pub struct FsSpaceProbe;

impl SpaceProbe for FsSpaceProbe {
    fn available_bytes(&self, dir: &Path) -> Result<u64, UpdaterError> {
        fs2::available_space(dir)
            .map_err(|err| UpdaterError::io(format!("failed to read free disk space: {err}")))
    }
}

type ProgressSink = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

/// 下载器。
pub struct Downloader {
    fetcher: Arc<dyn RangeFetcher>,
    space: Arc<dyn SpaceProbe>,
    verifier: Arc<dyn Verifier>,
    cancel: Arc<AtomicBool>,
    progress: ProgressSink,
}

impl Downloader {
    pub fn new(
        fetcher: Arc<dyn RangeFetcher>,
        space: Arc<dyn SpaceProbe>,
        verifier: Arc<dyn Verifier>,
    ) -> Self {
        Self {
            fetcher,
            space,
            verifier,
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_| {}),
        }
    }

    /// 绑定进度回调（Tauri 命令层用来向 Channel 推送）。
    pub fn with_progress(mut self, sink: ProgressSink) -> Self {
        self.progress = sink;
        self
    }

    /// 取消令牌；调用 `store(true)` 后下载会在下一个数据块处停止。
    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// 注入外部取消令牌（IPC 层用单飞门闩统一管理「谁可以叫停当前下载」）。
    ///
    /// 传入的令牌如果已经被置位，下载会在开始前直接返回 [`UpdaterError::cancelled`]。
    pub fn with_cancel(mut self, token: Arc<AtomicBool>) -> Self {
        self.cancel = token;
        self
    }

    /// 执行下载。
    pub async fn download(
        &self,
        request: &DownloadRequest,
    ) -> Result<DownloadOutcome, UpdaterError> {
        if request.file_name.trim().is_empty() || request.file_name.contains(['/', '\\']) {
            return Err(UpdaterError::new(
                UpdaterErrorKind::InvalidPayload,
                "invalid installer file name",
            ));
        }
        tokio::fs::create_dir_all(&request.dest_dir).await?;

        let part = request.part_path();
        let final_path = request.final_path();
        let mut resumed_from = match tokio::fs::metadata(&part).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        // 残缺文件比清单还大 → 必然不可续传，直接重来
        if request.expected_size > 0 && resumed_from > request.expected_size {
            let _ = tokio::fs::remove_file(&part).await;
            resumed_from = 0;
        }

        self.precheck_space(request, resumed_from)?;

        let started = Instant::now();
        let mut attempt = 0u32;

        loop {
            attempt += 1;
            if self.cancel.load(Ordering::SeqCst) {
                return Err(UpdaterError::cancelled());
            }

            let offset = resumed_from;
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part)
                .await?;

            let on_bytes = |written: u64| -> Result<(), UpdaterError> {
                if self.cancel.load(Ordering::SeqCst) {
                    return Err(UpdaterError::cancelled());
                }
                let received = offset + written;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let total = if request.expected_size > 0 {
                    Some(request.expected_size)
                } else {
                    None
                };
                (self.progress)(DownloadProgress {
                    received,
                    total,
                    percent: total
                        .map(|total| (received as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
                        .unwrap_or(0.0),
                    bytes_per_sec: received as f64 / elapsed,
                    phase: "downloading".to_string(),
                });
                Ok(())
            };

            let meta = match self
                .fetcher
                .fetch_to(&request.url, offset, &mut file, &on_bytes, &self.cancel)
                .await
            {
                Ok(meta) => meta,
                Err(err) => {
                    // 取消/网络错误都保留 .part，便于续传
                    return Err(err);
                }
            };
            drop(file);

            if meta.status == 200 && offset > 0 && attempt == 1 {
                // 服务端忽略了 Range：已写入的字节是「追加」的，必须清空重下
                let _ = tokio::fs::remove_file(&part).await;
                resumed_from = 0;
                continue;
            }

            break;
        }

        let written = tokio::fs::metadata(&part).await?.len();
        (self.progress)(DownloadProgress {
            received: written,
            total: Some(written),
            percent: 100.0,
            bytes_per_sec: 0.0,
            phase: "verifying".to_string(),
        });

        if let Err(err) = self.verifier.verify(&part, Some(&request.sha256)) {
            // 哈希不符的文件不能留，避免下次「续传」到一个坏文件上
            let _ = tokio::fs::remove_file(&part).await;
            return Err(err);
        }

        if final_path.exists() {
            let _ = tokio::fs::remove_file(&final_path).await;
        }
        tokio::fs::rename(&part, &final_path).await?;

        (self.progress)(DownloadProgress {
            received: written,
            total: Some(written),
            percent: 100.0,
            bytes_per_sec: 0.0,
            phase: "done".to_string(),
        });

        Ok(DownloadOutcome {
            path: final_path.to_string_lossy().to_string(),
            bytes: written,
            resumed_from,
        })
    }

    fn precheck_space(&self, request: &DownloadRequest, existing: u64) -> Result<(), UpdaterError> {
        let remaining = request.expected_size.saturating_sub(existing);
        if remaining == 0 {
            return Ok(());
        }
        let needed = remaining
            .saturating_mul(SPACE_MARGIN_PERCENT)
            .saturating_div(100)
            .saturating_add(EXTRA_SPACE_BYTES);
        let available = self.space.available_bytes(&request.dest_dir)?;
        if available < needed {
            return Err(UpdaterError::new(
                UpdaterErrorKind::InsufficientDisk,
                "not enough disk space to download the installer",
            )
            .with_details(serde_json::json!({
                "required": needed,
                "available": available,
            }))
            .with_retryable(false));
        }
        Ok(())
    }
}

/// 生产实现：reqwest 流式下载（不缓冲整个安装包，内存占用固定）。
///
/// 与检测用的 `ReqwestClient` 分开构造，因为下载需要「只限制连接超时、不限制总时长」。
pub struct ReqwestFetcher {
    client: reqwest::Client,
    policy: crate::http::HostPolicy,
}

impl ReqwestFetcher {
    pub fn new(
        proxy: &crate::proxy::ProxyMode,
        policy: crate::http::HostPolicy,
    ) -> Result<Self, UpdaterError> {
        let redirect_policy = policy.clone();
        let mut builder = reqwest::Client::builder()
            .user_agent(format!(
                "OpenShell/{} (updater-download)",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(std::time::Duration::from_secs(10))
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
            crate::proxy::ProxyMode::Off => builder.no_proxy(),
            crate::proxy::ProxyMode::System => builder,
            crate::proxy::ProxyMode::Env => builder,
            crate::proxy::ProxyMode::Custom { url } if url.trim().is_empty() => builder.no_proxy(),
            crate::proxy::ProxyMode::Custom { url } => {
                builder.proxy(reqwest::Proxy::all(url.trim()).map_err(|err| {
                    UpdaterError::new(UpdaterErrorKind::Http, format!("invalid proxy url: {err}"))
                })?)
            }
        };
        let client = builder.build().map_err(|err| {
            UpdaterError::internal(format!("failed to build download client: {err}"))
        })?;
        Ok(Self { client, policy })
    }
}

#[async_trait]
impl RangeFetcher for ReqwestFetcher {
    async fn fetch_to(
        &self,
        url: &str,
        offset: u64,
        dest: &mut tokio::fs::File,
        on_bytes: &(dyn Fn(u64) -> Result<(), UpdaterError> + Send + Sync),
        cancel: &AtomicBool,
    ) -> Result<RangeMeta, UpdaterError> {
        use tokio::io::AsyncWriteExt;

        let parsed = self.policy.check(url)?;
        let mut builder = self
            .client
            .get(parsed)
            .header("accept", "application/octet-stream");
        if offset > 0 {
            builder = builder.header("range", format!("bytes={offset}-"));
        }

        let mut response = builder
            .send()
            .await
            .map_err(crate::http::map_reqwest_error)?;
        let status = response.status().as_u16();
        if status == 403 || status == 429 {
            let headers: std::collections::HashMap<String, String> = response
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|v| (k.as_str().to_ascii_lowercase(), v.to_string()))
                })
                .collect();
            return Err(crate::http::rate_limit_error(&crate::http::HttpResponse {
                status,
                headers,
                body: Vec::new(),
            }));
        }
        if status == 416 {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Http,
                "server rejected the resume range",
            )
            .with_status(416));
        }
        if status != 200 && status != 206 {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Http,
                format!("download returned {status}"),
            )
            .with_status(status));
        }

        let total_len = parse_total_len(&response, offset);
        let mut written = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(crate::http::map_reqwest_error)?
        {
            if cancel.load(Ordering::SeqCst) {
                return Err(UpdaterError::cancelled());
            }
            dest.write_all(&chunk).await?;
            written += chunk.len() as u64;
            on_bytes(written)?;
        }
        dest.flush().await?;

        Ok(RangeMeta { status, total_len })
    }
}

/// 从 `Content-Range` 或 `Content-Length` 推断文件总长度。
fn parse_total_len(response: &reqwest::Response, offset: u64) -> Option<u64> {
    if let Some(range) = response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
    {
        // 形如 `bytes 100-499/1234`
        if let Some(total) = range
            .rsplit('/')
            .next()
            .and_then(|t| t.trim().parse::<u64>().ok())
        {
            return Some(total);
        }
    }
    response
        .content_length()
        .map(|length| length.saturating_add(offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify::Sha256Verifier;
    use std::sync::Mutex;

    const HELLO: &[u8] = b"hello world";
    /// sha256("hello world")
    const HELLO_SHA: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    struct MockFetcher {
        payload: Vec<u8>,
        honor_range: bool,
        offsets: Mutex<Vec<u64>>,
        status_override: Option<u16>,
    }

    impl MockFetcher {
        fn new(payload: &[u8]) -> Self {
            Self {
                payload: payload.to_vec(),
                honor_range: true,
                offsets: Mutex::new(Vec::new()),
                status_override: None,
            }
        }

        fn ignoring_range(mut self) -> Self {
            self.honor_range = false;
            self
        }

        fn calls(&self) -> Vec<u64> {
            self.offsets.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RangeFetcher for MockFetcher {
        async fn fetch_to(
            &self,
            _url: &str,
            offset: u64,
            dest: &mut tokio::fs::File,
            on_bytes: &(dyn Fn(u64) -> Result<(), UpdaterError> + Send + Sync),
            _cancel: &AtomicBool,
        ) -> Result<RangeMeta, UpdaterError> {
            use tokio::io::AsyncWriteExt;
            self.offsets.lock().unwrap().push(offset);

            let (body, status) = match (self.honor_range, offset) {
                (true, 0) => (self.payload.as_slice(), self.status_override.unwrap_or(200)),
                (true, off) => (&self.payload[(off as usize).min(self.payload.len())..], 206),
                (false, _) => (self.payload.as_slice(), 200),
            };

            let mut written = 0u64;
            for chunk in body.chunks(4) {
                dest.write_all(chunk).await.expect("write");
                written += chunk.len() as u64;
                on_bytes(written)?;
            }
            dest.flush().await.expect("flush");
            Ok(RangeMeta {
                status,
                total_len: Some(self.payload.len() as u64),
            })
        }
    }

    struct FixedSpace(u64);

    impl SpaceProbe for FixedSpace {
        fn available_bytes(&self, _dir: &Path) -> Result<u64, UpdaterError> {
            Ok(self.0)
        }
    }

    fn request(dir: &Path, sha: &str) -> DownloadRequest {
        DownloadRequest {
            url: "https://github.com/a/b/releases/download/v1/OpenShell.exe".into(),
            file_name: "OpenShell.exe".into(),
            expected_size: HELLO.len() as u64,
            sha256: sha.to_string(),
            dest_dir: dir.to_path_buf(),
        }
    }

    #[tokio::test]
    async fn downloads_and_verifies_fresh_file() {
        let dir = tempfile::tempdir().expect("dir");
        let fetcher = Arc::new(MockFetcher::new(HELLO));
        let downloader = Downloader::new(
            fetcher.clone(),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        let outcome = downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect("download");
        assert_eq!(outcome.resumed_from, 0);
        assert_eq!(outcome.bytes, HELLO.len() as u64);
        assert_eq!(
            std::fs::read(&outcome.path).expect("read"),
            HELLO,
            "content must match"
        );
        assert_eq!(fetcher.calls(), vec![0]);
        assert!(!dir.path().join("OpenShell.exe.part").exists());
    }

    #[tokio::test]
    async fn resumes_from_existing_part_file() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("OpenShell.exe.part"), b"hello ").expect("seed");

        let fetcher = Arc::new(MockFetcher::new(HELLO));
        let downloader = Downloader::new(
            fetcher.clone(),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        let outcome = downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect("resume");
        assert_eq!(outcome.resumed_from, 6);
        assert_eq!(
            fetcher.calls(),
            vec![6],
            "must ask only for the remaining range"
        );
        assert_eq!(std::fs::read(&outcome.path).expect("read"), HELLO);
    }

    #[tokio::test]
    async fn restarts_when_server_ignores_range() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("OpenShell.exe.part"), b"hello ").expect("seed");

        let fetcher = Arc::new(MockFetcher::new(HELLO).ignoring_range());
        let downloader = Downloader::new(
            fetcher.clone(),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        let outcome = downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect("restart");
        assert_eq!(
            fetcher.calls(),
            vec![6, 0],
            "second attempt must start over"
        );
        assert_eq!(std::fs::read(&outcome.path).expect("read"), HELLO);
    }

    #[tokio::test]
    async fn checksum_mismatch_removes_partial_file() {
        let dir = tempfile::tempdir().expect("dir");
        let downloader = Downloader::new(
            Arc::new(MockFetcher::new(HELLO)),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        let err = downloader
            .download(&request(dir.path(), &"0".repeat(64)))
            .await
            .expect_err("mismatch");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
        assert!(!dir.path().join("OpenShell.exe").exists());
        assert!(!dir.path().join("OpenShell.exe.part").exists());
    }

    #[tokio::test]
    async fn insufficient_disk_fails_before_network() {
        let dir = tempfile::tempdir().expect("dir");
        let fetcher = Arc::new(MockFetcher::new(HELLO));
        let downloader = Downloader::new(
            fetcher.clone(),
            Arc::new(FixedSpace(0)),
            Arc::new(Sha256Verifier),
        );
        let err = downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect_err("no space");
        assert_eq!(err.kind, UpdaterErrorKind::InsufficientDisk);
        assert!(fetcher.calls().is_empty(), "must not hit the network");
    }

    #[tokio::test]
    async fn cancel_before_start_is_reported() {
        let dir = tempfile::tempdir().expect("dir");
        let downloader = Downloader::new(
            Arc::new(MockFetcher::new(HELLO)),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        downloader.cancel_token().store(true, Ordering::SeqCst);
        let err = downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect_err("cancelled");
        assert_eq!(err.kind, UpdaterErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn rejects_path_traversal_in_file_name() {
        let dir = tempfile::tempdir().expect("dir");
        let downloader = Downloader::new(
            Arc::new(MockFetcher::new(HELLO)),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        );
        let mut req = request(dir.path(), HELLO_SHA);
        req.file_name = "../evil.exe".into();
        let err = downloader.download(&req).await.expect_err("rejected");
        assert_eq!(err.kind, UpdaterErrorKind::InvalidPayload);
    }

    #[tokio::test]
    async fn progress_reports_percent_and_phase() {
        let dir = tempfile::tempdir().expect("dir");
        let seen: Arc<Mutex<Vec<DownloadProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let downloader = Downloader::new(
            Arc::new(MockFetcher::new(HELLO)),
            Arc::new(FixedSpace(u64::MAX)),
            Arc::new(Sha256Verifier),
        )
        .with_progress(Arc::new(move |progress| {
            sink.lock().unwrap().push(progress);
        }));
        downloader
            .download(&request(dir.path(), HELLO_SHA))
            .await
            .expect("download");
        let events = seen.lock().unwrap();
        assert!(events.iter().any(|e| e.phase == "downloading"));
        assert!(events.iter().any(|e| e.phase == "verifying"));
        assert!(events.iter().any(|e| e.phase == "done"));
        assert!(events.last().expect("last").percent >= 99.0);
    }
}
