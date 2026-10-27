//! 自研安装策略：退出应用 → 运行安装包。
//!
//! 各平台行为：
//! * **Windows**：NSIS `.exe` 加 `/S` 静默安装（当前用户级，不触发 UAC）；
//!   `.msi` 走 `msiexec /i … /qn /norestart`（需要管理员权限，失败会提示手动安装）。
//! * **macOS**：打开 `.dmg` 让用户把 App 拖进「应用程序」（未公证的包无法静默替换，
//!   详见 docs/UPDATE.md「完整性保障与已知限制」），安装后由用户重新启动。
//! * **Linux**：`.AppImage` 直接替换当前可执行文件并重启；`.deb` 用
//!   `pkexec dpkg -i`（没有 polkit 时提示手动执行）。
//!
//! 命令构造与命令执行分离（[`plan_install`] 是纯函数），因此可以完整离线单测。

use super::{InstallContext, InstallOutcome, InstallStrategy, StrategyKind};
use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::{Platform, UpdateAsset};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 一次外部命令调用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
}

impl Invocation {
    fn new(program: impl Into<String>, args: &[&str]) -> Self {
        Self {
            program: program.into(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }

    fn with_path(program: impl Into<String>, args: &[&str], path: &Path) -> Self {
        let mut invocation = Self::new(program, args);
        invocation.args.push(path.to_string_lossy().to_string());
        invocation
    }

    /// 程序本身就是待执行的安装包路径。
    fn program_path(path: &Path, args: &[&str]) -> Self {
        Self {
            program: path.to_string_lossy().to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }
}

/// 安装计划的一步。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanStep {
    /// 运行并等待结束（失败即中止安装）。
    Run(Invocation),
    /// 拉起后立即返回（应用随即退出，安装器继续执行）。
    Spawn(Invocation),
    /// 用新文件就地替换（AppImage 自更新的唯一可行做法）。
    Replace { from: PathBuf, to: PathBuf },
}

/// 命令执行抽象（测试注入假实现，绝不执行真实安装）。
pub trait CommandRunner: Send + Sync {
    fn run(&self, invocation: &Invocation) -> Result<(), UpdaterError>;
    fn spawn_detached(&self, invocation: &Invocation) -> Result<(), UpdaterError>;
}

/// 生产实现：`std::process::Command`。
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
        let status = std::process::Command::new(&invocation.program)
            .args(&invocation.args)
            .status()
            .map_err(|err| {
                UpdaterError::new(
                    UpdaterErrorKind::Install,
                    format!("failed to run installer step: {err}"),
                )
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(UpdaterError::new(
                UpdaterErrorKind::Install,
                format!("installer step exited with {}", status.code().unwrap_or(-1)),
            ))
        }
    }

    fn spawn_detached(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
        std::process::Command::new(&invocation.program)
            .args(&invocation.args)
            .spawn()
            .map_err(|err| {
                UpdaterError::new(
                    UpdaterErrorKind::Install,
                    format!("failed to launch installer: {err}"),
                )
            })?;
        Ok(())
    }
}

/// 构造某平台的安装步骤（纯函数）。
pub fn plan_install(
    platform: Platform,
    asset_path: &Path,
    exe_path: Option<&Path>,
) -> Result<Vec<PlanStep>, UpdaterError> {
    let ext = extension_of(asset_path);
    let unsupported = || {
        UpdaterError::new(
            UpdaterErrorKind::Install,
            "installer type is not supported on this platform",
        )
        .with_details(serde_json::json!({
            "platform": platform.as_str(),
            "file": asset_path.file_name().and_then(|n| n.to_str()),
        }))
        .with_retryable(false)
    };

    match (platform, ext.as_deref()) {
        (Platform::Windows, Some("exe")) => Ok(vec![PlanStep::Spawn(Invocation::program_path(
            asset_path,
            &["/S"],
        ))]),
        (Platform::Windows, Some("msi")) => {
            let mut invocation = Invocation::new("msiexec", &["/i"]);
            invocation
                .args
                .push(asset_path.to_string_lossy().to_string());
            invocation
                .args
                .extend(["/qn".to_string(), "/norestart".to_string()]);
            Ok(vec![PlanStep::Spawn(invocation)])
        }
        (Platform::Macos, Some("dmg")) => Ok(vec![PlanStep::Spawn(Invocation::with_path(
            "open",
            &[],
            asset_path,
        ))]),
        (Platform::Linux, Some("appimage")) => {
            let Some(target) = exe_path else {
                return Err(UpdaterError::new(
                    UpdaterErrorKind::Install,
                    "cannot self-replace AppImage without a running executable path",
                ));
            };
            Ok(vec![
                PlanStep::Replace {
                    from: asset_path.to_path_buf(),
                    to: target.to_path_buf(),
                },
                PlanStep::Spawn(Invocation::program_path(target, &[])),
            ])
        }
        (Platform::Linux, Some("deb")) => {
            let mut invocation = Invocation::new("pkexec", &["dpkg", "-i"]);
            invocation
                .args
                .push(asset_path.to_string_lossy().to_string());
            Ok(vec![PlanStep::Run(invocation)])
        }
        _ => Err(unsupported()),
    }
}

/// macOS 需要用户手动完成最后一步（拖入「应用程序」）。
///
/// 有提示语意味着「安装最后一步要靠用户」，此时绝不能退出应用，
/// 否则用户会看到「点了更新，程序消失了」。
pub fn manual_hint(platform: Platform, asset_path: &Path) -> Option<String> {
    match (platform, extension_of(asset_path).as_deref()) {
        (Platform::Macos, Some("dmg")) => Some(
            "已为你打开安装镜像：请把 OpenShell 拖入「应用程序」，然后重新启动客户端。已下载的安装包不会自动删除。"
                .to_string(),
        ),
        _ => None,
    }
}

/// 安装失败时的兜底提示（附在该平台的错误 `details.hint` 上，供 UI 展示「手动安装」）。
pub fn fallback_hint(platform: Platform, asset_path: &Path) -> Option<String> {
    match (platform, extension_of(asset_path).as_deref()) {
        // 没有 polkit / 用户取消授权时 pkexec 会失败，直接把命令给出来
        (Platform::Linux, Some("deb")) => Some(format!(
            "需要管理员权限。若没有弹出授权窗口，请在终端手动执行：sudo dpkg -i {}",
            asset_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
        )),
        (Platform::Linux, Some("appimage")) => Some(
            "当前目录不可写。请把安装包移动到有写权限的目录后手动替换，或重新安装到用户目录。"
                .to_string(),
        ),
        (Platform::Windows, Some("msi")) => Some(
            "MSI 安装需要管理员权限。可右键「以管理员身份运行」该安装包，或改用手动安装。"
                .to_string(),
        ),
        _ => None,
    }
}

/// 给安装错误补上「手动兜底」信息（UI 用它显示具体命令或「打开下载目录」）。
fn with_manual_fallback(err: UpdaterError, platform: Platform, asset_path: &Path) -> UpdaterError {
    let Some(hint) = fallback_hint(platform, asset_path) else {
        return err;
    };
    let mut details = match err.details.clone() {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    details.insert("manual_install".to_string(), serde_json::Value::Bool(true));
    details.insert("hint".to_string(), serde_json::Value::String(hint));
    err.with_details(serde_json::Value::Object(details))
}

/// 便携版提示：不写入系统安装目录，只提示用户手动替换可执行文件。
pub fn portable_hint(asset_path: &Path) -> String {
    let location = asset_path
        .parent()
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_else(|| asset_path.to_string_lossy().to_string());
    format!(
        "便携版不会运行安装器：新版本已下载到 {location}。请退出 OpenShell 后手动替换程序文件，连接数据目录不会被覆盖。"
    )
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

/// 自研安装策略。
pub struct SelfInstall {
    runner: Arc<dyn CommandRunner>,
    exe_path: Option<PathBuf>,
}

impl SelfInstall {
    /// 显式指定运行中的可执行文件（AppImage 自更新需要）。
    pub fn new(runner: Arc<dyn CommandRunner>, exe_path: Option<PathBuf>) -> Self {
        Self { runner, exe_path }
    }

    /// 使用当前进程路径（生产环境使用）。
    pub fn for_current_process(runner: Arc<dyn CommandRunner>) -> Self {
        Self::new(runner, std::env::current_exe().ok())
    }
}

#[async_trait]
impl InstallStrategy for SelfInstall {
    fn kind(&self) -> StrategyKind {
        StrategyKind::SelfInstall
    }

    fn is_enabled(&self) -> bool {
        true
    }

    fn supports(&self, asset: &UpdateAsset) -> bool {
        let Some(platform) = Platform::current() else {
            return false;
        };
        let Some(ext) = extension_of(Path::new(&asset.name)) else {
            return false;
        };
        platform.extension_priority().contains(&ext.as_str())
    }

    async fn install(&self, ctx: &InstallContext<'_>) -> Result<InstallOutcome, UpdaterError> {
        // 硬约束：没有数据快照就不允许安装
        let Some(prepare) = ctx.prepare else {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Install,
                "refusing to install without a recent data snapshot",
            )
            .with_retryable(false));
        };
        let backup_path = prepare()?;

        // 便携版：绝不运行安装器，也不碰程序文件，只提示用户手动替换
        if ctx.portable {
            tracing::info!(
                version = ctx.version,
                asset = ctx.asset_name,
                backup = %backup_path,
                "portable build: skipping installer"
            );
            return Ok(InstallOutcome {
                strategy: StrategyKind::SelfInstall,
                launched: false,
                manual_hint: Some(portable_hint(ctx.asset_path)),
                backup_path: Some(backup_path),
            });
        }

        let platform = Platform::current().ok_or_else(|| {
            UpdaterError::new(
                UpdaterErrorKind::Install,
                "unsupported platform for installation",
            )
        })?;
        let steps = plan_install(platform, ctx.asset_path, self.exe_path.as_deref())?;

        tracing::info!(
            version = ctx.version,
            asset = ctx.asset_name,
            steps = steps.len(),
            backup = %backup_path,
            "running installer"
        );

        for step in steps {
            let result = match step {
                PlanStep::Run(invocation) => self.runner.run(&invocation),
                PlanStep::Spawn(invocation) => self.runner.spawn_detached(&invocation),
                PlanStep::Replace { from, to } => replace_file(&from, &to),
            };
            // 失败时补上「用户可以怎么办」，UI 据此显示「打开下载目录 / 手动安装」
            result.map_err(|err| with_manual_fallback(err, platform, ctx.asset_path))?;
        }

        let hint = manual_hint(platform, ctx.asset_path);
        Ok(InstallOutcome {
            strategy: StrategyKind::SelfInstall,
            launched: hint.is_none(),
            manual_hint: hint,
            backup_path: Some(backup_path),
        })
    }
}

/// 用新文件覆盖运行中的可执行文件：先备份旧文件，再复制并补可执行权限。
fn replace_file(from: &Path, to: &Path) -> Result<(), UpdaterError> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if to.exists() {
        let mut backup = to.as_os_str().to_os_string();
        backup.push(".old");
        let backup = PathBuf::from(backup);
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(to, &backup).map_err(|err| {
            UpdaterError::new(
                UpdaterErrorKind::Install,
                format!("failed to move current binary aside: {err}"),
            )
        })?;
    }
    std::fs::copy(from, to).map_err(|err| {
        UpdaterError::new(
            UpdaterErrorKind::Install,
            format!("failed to write new binary: {err}"),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeRunner {
        ran: Mutex<Vec<Invocation>>,
        spawned: Mutex<Vec<Invocation>>,
    }

    impl FakeRunner {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                ran: Mutex::new(Vec::new()),
                spawned: Mutex::new(Vec::new()),
            })
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
            self.ran.lock().unwrap().push(invocation.clone());
            Ok(())
        }

        fn spawn_detached(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
            self.spawned.lock().unwrap().push(invocation.clone());
            Ok(())
        }
    }

