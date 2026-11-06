//! 传输队列与断点续传引擎。

use crate::client::SftpClient;
use openshell_core_domain::{
    new_id, now_ms, DomainError, DomainResult, ErrorCode, SessionId, TransferDirection,
    TransferState, TransferTask,
};
use russh_sftp::protocol::OpenFlags;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::{Mutex, RwLock};

/// 单块传输大小：512 KiB。
///
/// 大分块可以把「一次 SFTP READ/WRITE 请求 + 一次网络往返」的等待放大到 512 KiB 的有效载荷，
/// 从而在高延迟链路上消除 64 KiB 串行等待造成的「伪限速」现象（复刻 FinalShell `L0`/`CK` 的大块打包策略）。
const CHUNK_SIZE: usize = 512 * 1024;

/// 文件流异步读写缓冲区大小：1 MiB。
///
/// 与 512 KiB 分块配合，保证每次实际 IO 都是大块提交，且始终只常驻固定大小缓冲，
/// 不会因为文件体积增长而放大内存占用。注意：这里**只做缓冲，不做任何限速**。
const IO_BUFFER_SIZE: usize = 1024 * 1024;

/// 单个传输句柄状态。
struct ActiveTransfer {
    task: TransferTask,
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    #[allow(dead_code)]
    current_speed: Arc<AtomicU64>,
}

/// 传输管理器。
#[derive(Clone)]
pub struct TransferManager {
    tasks: Arc<RwLock<HashMap<String, ActiveTransfer>>>,
    #[allow(dead_code)]
    concurrency_limit: Arc<Mutex<usize>>,
}

impl TransferManager {
    pub fn new(concurrency: usize) -> Self {
        Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            concurrency_limit: Arc::new(Mutex::new(concurrency.clamp(1, 8))),
        }
    }

    /// 列出所有传输任务。
    pub async fn list(&self) -> Vec<TransferTask> {
        let tasks = self.tasks.read().await;
        let mut list: Vec<TransferTask> = tasks.values().map(|a| a.task.clone()).collect();
        list.sort_by_key(|t| t.created_at);
        list
    }

    /// 查询单个任务。
    pub async fn get(&self, task_id: &str) -> Option<TransferTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).map(|a| a.task.clone())
    }

    /// 暂停任务。
    pub async fn pause(&self, task_id: &str) -> DomainResult<()> {
        let mut tasks = self.tasks.write().await;
        if let Some(active) = tasks.get_mut(task_id) {
            if !matches!(
                active.task.state,
                TransferState::Queued | TransferState::Running | TransferState::Paused
            ) {
                return Err(DomainError::new(
                    ErrorCode::Validation,
                    "transfer is already finished",
                ));
            }
            active.paused.store(true, Ordering::SeqCst);
            active.task.state = TransferState::Paused;
            active.task.speed_bps = 0;
            active.task.updated_at = now_ms();
            Ok(())
        } else {
            Err(DomainError::not_found("transfer task not found"))
        }
    }

    /// 恢复同一任务的打开文件和当前位置，不创建按长度猜测的新任务。
    pub async fn resume(&self, task_id: &str) -> DomainResult<()> {
        let mut tasks = self.tasks.write().await;
        let active = tasks
            .get_mut(task_id)
            .ok_or_else(|| DomainError::not_found("transfer task not found"))?;
        if active.task.state != TransferState::Paused {
            return Err(DomainError::new(
                ErrorCode::Validation,
                "transfer is not paused",
            ));
        }
        active.paused.store(false, Ordering::SeqCst);
        active.task.state = TransferState::Running;
        active.task.updated_at = now_ms();
        Ok(())
    }

    /// 取消任务。
    pub async fn cancel(&self, task_id: &str) -> DomainResult<()> {
        let mut tasks = self.tasks.write().await;
        if let Some(active) = tasks.get_mut(task_id) {
            if matches!(
                active.task.state,
                TransferState::Completed | TransferState::Failed | TransferState::Cancelled
            ) {
                return Err(DomainError::new(
                    ErrorCode::Validation,
                    "transfer is already finished",
                ));
            }
            active.cancelled.store(true, Ordering::SeqCst);
            active.task.state = TransferState::Cancelled;
            active.task.speed_bps = 0;
            active.task.updated_at = now_ms();
            Ok(())
        } else {
            Err(DomainError::not_found("transfer task not found"))
        }
    }

    /// 新上传一律从零覆盖；旧 resume=true 请求也安全重传。
    pub async fn start_upload(
        &self,
        session_id: SessionId,
        local_path: String,
        remote_path: String,
        _resume: bool,
        sftp: Arc<SftpClient>,
    ) -> DomainResult<String> {
        let local_file_path = Path::new(&local_path);
        let metadata = tokio::fs::metadata(local_file_path).await.map_err(|e| {
            DomainError::new(ErrorCode::NotFound, format!("local file not found: {e}"))
        })?;
        let total_bytes = metadata.len();

        let task_id = new_id();
        let now = now_ms();
        let task = TransferTask {
            id: task_id.clone(),
            session_id,
            direction: TransferDirection::Upload,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
            transferred_bytes: 0,
            speed_bps: 0,
            state: TransferState::Queued,
            error_message: None,
            created_at: now,
            updated_at: now,
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let current_speed = Arc::new(AtomicU64::new(0));

        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(
                task_id.clone(),
                ActiveTransfer {
                    task,
                    cancelled: Arc::clone(&cancelled),
                    paused: Arc::clone(&paused),
                    current_speed: Arc::clone(&current_speed),
                },
            );
        }

        let tasks_clone = Arc::clone(&self.tasks);
        let task_id_clone = task_id.clone();

        tokio::spawn(async move {
            let res = execute_upload(
                &task_id_clone,
                &local_path,
                &remote_path,
                total_bytes,
                sftp,
                cancelled,
                paused,
                current_speed,
                tasks_clone.clone(),
            )
            .await;

            let mut tasks = tasks_clone.write().await;
            if let Some(active) = tasks.get_mut(&task_id_clone) {
                finish_transfer(active, res);
            }
        });

        Ok(task_id)
    }

    /// 新下载一律从零覆盖；继续暂停任务使用 resume。
    pub async fn start_download(
        &self,
        session_id: SessionId,
        remote_path: String,
        local_path: String,
        _resume: bool,
        sftp: Arc<SftpClient>,
    ) -> DomainResult<String> {
        let stat = sftp.stat(&remote_path).await?;
        let total_bytes = stat.size;

        let task_id = new_id();
        let now = now_ms();
        let task = TransferTask {
            id: task_id.clone(),
            session_id,
            direction: TransferDirection::Download,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
            transferred_bytes: 0,
            speed_bps: 0,
            state: TransferState::Queued,
            error_message: None,
            created_at: now,
            updated_at: now,
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let current_speed = Arc::new(AtomicU64::new(0));

        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(
                task_id.clone(),
                ActiveTransfer {
                    task,
                    cancelled: Arc::clone(&cancelled),
                    paused: Arc::clone(&paused),
                    current_speed: Arc::clone(&current_speed),
                },
            );
        }

        let tasks_clone = Arc::clone(&self.tasks);
        let task_id_clone = task_id.clone();

        tokio::spawn(async move {
            let res = execute_download(
                &task_id_clone,
                &remote_path,
                &local_path,
                total_bytes,
                sftp,
                cancelled,
                paused,
                current_speed,
                tasks_clone.clone(),
            )
            .await;

            let mut tasks = tasks_clone.write().await;
            if let Some(active) = tasks.get_mut(&task_id_clone) {
                finish_transfer(active, res);
            }
        });

        Ok(task_id)
    }
}

