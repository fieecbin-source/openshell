//! 安装包匹配：按平台 + 架构从 Release 资产里挑出正确的那一个。
//!
//! 命名规范（CI 强制产出）：`<AppName>-<version>-<platform>-<arch>.<ext>`
//! 例：`OpenShell-1.1.0-windows-x86_64.exe`、`OpenShell-1.1.0-macos-universal.dmg`。
//!
//! 匹配是「评分取优」而不是「精确字符串相等」，因此也兼容历史命名
//! （如 `OpenShell-Setup-1.0.0.exe`），同时保证平台/架构不匹配的包永远不会被选中。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::{Arch, Platform, APP_NAME};
use semver::Version;
use serde::{Deserialize, Serialize};

/// 进入匹配流程的候选项（来自 Release 资产或 latest.json 的 assets）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetCandidate {
    pub name: String,
    pub url: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl AssetCandidate {
    pub fn new(name: impl Into<String>, url: impl Into<String>, size: u64) -> Self {
        Self {
            name: name.into(),
            url: url.into(),
            size,
            sha256: None,
        }
    }

    pub fn with_sha256(mut self, sha256: Option<String>) -> Self {
        self.sha256 = sha256;
        self
    }
}

/// 规范文件名（用于错误提示与文档）。
pub fn expected_file_name(version: &Version, platform: Platform, arch: Arch) -> String {
    format!(
        "{APP_NAME}-{}-{}-{}.{}",
        version,
        platform.as_str(),
        arch.as_str(),
        platform.extension_priority()[0]
    )
}

/// 选出最合适的安装包；没有可用项时返回 `AssetNotFound`（前端据此提示手动下载）。
pub fn pick(
    candidates: &[AssetCandidate],
    platform: Platform,
    arch: Arch,
    version: &Version,
) -> Result<AssetCandidate, UpdaterError> {
    let mut scored: Vec<(i32, &AssetCandidate)> = Vec::new();

    for candidate in candidates {
        if let Some(score) = score_candidate(candidate, platform, arch, version) {
            scored.push((score, candidate));
        }
    }

    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            // 同分时优先名字更短的（更贴近规范命名，少一堆后缀修饰）
            .then_with(|| a.1.name.len().cmp(&b.1.name.len()))
            .then_with(|| a.1.name.cmp(&b.1.name))
    });

    scored
        .first()
        .map(|(_, candidate)| (*candidate).clone())
        .ok_or_else(|| {
            UpdaterError::new(
                UpdaterErrorKind::AssetNotFound,
                "no installer matched this platform and architecture",
            )
            .with_details(serde_json::json!({
                "platform": platform.as_str(),
                "arch": arch.as_str(),
                "expected": expected_file_name(version, platform, arch),
                "assets": candidates.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            }))
        })
}

/// 单个候选的得分；`None` 表示与目标平台/架构冲突，直接剔除。
fn score_candidate(
    candidate: &AssetCandidate,
    platform: Platform,
    arch: Arch,
    version: &Version,
) -> Option<i32> {
    let lower = candidate.name.to_ascii_lowercase();
    let ext = extension_of(&lower)?;
    let stem = &lower[..lower.len() - ext.len() - 1];

    // 1) 扩展名必须是该平台的安装包格式，且优先级越高分越高
    let rank = platform
        .extension_priority()
        .iter()
        .position(|allowed| *allowed == ext)?;
    let mut score: i32 = 1000 - (rank as i32) * 10;

    // 2) 平台判定：显式 token 优先；冲突即剔除；无 token 时用扩展名推断
    let token_platform = detect_platform(stem);
    if let Some(other) = token_platform {
        if other != platform {
            return None;
        }
        score += 100;
    } else if platform_from_extension(ext)? != platform {
        return None;
    }

    // 3) 架构判定：出现任何不兼容的架构 token 即剔除
    let detected = detect_arch(stem);
    match detected {
        Some(found) if arch.accepts(found) => {
            score += if found == Arch::Universal { 40 } else { 50 };
        }
        Some(_) => return None,
        None => score += 10,
    }

    // 4) 规范命名加分
    if stem.starts_with(&APP_NAME.to_ascii_lowercase()) {
        score += 30;
    }
    if stem.contains(&version.to_string()) {
        score += 20;
    }
    if stem.contains("setup") || stem.contains("installer") {
        score += 5;
    }

    Some(score)
}

/// `OpenShell-1.1.0-windows-x86_64.exe` → `Some("exe")`；无扩展名返回 `None`。
fn extension_of(lower_name: &str) -> Option<&str> {
    let (_, ext) = lower_name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 8 {
        return None;
    }
    Some(ext)
}

fn platform_from_extension(ext: &str) -> Option<Platform> {
    match ext {
        "exe" | "msi" => Some(Platform::Windows),
        "dmg" | "pkg" => Some(Platform::Macos),
        "appimage" | "deb" => Some(Platform::Linux),
        _ => None,
    }
}