    fn prepare_ok() -> impl Fn() -> Result<String, UpdaterError> + Send + Sync {
        || Ok("/data/backups/openshell_1.0.1_pre-install_x.db".to_string())
    }

    #[test]
    fn windows_exe_runs_silent_setup() {
        let steps = plan_install(
            Platform::Windows,
            Path::new("C:/tmp/OpenShell-1.1.0-windows-x86_64.exe"),
            None,
        )
        .expect("plan");
        assert_eq!(steps.len(), 1);
        match &steps[0] {
            PlanStep::Spawn(invocation) => {
                assert!(invocation
                    .program
                    .ends_with("OpenShell-1.1.0-windows-x86_64.exe"));
                assert_eq!(invocation.args, vec!["/S".to_string()]);
            }
            other => panic!("unexpected step: {other:?}"),
        }
    }

    #[test]
    fn windows_msi_uses_msiexec_quiet() {
        let steps =
            plan_install(Platform::Windows, Path::new("C:/tmp/OpenShell.msi"), None).expect("plan");
        match &steps[0] {
            PlanStep::Spawn(invocation) => {
                assert_eq!(invocation.program, "msiexec");
                assert!(invocation.args.contains(&"/qn".to_string()));
                assert!(invocation.args.contains(&"/norestart".to_string()));
            }
            other => panic!("unexpected step: {other:?}"),
        }
    }

