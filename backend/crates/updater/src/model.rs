//! 对外的数据契约（IPC 唯一形态）与运行配置。

use crate::proxy::ProxyMode;
use serde::{Deserialize, Serialize};

/// 安装包命名里的应用名，必须与 CI 产出的文件名前缀一致。
pub const APP_NAME: &str = "OpenShell";

/// GitHub 仓库默认位置（可在设置中覆盖）。
pub const DEFAULT_OWNER: &str = "fieecbin-source";
pub const DEFAULT_REPO: &str = "openshell";
/// 自动检查的默认间隔（小时）。
pub const DEFAULT_INTERVAL_HOURS: u32 = 6;
/// 启动后延迟多久再检查（秒），避免和窗口初始化抢资源。
pub const STARTUP_DELAY_SECS: u64 = 30;
/// 本地检测缓存的默认有效期（小时）。
pub const DEFAULT_CACHE_TTL_HOURS: u32 = 6;

/// 更新通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// 正式版：`/releases/latest`（GitHub 不会返回预发布与草稿）。
    #[default]
    Stable,
    /// 测试通道：`/releases` 里挑选 semver 最大的预发布版本。
    Beta,
}

impl Channel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

/// 目标平台（与安装包命名一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    /// 当前运行平台；未支持的平台返回 `None`。
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "windows") {
            Some(Self::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else {
            None
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
        }
    }

    /// 解析 CI 命名里的平台段。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "windows" | "win" | "win32" | "win64" => Some(Self::Windows),
            "macos" | "mac" | "darwin" | "osx" => Some(Self::Macos),
            "linux" => Some(Self::Linux),
            _ => None,
        }
    }

    /// 该平台接受的安装包扩展名，按优先级从高到低。
    pub fn extension_priority(&self) -> &'static [&'static str] {
        match self {
            Self::Windows => &["exe", "msi"],
            Self::Macos => &["dmg"],
            Self::Linux => &["appimage", "deb"],
        }
    }
}

/// 目标架构。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    X86_64,
    Aarch64,
    Universal,
}

impl Arch {
    /// 当前架构；`universal` 只出现在 macOS 产物名里，不会被当作运行架构。
    pub fn current() -> Self {
        match std::env::consts::ARCH {
            "aarch64" => Self::Aarch64,
            _ => Self::X86_64,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
            Self::Universal => "universal",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "x86_64" | "amd64" | "x64" => Some(Self::X86_64),
            "aarch64" | "arm64" => Some(Self::Aarch64),
            "universal" | "universal2" => Some(Self::Universal),
            _ => None,
        }
    }

    /// 候选是否兼容当前架构（macOS 的 universal 包同时兼容两种）。
    pub fn accepts(&self, candidate: Arch) -> bool {
        candidate == *self || candidate == Self::Universal
    }
}

/// 匹配到的安装包。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// 十六进制小写 sha256；缺失时前端只允许「打开 Release 页面」手动下载。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl UpdateAsset {
    /// 是否可用于自动下载安装（必须有哈希才允许，避免装了来路不明的包）。
    pub fn is_auto_installable(&self) -> bool {
        self.sha256.as_deref().is_some_and(|s| s.len() == 64)
    }
}

/// 更新模块配置（用户可在设置页修改，持久化在 `setting` 表 `update.*`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConfig {
    pub owner: String,
    pub repo: String,
    pub channel: Channel,
    /// 是否启用后台自动检查。
    pub auto_check: bool,
    /// 自动检查间隔（小时，1..=168）。
    pub interval_hours: u32,
    /// 自动快照保留份数（1..=20）。
    pub backup_keep: u32,
    /// 备用检测源（`latest.json` 的 https 地址），留空表示不启用。
    pub fallback_source: Option<String>,
    /// 下载镜像前缀，留空表示直连 GitHub。
    pub mirror_prefix: Option<String>,
    pub proxy: ProxyMode,
    /// 是否允许「降级」到更低版本（默认关闭）。
    pub allow_downgrade: bool,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            owner: DEFAULT_OWNER.to_string(),
            repo: DEFAULT_REPO.to_string(),
            channel: Channel::Stable,
            auto_check: true,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            backup_keep: 5,
            fallback_source: None,
            mirror_prefix: None,
            proxy: ProxyMode::System,
            allow_downgrade: false,
        }
    }
}

