//! 安装策略抽象。
//!
//! 当前只启用 [`self_install::SelfInstall`]（应用内下载 → 校验 → 退出 → 运行安装包）。
//! [`plugin_updater::PluginUpdater`] 是**未启用**的预留位：不引入 `tauri-plugin-updater`
//! 依赖、不要求 Tauri 升级签名密钥，只保留接口，方便将来切换。
//!
//! 无论用哪种策略，安装前都必须拿到一份数据快照（`InstallContext::prepare`），
//! 拿不到就拒绝安装——这是「更新后连接数据绝不能丢」的硬约束。

pub mod plugin_updater;
pub mod self_install;

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::UpdateAsset;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

/// 安装策略类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind {
    /// 自研：下载 + 校验 + 退出运行安装包。
    SelfInstall,
    /// 预留：`tauri-plugin-updater`（当前未启用）。
    PluginUpdater,
}

/// 安装结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallOutcome {
    pub strategy: StrategyKind,
    /// 安装器是否已成功拉起（应用应随后退出）。
    pub launched: bool,
    /// 需要用户手动完成的提示（例如 macOS 需要把 App 拖进 Applications）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_hint: Option<String>,
    /// 安装前自动备份的路径（给 UI 展示，让用户安心）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// 安装前的数据备份回调：返回备份文件路径，失败则中止安装。
pub type PrepareHook<'a> = &'a (dyn Fn() -> Result<String, UpdaterError> + Send + Sync);

/// 安装上下文。
pub struct InstallContext<'a> {
    /// 已校验通过的安装包绝对路径。
    pub asset_path: &'a Path,
    pub asset_name: &'a str,
    /// 目标版本（写日志用）。
    pub version: &'a str,
    /// 更新日志目录（安装器输出可重定向于此）。
    pub log_dir: &'a Path,
    /// 安装前备份；`None` 表示调用方没有提供，策略必须拒绝安装。
    pub prepare: Option<PrepareHook<'a>>,
    /// 便携运行（`openshell.portable` 标记存在）：不能走安装器，只能提示手动替换。
    pub portable: bool,
}

/// 安装策略。
#[async_trait]
pub trait InstallStrategy: Send + Sync {
    fn kind(&self) -> StrategyKind;

    /// 是否启用。未启用的策略永远不会被选中。
    fn is_enabled(&self) -> bool;

    /// 是否支持该安装包（按扩展名/平台判断）。
    fn supports(&self, asset: &UpdateAsset) -> bool;

    /// 执行安装。前置条件：sha256 已校验通过。
    async fn install(&self, ctx: &InstallContext<'_>) -> Result<InstallOutcome, UpdaterError>;
}

/// 策略管理器：按顺序选择第一个「已启用且支持」的策略。
pub struct InstallManager {
    strategies: Vec<Arc<dyn InstallStrategy>>,
}

impl InstallManager {
    pub fn new(strategies: Vec<Arc<dyn InstallStrategy>>) -> Self {
        Self { strategies }
    }

    /// 可诊断信息：每个策略是否启用（记录到日志 / 验收时展示）。
    pub fn describe(&self) -> Vec<(StrategyKind, bool)> {
        self.strategies
            .iter()
            .map(|strategy| (strategy.kind(), strategy.is_enabled()))
            .collect()
    }

    pub fn select(&self, asset: &UpdateAsset) -> Result<Arc<dyn InstallStrategy>, UpdaterError> {
        self.strategies
            .iter()
            .find(|strategy| strategy.is_enabled() && strategy.supports(asset))
            .cloned()
            .ok_or_else(|| {
                UpdaterError::new(
                    UpdaterErrorKind::Install,
                    "no enabled install strategy can handle this installer",
                )
                .with_details(serde_json::json!({ "asset": asset.name }))
                .with_retryable(false)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::UpdateAsset;

    /// 当前主机能真正安装的资产名（让策略选择测试在任何 OS 上都成立）。
    ///
    /// Linux 用 `.deb` 而不是 `.AppImage`：AppImage 自更新需要知道运行中的可执行文件路径，
    /// 这里没有提供 `exe_path`，用它会得到「不支持」。
    fn host_asset_name() -> &'static str {
        if cfg!(windows) {
            "OpenShell-1.1.0-windows-x86_64.exe"
        } else if cfg!(target_os = "macos") {
            "OpenShell-1.1.0-macos-universal.dmg"
        } else {
            "OpenShell-1.1.0-linux-x86_64.deb"
        }
    }

    fn asset(name: &str) -> UpdateAsset {
        UpdateAsset {
            name: name.to_string(),
            url: "https://github.com/a/b/releases/download/v1/x".to_string(),
            size: 1,
            sha256: Some("0".repeat(64)),
        }
    }

    #[tokio::test]
    async fn plugin_strategy_is_never_selected() {
        let manager = InstallManager::new(vec![
            Arc::new(plugin_updater::PluginUpdater),
            Arc::new(self_install::SelfInstall::new(
                Arc::new(self_install::SystemCommandRunner),
                None,
            )),
        ]);
        let described = manager.describe();
        assert_eq!(described[0], (StrategyKind::PluginUpdater, false));
        assert_eq!(described[1], (StrategyKind::SelfInstall, true));

        let picked = manager.select(&asset(host_asset_name())).expect("pick");
        assert_eq!(picked.kind(), StrategyKind::SelfInstall);
        // 插件策略即便被注册，也永远排在后面且不会被选中
        assert!(!plugin_updater::PluginUpdater.is_enabled());
    }

    #[tokio::test]
    async fn disabled_plugin_reports_unavailable() {
        let plugin = plugin_updater::PluginUpdater;
        assert!(!plugin.is_enabled());
        assert!(!plugin.supports(&asset("OpenShell-1.1.0-windows-x86_64.exe")));
        let ctx = InstallContext {
            asset_path: Path::new("/tmp/x.exe"),
            asset_name: "x.exe",
            version: "1.1.0",
            log_dir: Path::new("/tmp"),
            prepare: None,
            portable: false,
        };
        let err = plugin.install(&ctx).await.expect_err("disabled");
        assert_eq!(err.kind, UpdaterErrorKind::NotConfigured);
    }
}