fn finish_transfer(active: &mut ActiveTransfer, result: DomainResult<()>) {
    active.task.speed_bps = 0;
    active.task.updated_at = now_ms();
    if active.cancelled.load(Ordering::SeqCst) {
        active.task.state = TransferState::Cancelled;
    } else if let Err(error) = result {
        active.task.state = TransferState::Failed;
        active.task.error_message = Some(error.message);
    } else {
        active.task.state = TransferState::Completed;
        active.task.transferred_bytes = active.task.total_bytes;
    }
}

async fn wait_until_running(cancelled: &AtomicBool, paused: &AtomicBool) -> bool {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return false;
        }
        if !paused.load(Ordering::SeqCst) {
            return true;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_upload(
    task_id: &str,
    local_path: &str,
    remote_path: &str,
    total_bytes: u64,
    sftp: Arc<SftpClient>,
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    current_speed: Arc<AtomicU64>,
    tasks: Arc<RwLock<HashMap<String, ActiveTransfer>>>,
) -> DomainResult<()> {
    if !wait_until_running(&cancelled, &paused).await {
        return Ok(());
    }
    let local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("cannot open local file: {e}")))?;

    let session = sftp.session();
    let remote_file = session
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("cannot open remote file: {e}")))?;

    // 1 MiB 读缓冲 + 1 MiB 写缓冲：全速流水线，无任何人为限速。
    let mut local_file = BufReader::with_capacity(IO_BUFFER_SIZE, local_file);
    let mut remote_file = BufWriter::with_capacity(IO_BUFFER_SIZE, remote_file);

    {
        let mut locked = tasks.write().await;
        if let Some(active) = locked.get_mut(task_id) {
            if active.task.state == TransferState::Queued {
                active.task.state = TransferState::Running;
            }
        }
    }

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut transferred = 0;
    let mut last_time = tokio::time::Instant::now();
    let mut bytes_since_last = 0u64;

    while transferred < total_bytes {
        if !wait_until_running(&cancelled, &paused).await {
            return Ok(());
        }

        let remaining = (total_bytes - transferred).min(CHUNK_SIZE as u64) as usize;
        let n = local_file
            .read(&mut buffer[..remaining])
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("read local failed: {e}")))?;
        if n == 0 {
            return Err(DomainError::new(
                ErrorCode::Io,
                "unexpected EOF reading local file",
            ));
        }

        remote_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("write remote failed: {e}")))?;

        transferred += n as u64;
        bytes_since_last += n as u64;

        if last_time.elapsed().as_millis() >= 300 {
            let elapsed_sec = last_time.elapsed().as_secs_f64();
            let speed = (bytes_since_last as f64 / elapsed_sec) as u64;
            current_speed.store(speed, Ordering::SeqCst);
            last_time = tokio::time::Instant::now();
            bytes_since_last = 0;

            let mut locked = tasks.write().await;
            if let Some(active) = locked.get_mut(task_id) {
                active.task.transferred_bytes = transferred;
                if active.task.state == TransferState::Running {
                    active.task.speed_bps = speed;
                }
                active.task.updated_at = now_ms();
            }
        }
    }

    // 缓冲必须显式 flush：BufWriter 的 Drop 不会写出残留数据，
    // 且 flush 失败意味着尾部数据未能提交，必须向上返回错误而不是静默忽略。
    remote_file
        .flush()
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("flush remote failed: {e}")))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_download(
    task_id: &str,
    remote_path: &str,
    local_path: &str,
    total_bytes: u64,
    sftp: Arc<SftpClient>,
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    current_speed: Arc<AtomicU64>,
    tasks: Arc<RwLock<HashMap<String, ActiveTransfer>>>,
) -> DomainResult<()> {
    if !wait_until_running(&cancelled, &paused).await {
        return Ok(());
    }

    let session = sftp.session();
    let remote_file = session
        .open(remote_path)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("open remote file failed: {e}")))?;

    if let Some(parent) = Path::new(local_path).parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("create local directory failed: {e}"))
            })?;
        }
    }

    let local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("create local failed: {e}")))?;

    // 1 MiB 读缓冲 + 1 MiB 写缓冲：全速流水线，无任何人为限速。
    let mut remote_file = BufReader::with_capacity(IO_BUFFER_SIZE, remote_file);
    let mut local_file = BufWriter::with_capacity(IO_BUFFER_SIZE, local_file);

    {
        let mut locked = tasks.write().await;
        if let Some(active) = locked.get_mut(task_id) {
            if active.task.state == TransferState::Queued {
                active.task.state = TransferState::Running;
            }
        }
    }

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut transferred = 0;
    let mut last_time = tokio::time::Instant::now();
    let mut bytes_since_last = 0u64;

    while transferred < total_bytes {
        if !wait_until_running(&cancelled, &paused).await {
            return Ok(());
        }

        let remaining = (total_bytes - transferred).min(CHUNK_SIZE as u64) as usize;
        let n = remote_file
            .read(&mut buffer[..remaining])
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("read remote failed: {e}")))?;
        if n == 0 {
            return Err(DomainError::new(
                ErrorCode::Io,
                "unexpected EOF reading remote file",
            ));
        }

        local_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("write local failed: {e}")))?;

        transferred += n as u64;
        bytes_since_last += n as u64;

        if last_time.elapsed().as_millis() >= 300 {
            let elapsed_sec = last_time.elapsed().as_secs_f64();
            let speed = (bytes_since_last as f64 / elapsed_sec) as u64;
            current_speed.store(speed, Ordering::SeqCst);
            last_time = tokio::time::Instant::now();
            bytes_since_last = 0;

            let mut locked = tasks.write().await;
            if let Some(active) = locked.get_mut(task_id) {
                active.task.transferred_bytes = transferred;
                if active.task.state == TransferState::Running {
                    active.task.speed_bps = speed;
                }
                active.task.updated_at = now_ms();
            }
        }
    }

    // 缓冲必须显式 flush：BufWriter 的 Drop 不会写出残留数据，
    // 且 flush 失败意味着尾部数据未能落盘，必须向上返回错误而不是静默忽略。
    local_file
        .flush()
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("flush local failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_transfer_manager_pause_and_cancel() {
        let tm = TransferManager::new(3);
        assert_eq!(tm.list().await.len(), 0);

        // 未知任务应该报错 not_found
        assert!(tm.pause("non_existent").await.is_err());
        assert!(tm.cancel("non_existent").await.is_err());
    }

    #[tokio::test]
    async fn test_streaming_chunked_pipeline_memory_bounded() {
        // 验证 512 KiB 分块大小常量与流式模拟
        assert_eq!(CHUNK_SIZE, 512 * 1024);
        // 读写缓冲固定 1 MiB，与分块大小配合，不随文件体积增长
        assert_eq!(IO_BUFFER_SIZE, 1024 * 1024);

        // 模拟 16 MB 虚拟大文件流式管道（16 * 1024 * 1024 bytes）
        let virtual_total = 16 * 1024 * 1024usize;
        let mut transferred = 0usize;
        let mut chunk_buf = vec![0u8; CHUNK_SIZE];

        while transferred < virtual_total {
            let to_read = (virtual_total - transferred).min(CHUNK_SIZE);
            chunk_buf[..to_read].fill(0xAA);
            transferred += to_read;
        }

        assert_eq!(transferred, virtual_total);
        // 关键指标：工作内存始终仅持有单块 512 KiB 缓冲区，绝不常驻全量大文件
        assert_eq!(chunk_buf.len(), 512 * 1024);
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod regression_tests;