impl UpdateConfig {
    /// 归一化并校验配置：非法值回落到默认值，而不是让检查直接失败。
    ///
    /// 返回 `Err` 仅当 owner/repo 完全不可用时（此时无法构造 GitHub URL）。
    pub fn normalized(&self) -> Result<Self, crate::error::UpdaterError> {
        let owner = sanitize_slug(&self.owner);
        let repo = sanitize_slug(&self.repo);
        if owner.is_empty() || repo.is_empty() {
            return Err(crate::error::UpdaterError::new(
                crate::error::UpdaterErrorKind::NotConfigured,
                "update source repository is not configured",
            ));
        }
        Ok(Self {
            owner,
            repo,
            channel: self.channel,
            auto_check: self.auto_check,
            interval_hours: self.interval_hours.clamp(1, 168),
            backup_keep: self.backup_keep.clamp(1, 20),
            fallback_source: normalize_optional_url(&self.fallback_source),
            mirror_prefix: normalize_optional_url(&self.mirror_prefix),
            proxy: self.proxy.clone(),
            allow_downgrade: self.allow_downgrade,
        })
    }

    /// GitHub Release 页面（用于「打开 Release 页面」与手动下载兜底）。
    pub fn release_page_url(&self) -> String {
        format!("https://github.com/{}/{}/releases", self.owner, self.repo)
    }

    /// 当前通道对应的 API 地址。
    pub fn github_api_url(&self) -> String {
        match self.channel {
            Channel::Stable => format!(
                "https://api.github.com/repos/{}/{}/releases/latest",
                self.owner, self.repo
            ),
            Channel::Beta => format!(
                "https://api.github.com/repos/{}/{}/releases?per_page=30",
                self.owner, self.repo
            ),
        }
    }

    /// 备用检测源地址（用户配置的 jsDelivr / raw 上的 latest.json）。
    pub fn fallback_url(&self) -> Option<String> {
        self.fallback_source.clone().or_else(|| {
            Some(format!(
                "https://cdn.jsdelivr.net/gh/{}/{}/updater/latest.json",
                self.owner, self.repo
            ))
        })
    }
}

/// 一次检查的结果，直接作为 IPC 返回值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub tag: String,
    pub release_name: String,
    /// 原始 Markdown（用户可在弹窗里「查看原文」，也便于排查）。
    pub release_notes: String,
    /// 已消毒、可直接 `dangerouslySetInnerHTML` 的 HTML。
    pub notes_html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<UpdateAsset>,
    /// 是否必须更新（Release 声明 mandatory，或当前版本低于 min_supported_version）。
    pub mandatory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_supported_version: Option<String>,
    pub channel: Channel,
    /// 是否来自本地缓存（前端可提示「缓存结果，点击可重新检查」）。
    pub from_cache: bool,
    pub release_page_url: String,
    /// 命中的数据源标识：`github` / `manifest` / `server`。
    pub source: String,
    /// 检查时间（Unix 毫秒）。
    pub checked_at_ms: i64,
}

impl UpdateCheckResult {
    /// 是否因为这个版本被用户「跳过」而应当静默（手动检查不受影响）。
    pub fn is_skipped(&self, skipped: &[String]) -> bool {
        skipped.iter().any(|v| v == &self.latest_version)
    }
}

/// 去掉 slug 中的路径分隔符与空白，避免拼出越权 URL。
fn sanitize_slug(raw: &str) -> String {
    raw.trim()
        .trim_matches('/')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect()
}

fn normalize_optional_url(raw: &Option<String>) -> Option<String> {
    raw.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_slugs_and_clamps_numbers() {
        let cfg = UpdateConfig {
            owner: " /fieecbin-source/ ".into(),
            repo: "open shell/../evil".into(),
            interval_hours: 0,
            backup_keep: 99,
            ..Default::default()
        }
        .normalized()
        .expect("config normalizes");
        assert_eq!(cfg.owner, "fieecbin-source");
        assert_eq!(cfg.repo, "openshell..evil");
        assert_eq!(cfg.interval_hours, 1);
        assert_eq!(cfg.backup_keep, 20);
    }

    #[test]
    fn rejects_empty_repository() {
        let cfg = UpdateConfig {
            owner: "  ".into(),
            repo: "".into(),
            ..Default::default()
        };
        assert!(cfg.normalized().is_err());
    }

    #[test]
    fn builds_expected_endpoints() {
        let stable = UpdateConfig::default();
        assert!(stable
            .github_api_url()
            .ends_with("/repos/fieecbin-source/openshell/releases/latest"));
        let beta = UpdateConfig {
            channel: Channel::Beta,
            ..Default::default()
        };
        assert!(beta.github_api_url().contains("/releases?per_page=30"));
        assert_eq!(
            stable.release_page_url(),
            "https://github.com/fieecbin-source/openshell/releases"
        );
    }
}