    #[test]
    fn macos_dmg_opens_image_and_hints_manual_step() {
        let steps =
            plan_install(Platform::Macos, Path::new("/tmp/OpenShell.dmg"), None).expect("plan");
        match &steps[0] {
            PlanStep::Spawn(invocation) => assert_eq!(invocation.program, "open"),
            other => panic!("unexpected step: {other:?}"),
        }
        assert!(
            manual_hint(Platform::Macos, Path::new("/tmp/OpenShell.dmg"))
                .expect("hint")
                .contains("应用程序")
        );
    }

    #[test]
    fn linux_appimage_replaces_current_binary_then_restarts() {
        let steps = plan_install(
            Platform::Linux,
            Path::new("/home/u/Downloads/OpenShell.AppImage"),
            Some(Path::new("/home/u/Applications/OpenShell.AppImage")),
        )
        .expect("plan");
        assert_eq!(steps.len(), 2);
        assert!(matches!(steps[0], PlanStep::Replace { .. }));
        assert!(matches!(steps[1], PlanStep::Spawn(_)));
    }

    #[test]
    fn linux_appimage_without_exe_path_is_rejected() {
        let err = plan_install(
            Platform::Linux,
            Path::new("/home/u/Downloads/OpenShell.AppImage"),
            None,
        )
        .expect_err("no target");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
    }

