//! 语义化版本处理。
//!
//! 版本比较一律走 `semver`，禁止字符串比较：`1.10.0` 必须大于 `1.9.0`，
//! 预发布版本（`1.2.0-rc.1`）必须小于同号正式版（`1.2.0`）。

use crate::error::UpdaterError;
use semver::Version;

/// 解析版本号，兼容 `v` / `V` 前缀与首尾空白。
///
/// 例：`v1.2.0` → `1.2.0`，` 1.0.0 ` → `1.0.0`。
pub fn normalize(raw: &str) -> Result<Version, UpdaterError> {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);

    if let Ok(version) = Version::parse(without_prefix) {
        return Ok(version);
    }

    // 兼容 `1` / `1.2` 这种简写：补足到三段再交给 semver
    if let Some(padded) = pad_short_version(without_prefix) {
        if let Ok(version) = Version::parse(&padded) {
            return Ok(version);
        }
    }

    Err(
        UpdaterError::invalid_payload("release tag is not a valid semver version")
            .with_details(serde_json::json!({ "raw": trimmed })),
    )
}

/// 把 `1` → `1.0.0`、`1.2` → `1.2.0`，保留预发布/构建后缀；不是纯数字段则返回 `None`。
fn pad_short_version(raw: &str) -> Option<String> {
    let split_at = raw.find(['-', '+']).unwrap_or(raw.len());
    let (main, suffix) = raw.split_at(split_at);
    let parts: Vec<&str> = main.split('.').collect();
    if parts.is_empty() || parts.len() >= 3 {
        return None;
    }
    if !parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let mut padded = parts.join(".");
    for _ in parts.len()..3 {
        padded.push_str(".0");
    }
    padded.push_str(suffix);
    Some(padded)
}

/// 宽松解析：失败返回 `None`（用于筛选列表里混入的非版本 tag）。
pub fn normalize_opt(raw: &str) -> Option<Version> {
    normalize(raw).ok()
}

/// 是否存在可用更新。
///
/// * `allow_downgrade = false`（默认）时，只有远端版本严格大于当前版本才算更新；
/// * 允许降级时，任何不相等的版本都提示（企业内测/回滚场景）。
pub fn is_update_available(latest: &Version, current: &Version, allow_downgrade: bool) -> bool {
    if allow_downgrade {
        latest != current
    } else {
        latest > current
    }
}

/// 当前版本是否已低于最低可升级版本（此时必须升级）。
pub fn is_below_minimum(current: &Version, minimum: Option<&Version>) -> bool {
    minimum.is_some_and(|min| current < min)
}

/// 展示用版本号（保留预发布与构建元数据）。
pub fn display(version: &Version) -> String {
    version.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(raw: &str) -> Version {
        normalize(raw).expect("valid version")
    }

    #[test]
    fn accepts_v_prefix_and_whitespace() {
        assert_eq!(v("v1.2.0").to_string(), "1.2.0");
        assert_eq!(v("V1.2.0").to_string(), "1.2.0");
        assert_eq!(v("  1.2.0\n").to_string(), "1.2.0");
        assert_eq!(v("1.2").to_string(), "1.2.0");
    }

    #[test]
    fn rejects_garbage() {
        assert!(normalize("nightly").is_err());
        assert!(normalize("").is_err());
        assert!(normalize("v1.2.0.0").is_err());
        assert!(normalize_opt("release-2024").is_none());
    }

    #[test]
    fn compares_numerically_not_lexicographically() {
        assert!(v("1.10.0") > v("1.9.0"));
        assert!(v("v2.0.0") > v("1.99.99"));
        assert!(v("1.0.10") > v("1.0.9"));
    }

    #[test]
    fn prerelease_is_lower_than_release() {
        assert!(v("1.0.0-rc.1") < v("1.0.0"));
        assert!(v("1.0.0-beta.2") < v("1.0.0-rc.1"));
        assert!(v("1.0.1-rc.1") > v("1.0.0"));
        // 当前是 rc，正式版已发布 → 有更新
        assert!(is_update_available(&v("1.0.0"), &v("1.0.0-rc.1"), false));
        // 当前已是正式版，远端只有更旧的 rc → 不算更新
        assert!(!is_update_available(&v("1.0.0-rc.1"), &v("1.0.0"), false));
        assert!(is_update_available(&v("1.0.1-rc.1"), &v("1.0.0"), false));
    }

    #[test]
    fn equal_versions_are_not_updates_unless_downgrade_allowed() {
        assert!(!is_update_available(&v("1.2.3"), &v("1.2.3"), false));
        assert!(!is_update_available(&v("1.2.3"), &v("1.2.3"), true));
        assert!(is_update_available(&v("1.2.2"), &v("1.2.3"), true));
        assert!(!is_update_available(&v("1.2.2"), &v("1.2.3"), false));
    }

    #[test]
    fn minimum_version_guard() {
        assert!(is_below_minimum(&v("0.9.0"), Some(&v("1.0.0"))));
        assert!(!is_below_minimum(&v("1.0.0"), Some(&v("1.0.0"))));
        assert!(!is_below_minimum(&v("0.9.0"), None));
    }
}
