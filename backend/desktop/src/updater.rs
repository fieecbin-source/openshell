//! 更新相关 IPC 命令（`updater_*`）。
//!
//! 这一层只做三件事：把前端配置映射成 `UpdateConfig`、调用 `openshell-updater` 的
//! 纯逻辑、把结果/错误转成统一 IPC 形态。任何检测/下载/安装策略都不在这里实现。

use crate::error::IpcError;
use openshell_app_core::{AppServices, APP_VERSION};
use openshell_store::backup::{BackupInfo, BackupReason};
use openshell_updater::download::{
    DownloadOutcome, DownloadProgress, DownloadRequest, Downloader, FsSpaceProbe, ReqwestFetcher,
};
use openshell_updater::http::HostPolicy;
use openshell_updater::install::plugin_updater::PluginUpdater;
use openshell_updater::install::self_install::{SelfInstall, SystemCommandRunner};
use openshell_updater::install::{InstallContext, InstallManager, InstallOutcome, StrategyKind};
use openshell_updater::model::{UpdateAsset, UpdateCheckResult, UpdateConfig};
use openshell_updater::policy::NotifyDecision;
use openshell_updater::{
    validate_installer, ExitDecision, InstallGate, Sha256Verifier, SingleFlight, UpdateService,
    UpdaterError,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri_plugin_opener::OpenerExt;

/// 更新模块的托管状态（进程内单例）。
pub struct UpdaterHandle {
    service: Arc<UpdateService>,
    /// 下载单飞门闩：同一时刻只允许一个下载任务，重复下载会取代旧任务。
    downloads: SingleFlight,
    /// 安装闸门：连续点击「立即安装」不会并行执行两次安装。
    installs: InstallGate,
    data_dir: PathBuf,
    updater_dir: PathBuf,
    backups_dir: PathBuf,
}

impl UpdaterHandle {
    pub fn new(
        data_dir: PathBuf,
        updater_dir: PathBuf,
        backups_dir: PathBuf,
    ) -> Result<Self, UpdaterError> {
        // 版本号来自编译期（与 `frontend/package.json` 由 scripts/version.mjs 保持一致）
        let service = Arc::new(UpdateService::new(&updater_dir, APP_VERSION)?);
        Ok(Self {
            service,
            downloads: SingleFlight::new(),
            installs: InstallGate::new(),
            data_dir,
            updater_dir,
            backups_dir,
        })
    }

    pub fn service(&self) -> &UpdateService {
        &self.service
    }

    fn download_dir(&self) -> PathBuf {
        self.updater_dir.join("downloads")
    }
}

// ==========================================
// DTO
// ==========================================

/// 迁移恢复信息（前端据此显示「数据已从备份恢复」横幅）。
#[derive(Debug, Serialize)]
pub struct RecoveryView {
    pub backup_path: String,
    pub created_at_ms: i64,
    pub reason: Option<String>,
}

/// `updater_get_state` 的返回值：UI 首屏所需的全部只读状态。
#[derive(Debug, Serialize)]
pub struct UpdaterStateView {
    pub current_version: String,
    pub target: String,
    pub arch: String,
    pub schema_version: u32,
    pub data_dir: String,
    pub updater_dir: String,
    pub backups_dir: String,
    pub skipped_versions: Vec<String>,
    pub last_check_at_ms: Option<i64>,
    pub remind_after_ms: Option<i64>,
    pub last_error: Option<String>,
    pub pending_install_path: Option<String>,
    pub recovery: Option<RecoveryView>,
}

/// 一次检查的结果（含「是否应该打扰用户」的判定）。
#[derive(Debug, Serialize)]
pub struct CheckView {
    pub result: UpdateCheckResult,
    pub decision: NotifyDecision,
    pub from_cache: bool,
}

/// 安装结果（前端在应用退出前展示备份路径与手动提示）。
#[derive(Debug, Serialize)]
pub struct InstallView {
    /// 序列化为 `self_install` / `plugin_updater`。
    pub strategy: StrategyKind,
    pub launched: bool,
    pub backup_path: Option<String>,
    pub manual_hint: Option<String>,
}

// ==========================================
// 状态与检查
// ==========================================

#[tauri::command]
pub async fn updater_get_state(
    app: tauri::State<'_, Arc<AppServices>>,
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<UpdaterStateView, IpcError> {
    let state = updater.service().state();
    let migration = &app.migration;
    Ok(UpdaterStateView {
        current_version: updater.service().current_version().to_string(),
        target: updater.service().platform().as_str().to_string(),
        arch: updater.service().arch().as_str().to_string(),
        schema_version: migration.schema_version,
        data_dir: updater.data_dir.to_string_lossy().to_string(),
        updater_dir: updater.updater_dir.to_string_lossy().to_string(),
        backups_dir: updater.backups_dir.to_string_lossy().to_string(),
        skipped_versions: state.skipped_versions,
        last_check_at_ms: state.last_check_at_ms,
        remind_after_ms: state.remind_after_ms,
        last_error: state.last_error,
        pending_install_path: state.pending_install_path,
        recovery: migration.recovered_from.as_ref().map(|info| RecoveryView {
            backup_path: info.path.clone(),
            created_at_ms: info.created_at_ms,
            reason: migration.recovery_reason.clone(),
        }),
    })
}

/// 检查更新；`force = true` 表示用户手动点击，忽略缓存与「稍后提醒」。
#[tauri::command]
pub async fn updater_check(
    updater: tauri::State<'_, UpdaterHandle>,
    config: UpdateConfig,
    force: Option<bool>,
) -> Result<CheckView, IpcError> {
    let outcome = updater
        .service()
        .check(&config, force.unwrap_or(false))
        .await?;
    Ok(CheckView {
        result: outcome.result,
        decision: outcome.decision,
        from_cache: outcome.from_cache,
    })
}

#[tauri::command]
pub async fn updater_skip_version(
    updater: tauri::State<'_, UpdaterHandle>,
    version: String,
) -> Result<(), IpcError> {
    updater.service().skip_version(&version)?;
    Ok(())
}

#[tauri::command]
pub async fn updater_remind_later(
    updater: tauri::State<'_, UpdaterHandle>,
    hours: Option<u32>,
) -> Result<(), IpcError> {
    updater.service().remind_later(hours)?;
    Ok(())
}

#[tauri::command]
pub async fn updater_clear_skipped(
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<(), IpcError> {
    updater.service().clear_skipped()?;
    Ok(())
}

// ==========================================
// 下载
// ==========================================

#[tauri::command]
pub async fn updater_download(
    updater: tauri::State<'_, UpdaterHandle>,
    config: UpdateConfig,
    asset: UpdateAsset,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<DownloadOutcome, IpcError> {
    // 没有哈希就不允许自动下载：装了来路不明的包比不更新更危险
    let Some(sha256) = asset.sha256.clone().filter(|value| value.len() == 64) else {
        return Err(UpdaterError::new(
            openshell_updater::UpdaterErrorKind::NotConfigured,
            "release does not publish a sha256 checksum; please download manually",
        )
        .into());
    };

    let policy = HostPolicy::new(config.mirror_prefix.as_deref());
    let fetcher = Arc::new(ReqwestFetcher::new(&config.proxy, policy)?);

    // 单飞门闩：新任务会让上一个任务停下，避免两个任务写同一个 .part
    let flight = updater.downloads.start();

    let channel = on_progress;
    let downloader = Downloader::new(fetcher, Arc::new(FsSpaceProbe), Arc::new(Sha256Verifier))
        .with_progress(Arc::new(move |progress: DownloadProgress| {
            if let Err(err) = channel.send(progress) {
                tracing::debug!(error = %err, "download progress channel closed");
            }
        }))
        // 取消令牌由门闩统一持有，`updater_cancel_download` 才能真的叫停流式写入
        .with_cancel(flight.clone());

    let request = DownloadRequest {
        url: asset.url.clone(),
        file_name: asset.name.clone(),
        expected_size: asset.size,
        sha256,
        dest_dir: updater.download_dir(),
    };

    let outcome = downloader.download(&request).await;
    // 只释放自己的令牌：若期间已开始了新下载，这里不能把新任务的门闩清掉
    updater.downloads.finish(&flight);

    let outcome = outcome?;
    updater.service().set_pending_install(Some(&outcome.path))?;
    Ok(outcome)
}

#[tauri::command]
pub async fn updater_cancel_download(
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<(), IpcError> {
    updater.downloads.cancel();
    updater.service().set_pending_install(None)?;
    Ok(())
}

// ==========================================
// 安装
// ==========================================

#[tauri::command]
pub async fn updater_install(
    app: tauri::State<'_, Arc<AppServices>>,
    app_handle: tauri::AppHandle,
    updater: tauri::State<'_, UpdaterHandle>,
    path: String,
    asset: UpdateAsset,
    version: String,
) -> Result<InstallView, IpcError> {
    // 幂等/互斥：连点两次「立即安装」或前端重试风暴时，第二次直接失败，
    // 而不是并发跑两个安装器（凭证在函数结束时自动释放）
    let _permit = updater.installs.try_enter()?;

    let asset_path = PathBuf::from(&path);
    // 二次校验：文件在磁盘上可能被替换或截断，安装前必须再算一次哈希。
    // 校验通过后不再插入任何可能让用户触碰文件的 IO，直接进入安装器拉起（TOCTOU 窗口最小化）。
    validate_installer(&asset_path, &asset)?;

    let manager = InstallManager::new(vec![
        Arc::new(PluginUpdater),
        Arc::new(SelfInstall::for_current_process(Arc::new(
            SystemCommandRunner,
        ))),
    ]);
    let strategy = manager.select(&asset)?;

    // 安装前快照：拿不到就中止安装（连接数据绝不能丢）
    let services = app.inner().clone();
    let prepare = move || -> Result<String, UpdaterError> {
        services
            .backup_now(BackupReason::PreInstall)
            .map(|info| info.path)
            .map_err(|err| UpdaterError::io(err.message))
    };

    let ctx = InstallContext {
        asset_path: &asset_path,
        asset_name: &asset.name,
        version: &version,
        log_dir: &updater.updater_dir,
        prepare: Some(&prepare),
        // 便携版不能运行安装器，只能提示用户手动替换（数据目录不会被覆盖）
        portable: crate::commands::is_portable(),
    };
    let outcome = strategy.install(&ctx).await?;
    let _ = updater.service().set_pending_install(None);

    match ExitDecision::for_outcome(&outcome) {
        ExitDecision::ExitApp { delay_ms } => {
            // 留出时间把 IPC 结果送回前端，再退出让安装器接管进程
            let handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                handle.exit(0);
            });
        }
        // 需要用户手动完成（例如 macOS 拖入「应用程序」）时保持运行，不要闪退
        ExitDecision::StayOpen => {}
    }

    Ok(to_install_view(outcome))
}

fn to_install_view(outcome: InstallOutcome) -> InstallView {
    InstallView {
        strategy: outcome.strategy,
        launched: outcome.launched,
        backup_path: outcome.backup_path,
        manual_hint: outcome.manual_hint,
    }
}

// ==========================================
// 备份与目录
// ==========================================

#[tauri::command]
pub async fn updater_backup_now(
    app: tauri::State<'_, Arc<AppServices>>,
    reason: Option<String>,
) -> Result<BackupInfo, IpcError> {
    let reason = reason
        .as_deref()
        .and_then(BackupReason::parse)
        .unwrap_or(BackupReason::Manual);
    let info = app.backup_now(reason)?;
    Ok(info)
}

#[tauri::command]
pub async fn updater_list_backups(
    app: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<BackupInfo>, IpcError> {
    Ok(app.list_backups()?)
}

#[tauri::command]
pub async fn updater_open_release_page(
    app_handle: tauri::AppHandle,
    config: Option<UpdateConfig>,
) -> Result<(), IpcError> {
    let url = config.unwrap_or_default().release_page_url();
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|err| UpdaterError::internal(format!("failed to open release page: {err}")))?;
    Ok(())
}

#[tauri::command]
pub async fn updater_open_log_dir(
    app_handle: tauri::AppHandle,
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<(), IpcError> {
    let file = updater.service().log().file_path().to_path_buf();
    let dir = file.parent().unwrap_or(&updater.updater_dir).to_path_buf();
    std::fs::create_dir_all(&dir).map_err(UpdaterError::from)?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| UpdaterError::internal(format!("failed to open log dir: {err}")))?;
    Ok(())
}

/// 打开「已下载的安装包」目录（安装失败/便携版时让用户手动处理）。
#[tauri::command]
pub async fn updater_open_download_dir(
    app_handle: tauri::AppHandle,
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<(), IpcError> {
    let dir = updater.download_dir();
    std::fs::create_dir_all(&dir).map_err(UpdaterError::from)?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| UpdaterError::internal(format!("failed to open download dir: {err}")))?;
    Ok(())
}

#[tauri::command]
pub async fn updater_open_backup_dir(
    app_handle: tauri::AppHandle,
    updater: tauri::State<'_, UpdaterHandle>,
) -> Result<(), IpcError> {
    std::fs::create_dir_all(&updater.backups_dir).map_err(UpdaterError::from)?;
    app_handle
        .opener()
        .open_path(
            updater.backups_dir.to_string_lossy().to_string(),
            None::<&str>,
        )
        .map_err(|err| UpdaterError::internal(format!("failed to open backup dir: {err}")))?;
    Ok(())
}
