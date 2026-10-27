//! `tauri-plugin-updater` 安装策略（**未启用**）。
//!
//! 为什么不启用（对应 docs/UPDATE.md 的设计说明）：
//! * 插件只认它自己的 `latest.json` + minisign 签名，无法满足本项目的多源回退、
//!   ETag 缓存、镜像前缀、断点续传、sha256 清单；
//! * 启用它需要 CI 注入 `TAURI_SIGNING_PRIVATE_KEY` 并产出 `.sig`，
//!   与当前「只产出 sha256 清单」的发布流程冲突。
//!
//! 保留这个空实现的目的：
//! 1. 证明 [`super::InstallStrategy`] 抽象是可替换的；
//! 2. 将来若改为签名升级，只需在此实现 `install`，并把它加入 `InstallManager`，
//!    UI 与校验流程无需改动。
//!
//! **不要**为了「让它能工作」而偷偷引入插件依赖。

use super::{InstallContext, InstallOutcome, InstallStrategy, StrategyKind};
use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::UpdateAsset;
use async_trait::async_trait;

/// 未启用的插件策略占位（构造即 `PluginUpdater`，无内部状态）。
pub struct PluginUpdater;

#[async_trait]
impl InstallStrategy for PluginUpdater {
    fn kind(&self) -> StrategyKind {
        StrategyKind::PluginUpdater
    }

    fn is_enabled(&self) -> bool {
        false
    }

    fn supports(&self, _asset: &UpdateAsset) -> bool {
        false
    }

    async fn install(&self, _ctx: &InstallContext<'_>) -> Result<InstallOutcome, UpdaterError> {
        Err(UpdaterError::new(
            UpdaterErrorKind::NotConfigured,
            "tauri-plugin-updater strategy is not enabled in this build",
        ))
    }
}