/// 识别文件名里显式声明的平台；同时出现多个（如 `foo-windows-linux.exe`）时返回第一个。
fn detect_platform(stem: &str) -> Option<Platform> {
    let tokens: Vec<&str> = stem.split(['-', '_', '.']).collect();
    tokens.iter().find_map(|token| Platform::parse(token))
}

/// 识别文件名里显式声明的架构。
fn detect_arch(stem: &str) -> Option<Arch> {
    let tokens: Vec<&str> = stem.split(['-', '_', '.']).collect();
    // 先看 universal，再具体架构：`universal` 包可能同时带 `x86_64` 字样
    if tokens
        .iter()
        .any(|t| matches!(*t, "universal" | "universal2"))
    {
        return Some(Arch::Universal);
    }
    tokens.iter().find_map(|token| Arch::parse(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(raw: &str) -> Version {
        Version::parse(raw).expect("valid version")
    }

    fn candidates(names: &[&str]) -> Vec<AssetCandidate> {
        names
            .iter()
            .map(|name| AssetCandidate::new(*name, format!("https://example.test/{name}"), 1024))
            .collect()
    }

    #[test]
    fn prefers_exe_over_msi_on_windows() {
        let list = candidates(&[
            "OpenShell-1.1.0-windows-x86_64.msi",
            "OpenShell-1.1.0-windows-x86_64.exe",
        ]);
        let picked = pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).expect("pick");
        assert_eq!(picked.name, "OpenShell-1.1.0-windows-x86_64.exe");
    }

    #[test]
    fn falls_back_to_msi_when_exe_missing() {
        let list = candidates(&["OpenShell-1.1.0-windows-x86_64.msi"]);
        let picked = pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).expect("pick");
        assert_eq!(picked.name, "OpenShell-1.1.0-windows-x86_64.msi");
    }

    #[test]
    fn macos_universal_matches_both_arches() {
        let list = candidates(&["OpenShell-1.1.0-macos-universal.dmg"]);
        for arch in [Arch::X86_64, Arch::Aarch64] {
            let picked = pick(&list, Platform::Macos, arch, &v("1.1.0")).expect("pick");
            assert_eq!(picked.name, "OpenShell-1.1.0-macos-universal.dmg");
        }
    }

    #[test]
    fn linux_prefers_appimage_over_deb() {
        let list = candidates(&[
            "OpenShell-1.1.0-linux-x86_64.deb",
            "OpenShell-1.1.0-linux-x86_64.AppImage",
        ]);
        let picked = pick(&list, Platform::Linux, Arch::X86_64, &v("1.1.0")).expect("pick");
        assert_eq!(picked.name, "OpenShell-1.1.0-linux-x86_64.AppImage");
    }

    #[test]
    fn ignores_checksums_and_signatures() {
        let list = candidates(&[
            "OpenShell-1.1.0-windows-x86_64.exe.sha256",
            "OpenShell-1.1.0-windows-x86_64.exe.sig",
            "SHA256SUMS.txt",
            "update-meta.json",
        ]);
        let err = pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).expect_err("no asset");
        assert_eq!(err.kind, UpdaterErrorKind::AssetNotFound);
    }

    #[test]
    fn rejects_wrong_architecture_or_platform() {
        let list = candidates(&[
            "OpenShell-1.1.0-windows-aarch64.exe",
            "OpenShell-1.1.0-macos-universal.dmg",
            "OpenShell-1.1.0-linux-x86_64.AppImage",
        ]);
        let err = pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).expect_err("no asset");
        assert_eq!(err.kind, UpdaterErrorKind::AssetNotFound);
        let details = err.details.expect("details");
        assert_eq!(details["expected"], "OpenShell-1.1.0-windows-x86_64.exe");
    }

    #[test]
    fn accepts_legacy_naming_without_platform_token() {
        let list = candidates(&["OpenShell-Setup-1.0.9.exe"]);
        let picked = pick(&list, Platform::Windows, Arch::X86_64, &v("1.0.9")).expect("pick");
        assert_eq!(picked.name, "OpenShell-Setup-1.0.9.exe");
    }

    #[test]
    fn rejects_conflicting_platform_token_inside_name() {
        // 后缀是 .exe 但名字里写了 linux：属于命名错误，不能猜
        let list = candidates(&["OpenShell-1.1.0-linux-x86_64.exe"]);
        assert!(pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).is_err());
    }

    #[test]
    fn prefers_canonical_name_over_decorated_one() {
        let list = candidates(&[
            "OpenShell-1.1.0-windows-x86_64-debug-symbols.exe",
            "OpenShell-1.1.0-windows-x86_64.exe",
        ]);
        let picked = pick(&list, Platform::Windows, Arch::X86_64, &v("1.1.0")).expect("pick");
        assert_eq!(picked.name, "OpenShell-1.1.0-windows-x86_64.exe");
    }
}