    #[test]
    fn linux_deb_uses_pkexec() {
        let steps =
            plan_install(Platform::Linux, Path::new("/tmp/openshell.deb"), None).expect("plan");
        match &steps[0] {
            PlanStep::Run(invocation) => {
                assert_eq!(invocation.program, "pkexec");
                assert_eq!(invocation.args[0], "dpkg");
            }
            other => panic!("unexpected step: {other:?}"),
        }
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        let err = plan_install(Platform::Windows, Path::new("C:/tmp/OpenShell.zip"), None)
            .expect_err("unsupported");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn install_requires_data_snapshot() {
        let runner = FakeRunner::new();
        let strategy = SelfInstall::new(runner.clone(), None);
        let ctx = InstallContext {
            asset_path: Path::new("C:/tmp/OpenShell-1.1.0-windows-x86_64.exe"),
            asset_name: "OpenShell-1.1.0-windows-x86_64.exe",
            version: "1.1.0",
            log_dir: Path::new("C:/tmp"),
            prepare: None,
            portable: false,
        };
        let err = strategy.install(&ctx).await.expect_err("must refuse");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
        assert!(!err.retryable);
        assert!(runner.spawned.lock().unwrap().is_empty());
    }

    /// 仅 Windows 可断言「真的拉起了安装器」：其他平台的资产后缀不匹配。
    #[cfg(windows)]
    #[tokio::test]
    async fn install_backs_up_first_then_launches_installer() {
        let runner = FakeRunner::new();
        let strategy = SelfInstall::new(runner.clone(), None);
        let prepare = prepare_ok();
        let asset = "OpenShell-1.1.0-windows-x86_64.exe";
        let ctx = InstallContext {
            asset_path: Path::new(asset),
            asset_name: asset,
            version: "1.1.0",
            log_dir: Path::new("."),
            prepare: Some(&prepare),
            portable: false,
        };
        let outcome = strategy.install(&ctx).await.expect("install");
        assert!(outcome.launched);
        assert_eq!(outcome.strategy, StrategyKind::SelfInstall);
        assert!(outcome.backup_path.expect("backup").contains("pre-install"));
        assert_eq!(runner.spawned.lock().unwrap().len(), 1);
    }

    /// 便携版：必须完成快照、必须不运行任何安装器、必须给出「手动替换」提示。
    #[tokio::test]
    async fn portable_never_launches_installer() {
        let runner = FakeRunner::new();
        let strategy = SelfInstall::new(runner.clone(), None);
        let prepare = prepare_ok();
        let asset = "OpenShell-1.1.0-windows-x86_64.exe";
        let ctx = InstallContext {
            asset_path: Path::new(asset),
            asset_name: asset,
            version: "1.1.0",
            log_dir: Path::new("."),
            prepare: Some(&prepare),
            portable: true,
        };
        let outcome = strategy.install(&ctx).await.expect("portable install");
        assert!(!outcome.launched, "portable build must not exit the app");
        assert!(runner.spawned.lock().unwrap().is_empty());
        assert!(runner.ran.lock().unwrap().is_empty());
        assert!(outcome.backup_path.expect("backup").contains("pre-install"));
        let hint = outcome.manual_hint.expect("hint");
        assert!(hint.contains("便携"), "unexpected hint: {hint}");
        assert!(hint.contains("手动替换"), "unexpected hint: {hint}");
    }

    /// 平台兜底提示：Linux deb 要给出可直接复制的命令，Windows msi 要提示提权。
    #[test]
    fn manual_fallback_hints_are_actionable() {
        let deb = fallback_hint(Platform::Linux, Path::new("/tmp/openshell_1.1.0_amd64.deb"))
            .expect("deb hint");
        assert!(
            deb.contains("sudo dpkg -i openshell_1.1.0_amd64.deb"),
            "{deb}"
        );

        let appimage = fallback_hint(Platform::Linux, Path::new("/opt/OpenShell.AppImage"))
            .expect("appimage hint");
        assert!(appimage.contains("不可写"), "{appimage}");

        let msi =
            fallback_hint(Platform::Windows, Path::new("C:/tmp/OpenShell.msi")).expect("msi hint");
        assert!(msi.contains("管理员"), "{msi}");

        // macOS 走「手动拖入」，不需要失败兜底
        assert!(fallback_hint(Platform::Macos, Path::new("/tmp/OpenShell.dmg")).is_none());
    }

    /// 安装错误必须带上 manual_install 标记，前端才能显示「打开下载目录 / 手动安装」。
    #[test]
    fn install_errors_carry_manual_fallback_details() {
        let raw = UpdaterError::new(UpdaterErrorKind::Install, "pkexec not found");
        let enriched = with_manual_fallback(raw, Platform::Linux, Path::new("/tmp/x.deb"));
        let details = enriched.details.expect("details");
        assert_eq!(details["manual_install"], serde_json::json!(true));
        assert!(details["hint"].as_str().expect("hint").contains("dpkg"));

        // 没有兜底文案的平台不应被改写
        let untouched = with_manual_fallback(
            UpdaterError::new(UpdaterErrorKind::Install, "boom"),
            Platform::Macos,
            Path::new("/tmp/x.dmg"),
        );
        assert!(untouched.details.is_none());
    }

    #[tokio::test]
    async fn failed_backup_aborts_install() {
        let runner = FakeRunner::new();
        let strategy = SelfInstall::new(runner.clone(), None);
        let prepare = || {
            Err(UpdaterError::new(
                UpdaterErrorKind::Io,
                "disk full while creating snapshot",
            ))
        };
        let asset = "OpenShell-1.1.0-windows-x86_64.exe";
        let ctx = InstallContext {
            asset_path: Path::new(asset),
            asset_name: asset,
            version: "1.1.0",
            log_dir: Path::new("."),
            prepare: Some(&prepare),
            portable: false,
        };
        let err = strategy.install(&ctx).await.expect_err("abort");
        assert_eq!(err.kind, UpdaterErrorKind::Io);
        assert!(runner.spawned.lock().unwrap().is_empty());
        // 零副作用：连「运行并等待」的命令都不能发起
        assert!(runner.ran.lock().unwrap().is_empty());
    }

    /// 备份失败时必须「什么都没发生」：既不能拉起安装器，也不能改动磁盘上的可执行文件。
    #[tokio::test]
    async fn prepare_failure_leaves_existing_binary_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let downloaded = dir.path().join("OpenShell-new.AppImage");
        let current = dir.path().join("OpenShell-current.AppImage");
        std::fs::write(&downloaded, b"new-binary").expect("write new");
        std::fs::write(&current, b"old-binary").expect("write old");

        let runner = FakeRunner::new();
        let strategy = SelfInstall::new(runner.clone(), Some(current.clone()));
        let prepare = || {
            Err(UpdaterError::new(
                UpdaterErrorKind::Io,
                "snapshot failed: no space left on device",
            ))
        };
        let ctx = InstallContext {
            asset_path: &downloaded,
            asset_name: "OpenShell-new.AppImage",
            version: "1.1.0",
            log_dir: dir.path(),
            prepare: Some(&prepare),
            portable: false,
        };

        let err = strategy.install(&ctx).await.expect_err("abort");
        assert_eq!(err.kind, UpdaterErrorKind::Io);
        assert!(runner.spawned.lock().unwrap().is_empty());
        assert!(runner.ran.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read(&current).expect("read current"),
            b"old-binary",
            "existing binary must not be replaced when the snapshot fails"
        );
        assert!(!current.with_extension("AppImage.old").exists());
    }
}
