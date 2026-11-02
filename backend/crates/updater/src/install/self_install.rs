//! 自研安装策略：退出应用 → 运行安装包。
//!
//! 各平台行为：
//! * **Windows**：先运行旧版本的 `uninstall.exe /S` 并校验卸载结果，再静默安装新版本
//!   （需要提权时通过系统 UAC 确认）；`.msi` 走 `msiexec /i … /qn /norestart`
//!   （需要管理员权限，失败会提示手动安装）。
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
    /// Windows：拉起升级脚本，等应用退出后**先卸载旧版本并校验**，再安装新版本。
    WindowsUpgrade(WindowsUpgradePlan),
}

/// 更新工作目录下的升级脚本文件名（放数据目录，卸载旧版本时不会被一起删掉）。
pub const INSTALL_SCRIPT_FILE: &str = "openshell-update.ps1";
/// 升级脚本的日志文件（与脚本同目录）。
pub const INSTALL_LOG_FILE: &str = "openshell-update.log";
/// 升级失败标记：卸载未完成 / 安装器失败时写入，下次启动由 UI 读出来提示用户。
pub const INSTALL_FAILURE_FILE: &str = "update-install-failed.txt";

/// Windows 升级脚本计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsUpgradePlan {
    /// 脚本落盘路径。
    pub script_path: PathBuf,
    /// 脚本文本（UTF-8，落盘时补 BOM）。
    pub script: String,
}

impl WindowsUpgradePlan {
    /// PowerShell 调用（静默、不加载用户 profile）。
    fn invocation(&self) -> Invocation {
        let mut invocation = Invocation::new(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ],
        );
        invocation
            .args
            .push(self.script_path.to_string_lossy().to_string());
        invocation
    }
}

/// 命令执行抽象（测试注入假实现，绝不执行真实安装）。
pub trait CommandRunner: Send + Sync {
    fn run(&self, invocation: &Invocation) -> Result<(), UpdaterError>;
    fn spawn_detached(&self, invocation: &Invocation) -> Result<(), UpdaterError>;

    /// 拉起升级脚本（Windows 专用）。
    ///
    /// 与 [`Self::spawn_detached`] 分开，是因为后者对 Windows `.exe` 只放行固定参数
    /// `/S`（防止任意参数启动可执行文件），而脚本需要 `-File <path>`。
    fn spawn_script(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
        self.spawn_detached(invocation)
    }
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
        #[cfg(windows)]
        if extension_of(Path::new(&invocation.program)).as_deref() == Some("exe")
            && invocation.args != ["/S"]
        {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Install,
                "unexpected Windows installer arguments",
            ));
        }
        let result = std::process::Command::new(&invocation.program)
            .args(&invocation.args)
            .spawn();
        #[cfg(windows)]
        if result
            .as_ref()
            .is_err_and(|err| err.raw_os_error() == Some(740))
            && invocation.args == ["/S"]
        {
            return spawn_elevated_nsis(Path::new(&invocation.program));
        }
        result.map(|_| ()).map_err(installer_launch_error)
    }

    /// 升级脚本是控制台程序：无窗口启动，且不做安装包那套 `/S` 参数约束。
    fn spawn_script(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
        let mut command = std::process::Command::new(&invocation.program);
        command.args(&invocation.args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：不要为升级脚本弹出黑色控制台窗口
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.spawn().map(|_| ()).map_err(installer_launch_error)
    }
}

fn installer_launch_error(err: std::io::Error) -> UpdaterError {
    let hint = if cfg!(windows) && err.raw_os_error() == Some(1223) {
        "已取消管理员授权，安装尚未开始。点击「重试」并允许系统授权后即可继续。"
    } else {
        "安装程序未能启动。请重试，或打开下载目录手动运行安装包。"
    };
    UpdaterError::new(
        UpdaterErrorKind::Install,
        format!("启动安装程序失败：{err}"),
    )
    .with_retryable(true)
    .with_details(serde_json::json!({ "os_error": err.raw_os_error(), "hint": hint }))
}

#[cfg(windows)]
fn spawn_elevated_nsis(path: &Path) -> Result<(), UpdaterError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::core::w;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("runas"),
        lpFile: file.as_ptr(),
        lpParameters: w!("/S"),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // 路径与固定参数独立传递；同步等待 UAC 结果，获准启动前不能让应用退出。
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(installer_launch_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

/// 构造某平台的安装步骤（纯函数）。
///
/// `log_dir` 用来放 Windows 升级脚本与日志；`pid` 是当前进程号，脚本要先等它退出。
pub fn plan_install(
    platform: Platform,
    asset_path: &Path,
    exe_path: Option<&Path>,
    log_dir: &Path,
    pid: u32,
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
        // 升级必须「先卸载、再安装」：只有知道当前安装目录才能定位旧版 uninstall.exe
        (Platform::Windows, Some("exe")) => {
            let Some(exe) = exe_path else {
                return Err(UpdaterError::new(
                    UpdaterErrorKind::Install,
                    "cannot locate the running executable path, so the previous version cannot be uninstalled before updating",
                )
                .with_retryable(false));
            };
            Ok(vec![PlanStep::WindowsUpgrade(WindowsUpgradePlan {
                script_path: log_dir.join(INSTALL_SCRIPT_FILE),
                script: windows_upgrade_script(exe, asset_path, log_dir, pid),
            })])
        }
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

/// PowerShell 单引号字面量（内部的 `'` 需要写成 `''`）。
fn ps_str(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 生成 Windows 升级脚本。
///
/// 顺序是硬约束：**等旧进程退出 → 运行旧版 `uninstall.exe /S` → 校验卸载结果 → 安装新版本**。
/// 卸载没成功时脚本直接退出（不安装），并写 [`INSTALL_FAILURE_FILE`] 供下次启动提示，
/// 避免出现「新旧文件混在一起」的覆盖式安装。
pub fn windows_upgrade_script(
    exe_path: &Path,
    asset_path: &Path,
    log_dir: &Path,
    pid: u32,
) -> String {
    let exe = exe_path.to_string_lossy().to_string();
    let asset = asset_path.to_string_lossy().to_string();
    let log = log_dir.join(INSTALL_LOG_FILE).to_string_lossy().to_string();
    let marker = log_dir
        .join(INSTALL_FAILURE_FILE)
        .to_string_lossy()
        .to_string();

    let lines: Vec<String> = vec![
        "# OpenShell 自动升级脚本（由客户端生成，请勿修改）".to_string(),
        "$ErrorActionPreference = 'Stop'".to_string(),
        format!("$appExe = {}", ps_str(&exe)),
        format!("$appPid = {pid}"),
        format!("$installer = {}", ps_str(&asset)),
        format!("$logFile = {}", ps_str(&log)),
        format!("$markerFile = {}", ps_str(&marker)),
        format!(
            "$uninstaller = Join-Path -Path (Split-Path -Parent $appExe) -ChildPath {}",
            ps_str("uninstall.exe")
        ),
        String::new(),
        "function Write-Log([string]$message) {".to_string(),
        "  try {".to_string(),
        "    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message".to_string(),
        "    Add-Content -Path $logFile -Value $line -Encoding UTF8".to_string(),
        "  } catch { }".to_string(),
        "}".to_string(),
        String::new(),
        "function Write-Failure([string]$reason, [int]$code) {".to_string(),
        "  Write-Log $reason".to_string(),
        "  try { Set-Content -Path $markerFile -Value $reason -Encoding UTF8 } catch { }".to_string(),
        "  exit $code".to_string(),
        "}".to_string(),
        String::new(),
        "function Wait-Gone([string]$path, [int]$seconds) {".to_string(),
        "  $deadline = (Get-Date).AddSeconds($seconds)".to_string(),
        "  while ((Get-Date) -lt $deadline) {".to_string(),
        "    if (-not (Test-Path -Path $path)) { return $true }".to_string(),
        "    Start-Sleep -Milliseconds 500".to_string(),
        "  }".to_string(),
        "  return (-not (Test-Path -Path $path))".to_string(),
        "}".to_string(),
        String::new(),
        "Write-Log '=== 开始自动更新 ==='".to_string(),
        "Write-Log ('新版本安装包: ' + $installer)".to_string(),
        String::new(),
        "# 1) 等旧进程退出：卸载器无法删除正在运行的程序文件".to_string(),
        "try { Wait-Process -Id $appPid -Timeout 120 -ErrorAction Stop } catch { }".to_string(),
        "Start-Sleep -Milliseconds 800".to_string(),
        String::new(),
        "# 2) 先运行旧版本自带的 uninstall.exe（静默），并确认真的卸载干净".to_string(),
        "if (Test-Path -Path $uninstaller) {".to_string(),
        "  Write-Log ('运行卸载程序: ' + $uninstaller + ' /S')".to_string(),
        "  try {".to_string(),
        "    $uninstallProc = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -ErrorAction Stop".to_string(),
        "    if ($uninstallProc.WaitForExit(180000)) {".to_string(),
        "      Write-Log ('卸载程序退出码: ' + $uninstallProc.ExitCode)".to_string(),
        "    } else {".to_string(),
        "      Write-Log '卸载程序 180 秒内未退出，改为按文件是否消失判断'".to_string(),
        "    }".to_string(),
        "  } catch {".to_string(),
        "    Write-Log ('普通权限启动卸载程序失败: ' + $_.Exception.Message)".to_string(),
        "  }".to_string(),
        String::new(),
        "  # NSIS 卸载器会把自身复制到 %TEMP% 后立即返回，所以以「程序文件消失」作为完成判据".to_string(),
        "  $uninstallOk = (Wait-Gone $appExe 180) -and (Wait-Gone $uninstaller 60)".to_string(),
        String::new(),
        "  # 系统级安装（Program Files）需要管理员权限：普通权限没删干净就申请授权重试一次".to_string(),
        "  if (-not $uninstallOk) {".to_string(),
        "    Write-Log '普通权限卸载未完成，申请管理员权限重试'".to_string(),
        "    try {".to_string(),
        "      Start-Process -FilePath $uninstaller -ArgumentList '/S' -Verb RunAs -ErrorAction Stop | Out-Null".to_string(),
        "    } catch {".to_string(),
        "      Write-Log ('申请管理员权限失败: ' + $_.Exception.Message)".to_string(),
        "    }".to_string(),
        "    $uninstallOk = (Wait-Gone $appExe 180) -and (Wait-Gone $uninstaller 60)".to_string(),
        "  }".to_string(),
        String::new(),
        "  if (-not $uninstallOk) {".to_string(),
        "    $left = @()".to_string(),
        "    if (Test-Path -Path $appExe) { $left += $appExe }".to_string(),
        "    if (Test-Path -Path $uninstaller) { $left += $uninstaller }".to_string(),
        "    Write-Failure ('旧版本卸载未完成，已中止安装以避免覆盖式残留。仍存在的文件: ' + ($left -join '; ')) 2".to_string(),
        "  }".to_string(),
        "  Write-Log '旧版本已卸载完成'".to_string(),
        "} else {".to_string(),
        "  Write-Log '未找到旧版本的 uninstall.exe（便携版或开发环境），跳过卸载步骤'".to_string(),
        "}".to_string(),
        String::new(),
        "# 3) 确认卸载完成后才安装新版本".to_string(),
        "Write-Log ('开始安装新版本: ' + $installer + ' /S')".to_string(),
        "$installed = $false".to_string(),
        "try {".to_string(),
        "  $installProc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -ErrorAction Stop".to_string(),
        "  if ($installProc.WaitForExit(600000)) {".to_string(),
        "    Write-Log ('安装器退出码: ' + $installProc.ExitCode)".to_string(),
        "    $installed = ($installProc.ExitCode -eq 0)".to_string(),
        "  } else {".to_string(),
        "    Write-Log '安装器 10 分钟内未结束'".to_string(),
        "  }".to_string(),
        "} catch {".to_string(),
        "  Write-Log ('普通权限启动安装器失败: ' + $_.Exception.Message)".to_string(),
        "}".to_string(),
        String::new(),
        "if (-not $installed) {".to_string(),
        "  Write-Log '申请管理员权限重新安装'".to_string(),
        "  try {".to_string(),
        "    $installProc = Start-Process -FilePath $installer -ArgumentList '/S' -Verb RunAs -PassThru -Wait -ErrorAction Stop".to_string(),
        "    if ($installProc) { Write-Log ('管理员安装退出码: ' + $installProc.ExitCode) }".to_string(),
        "    $installed = (Test-Path -Path $appExe)".to_string(),
        "  } catch {".to_string(),
        "    Write-Log ('申请管理员权限安装失败: ' + $_.Exception.Message)".to_string(),
        "  }".to_string(),
        "}".to_string(),
        String::new(),
        "if (-not $installed) {".to_string(),
        "  Write-Failure '新版本安装未完成，请手动运行下载目录中的安装包完成升级。' 3".to_string(),
        "}".to_string(),
        String::new(),
        "if (Test-Path -Path $markerFile) { Remove-Item -Path $markerFile -Force -ErrorAction SilentlyContinue }".to_string(),
        "Write-Log '=== 自动更新完成 ==='".to_string(),
        "exit 0".to_string(),
        String::new(),
    ];
    lines.join("\r\n")
}

/// 写出脚本（UTF-8 BOM）并拉起：脚本自己等待应用退出、卸载旧版、校验、再安装新版。
fn launch_windows_upgrade(
    plan: &WindowsUpgradePlan,
    runner: &dyn CommandRunner,
) -> Result<(), UpdaterError> {
    if let Some(dir) = plan.script_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut content = String::from("\u{feff}");
    content.push_str(&plan.script);
    std::fs::write(&plan.script_path, content.as_bytes()).map_err(|err| {
        UpdaterError::new(
            UpdaterErrorKind::Install,
            format!("failed to write the update script: {err}"),
        )
    })?;
    runner.spawn_script(&plan.invocation())
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
        // 自动升级要先卸载旧版本；脚本没跑起来时让用户手动「先卸载再安装」
        (Platform::Windows, Some("exe")) => Some(
            "自动升级没能启动。请先在「设置 → 应用」里卸载 OpenShell（连接数据会保留），再运行下载目录中的安装包。"
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
    details
        .entry("hint")
        .or_insert(serde_json::Value::String(hint));
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
        let steps = plan_install(
            platform,
            ctx.asset_path,
            self.exe_path.as_deref(),
            ctx.log_dir,
            std::process::id(),
        )?;

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
                PlanStep::WindowsUpgrade(plan) => {
                    launch_windows_upgrade(&plan, self.runner.as_ref())
                }
                PlanStep::Replace { from, to } => replace_file(&from, &to),
            };
            // 失败时补上「用户可以怎么办」，UI 据此显示「打开下载目录 / 手动安装」
            result.map_err(|err| {
                crate::log::UpdateLog::new(ctx.log_dir).warn(
                    "install_failed",
                    &[
                        ("version", ctx.version.to_string()),
                        ("error", err.message.clone()),
                    ],
                );
                with_manual_fallback(err, platform, ctx.asset_path)
            })?;
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
        scripts: Mutex<Vec<Invocation>>,
    }

    impl FakeRunner {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                ran: Mutex::new(Vec::new()),
                spawned: Mutex::new(Vec::new()),
                scripts: Mutex::new(Vec::new()),
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

        fn spawn_script(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
            self.scripts.lock().unwrap().push(invocation.clone());
            Ok(())
        }
    }

    fn prepare_ok() -> impl Fn() -> Result<String, UpdaterError> + Send + Sync {
        || Ok("/data/backups/openshell_1.0.1_pre-install_x.db".to_string())
    }

    #[test]
    fn windows_upgrade_uninstalls_before_installing() {
        let steps = plan_install(
            Platform::Windows,
            Path::new("C:/tmp/OpenShell-1.1.0-windows-x86_64.exe"),
            Some(Path::new(
                "C:/Users/u/AppData/Local/OpenShell/OpenShell.exe",
            )),
            Path::new("C:/Users/u/AppData/Roaming/OpenShell/updater"),
            4242,
        )
        .expect("plan");
        assert_eq!(steps.len(), 1);
        let PlanStep::WindowsUpgrade(plan) = &steps[0] else {
            panic!("unexpected step: {steps:?}");
        };
        assert!(plan.script_path.ends_with(INSTALL_SCRIPT_FILE));
        assert_eq!(
            plan.script_path.parent().and_then(|p| p.file_name()),
            Some(std::ffi::OsStr::new("updater"))
        );

        let script = &plan.script;
        // 硬约束：先卸载，再安装
        let uninstall_at = script.find("uninstall.exe").expect("uninstall step");
        let install_at = script.find("开始安装新版本").expect("install step");
        assert!(
            uninstall_at < install_at,
            "卸载步骤必须排在安装步骤之前\n{script}"
        );
        assert!(script.contains("-ArgumentList '/S'"), "{script}");
        assert!(script.contains("$appPid = 4242"), "{script}");
        // 卸载没成功时必须中止安装，而不是覆盖安装
        assert!(script.contains("旧版本卸载未完成"), "{script}");
        assert!(script.contains(INSTALL_FAILURE_FILE), "{script}");

        let invocation = plan.invocation();
        assert_eq!(invocation.program, "powershell");
        assert_eq!(
            invocation.args.last().cloned(),
            Some(plan.script_path.to_string_lossy().to_string())
        );
    }

    /// 不知道当前安装目录就定位不到旧版 uninstall.exe：宁可直接报错让用户手动处理，
    /// 也不能退化成「直接覆盖安装」。
    #[test]
    fn windows_exe_without_exe_path_is_rejected() {
        let err = plan_install(
            Platform::Windows,
            Path::new("C:/tmp/OpenShell-1.1.0-windows-x86_64.exe"),
            None,
            Path::new("C:/tmp"),
            4242,
        )
        .expect_err("no exe path");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
        assert!(!err.retryable);
    }

    #[cfg(windows)]
    #[test]
    fn windows_elevation_rejects_unexpected_arguments_without_launching() {
        let invocation =
            Invocation::program_path(Path::new("C:/unused/setup.exe"), &["/unexpected"]);
        let error = SystemCommandRunner
            .spawn_detached(&invocation)
            .expect_err("reject before launch");
        assert!(error
            .message
            .contains("unexpected Windows installer arguments"));
    }

    #[cfg(windows)]
    #[test]
    fn cancelled_elevation_is_retryable_and_survives_ipc_mapping() {
        let error = installer_launch_error(std::io::Error::from_raw_os_error(1223));
        let ipc: openshell_core_domain::DomainError = error.into();
        assert!(ipc.retryable);
        let details = ipc.details.expect("details");
        assert_eq!(details["os_error"], 1223);
        assert!(details["hint"]
            .as_str()
            .unwrap()
            .contains("已取消管理员授权"));
    }

    #[cfg(windows)]
    #[test]
    fn elevated_launch_rejects_missing_installer_without_success() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = spawn_elevated_nsis(&dir.path().join("不存在的安装包.exe"))
            .expect_err("missing installer must not report launch success");
        assert_eq!(error.kind, UpdaterErrorKind::Install);
        assert!(error.details.unwrap()["os_error"].is_number());
    }

    #[tokio::test]
    async fn launch_failure_is_written_to_update_log() {
        struct FailedRunner;
        impl CommandRunner for FailedRunner {
            fn run(&self, _: &Invocation) -> Result<(), UpdaterError> {
                Err(installer_launch_error(std::io::Error::from_raw_os_error(
                    740,
                )))
            }
            fn spawn_detached(&self, invocation: &Invocation) -> Result<(), UpdaterError> {
                self.run(invocation)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let name = match Platform::current().unwrap() {
            Platform::Windows => "OpenShell.exe",
            Platform::Macos => "OpenShell.dmg",
            Platform::Linux => "OpenShell.deb",
        };
        let prepare = prepare_ok();
        let ctx = InstallContext {
            asset_path: Path::new(name),
            asset_name: name,
            version: "1.1.4",
            log_dir: dir.path(),
            prepare: Some(&prepare),
            portable: false,
        };
        // Windows 上必须给出当前可执行文件路径，才能定位旧版本 uninstall.exe
        let exe = dir.path().join("OpenShell.exe");
        let error = SelfInstall::new(Arc::new(FailedRunner), Some(exe))
            .install(&ctx)
            .await
            .expect_err("launch failed");
        assert_eq!(error.kind, UpdaterErrorKind::Install);
        let log = std::fs::read_to_string(dir.path().join("updater.log")).unwrap();
        assert!(log.contains("install_failed"));
        assert!(log.contains("740"));
    }

    #[test]
    fn windows_msi_uses_msiexec_quiet() {
        let steps = plan_install(
            Platform::Windows,
            Path::new("C:/tmp/OpenShell.msi"),
            None,
            Path::new("C:/tmp"),
            4242,
        )
        .expect("plan");
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
        let steps = plan_install(
            Platform::Macos,
            Path::new("/tmp/OpenShell.dmg"),
            None,
            Path::new("/tmp"),
            4242,
        )
        .expect("plan");
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
            Path::new("/home/u/.local/share/openshell/updater"),
            4242,
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
            Path::new("/tmp"),
            4242,
        )
        .expect_err("no target");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
    }

    #[test]
    fn linux_deb_uses_pkexec() {
        let steps = plan_install(
            Platform::Linux,
            Path::new("/tmp/openshell.deb"),
            None,
            Path::new("/tmp"),
            4242,
        )
        .expect("plan");
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
        let err = plan_install(
            Platform::Windows,
            Path::new("C:/tmp/OpenShell.zip"),
            Some(Path::new("C:/tmp/OpenShell.exe")),
            Path::new("C:/tmp"),
            4242,
        )
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

    /// 仅 Windows 可断言「真的拉起了升级脚本」：其他平台的资产后缀不匹配。
    #[cfg(windows)]
    #[tokio::test]
    async fn install_backs_up_first_then_launches_upgrade_script() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runner = FakeRunner::new();
        let exe = dir.path().join("OpenShell.exe");
        let strategy = SelfInstall::new(runner.clone(), Some(exe.clone()));
        let prepare = prepare_ok();
        let asset = "OpenShell-1.1.0-windows-x86_64.exe";
        let ctx = InstallContext {
            asset_path: Path::new(asset),
            asset_name: asset,
            version: "1.1.0",
            log_dir: dir.path(),
            prepare: Some(&prepare),
            portable: false,
        };
        let outcome = strategy.install(&ctx).await.expect("install");
        assert!(outcome.launched);
        assert_eq!(outcome.strategy, StrategyKind::SelfInstall);
        assert!(outcome.backup_path.expect("backup").contains("pre-install"));

        // 安装器本身不再被直接拉起，拉起的是「先卸载再安装」的脚本
        assert!(runner.spawned.lock().unwrap().is_empty());
        let scripts = runner.scripts.lock().unwrap();
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].program, "powershell");

        let script_path = dir.path().join(INSTALL_SCRIPT_FILE);
        let script = std::fs::read_to_string(&script_path).expect("script written");
        assert!(script.starts_with('\u{feff}'), "PowerShell 需要 UTF-8 BOM");
        assert!(script.contains("uninstall.exe"), "{script}");
        assert!(
            script.find("uninstall.exe").unwrap() < script.find("开始安装新版本").unwrap(),
            "{script}"
        );
        assert!(
            script.contains(&exe.to_string_lossy().to_string()),
            "{script}"
        );
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
