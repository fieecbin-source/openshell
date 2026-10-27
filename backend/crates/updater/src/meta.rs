//! Release 附带元数据：`update-meta.json` 与 `SHA256SUMS.txt` 的解析。
//!
//! 两者都是「可选但推荐」的：缺失时仍可检测更新，只是不允许自动安装（缺哈希）。

use crate::error::UpdaterError;
use serde::Deserialize;
use std::collections::HashMap;

/// `update-meta.json` 的结构。
///
/// ```json
/// {
///   "mandatory": true,
///   "min_supported_version": "1.0.5",
///   "notes": "本次为安全修复，建议所有用户升级",
///   "assets": [{ "name": "OpenShell-1.1.0-windows-x86_64.exe", "sha256": "…64位hex…" }]
/// }
/// ```
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReleaseMetaFile {
    #[serde(default)]
    pub mandatory: bool,
    #[serde(default)]
    pub min_supported_version: Option<String>,
    /// 覆盖 Release 正文的精简说明（Markdown）。
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub assets: Vec<MetaAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MetaAsset {
    pub name: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

impl ReleaseMetaFile {
    /// 资产名 → sha256。
    pub fn sha256_map(&self) -> HashMap<String, String> {
        self.assets
            .iter()
            .filter_map(|asset| {
                let hash = normalize_sha256(asset.sha256.as_deref()?)?;
                Some((asset.name.clone(), hash))
            })
            .collect()
    }
}

/// 解析 `update-meta.json`；畸形时返回 `InvalidPayload`（调用方应降级为「不上报强更、不允许自动装」）。
pub fn parse_update_meta(bytes: &[u8]) -> Result<ReleaseMetaFile, UpdaterError> {
    serde_json::from_slice(bytes)
        .map_err(|err| UpdaterError::invalid_payload(format!("update-meta.json is invalid: {err}")))
}

/// 解析 `SHA256SUMS.txt`（兼容 `hash  file` 与 `hash *file` 两种格式，忽略空行/注释）。
pub fn parse_sha256sums(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let name = name.trim_start_matches('*');
        if let Some(hash) = normalize_sha256(hash) {
            map.insert(name.to_string(), hash);
        }
    }
    map
}

/// 从清单里查某个文件名的哈希。
pub fn lookup_sha256(sums: &HashMap<String, String>, file_name: &str) -> Option<String> {
    sums.get(file_name).cloned().or_else(|| {
        // 有些清单会写成带路径的形式（`dist/OpenShell-...exe`）
        sums.iter()
            .find(|(name, _)| name.rsplit('/').next() == Some(file_name))
            .map(|(_, hash)| hash.clone())
    })
}

/// 归一化 sha256：去空白、转小写，必须是 64 位十六进制。
pub fn normalize_sha256(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .trim_start_matches("sha256:")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.len() == 64 && cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(cleaned)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn parses_update_meta() {
        let raw = format!(
            r#"{{"mandatory":true,"min_supported_version":"1.0.5","notes":"安全修复",
                "assets":[{{"name":"OpenShell-1.1.0-windows-x86_64.exe","sha256":"{HASH_A}"}}]}}"#
        );
        let meta = parse_update_meta(raw.as_bytes()).expect("parse");
        assert!(meta.mandatory);
        assert_eq!(meta.min_supported_version.as_deref(), Some("1.0.5"));
        assert_eq!(meta.notes.as_deref(), Some("安全修复"));
        assert_eq!(
            meta.sha256_map()
                .get("OpenShell-1.1.0-windows-x86_64.exe")
                .map(String::as_str),
            Some(HASH_A)
        );
    }

    #[test]
    fn rejects_malformed_meta() {
        assert!(parse_update_meta(b"{oops").is_err());
    }

    #[test]
    fn parses_sha256sums_variants() {
        let text = format!(
            "{HASH_A}  OpenShell-1.1.0-windows-x86_64.exe\n\
             {HASH_B} *OpenShell-1.1.0-macos-universal.dmg\n\
             # comment\n\nnot-a-hash  broken.exe\n"
        );
        let sums = parse_sha256sums(&text);
        assert_eq!(sums.len(), 2);
        assert_eq!(
            lookup_sha256(&sums, "OpenShell-1.1.0-windows-x86_64.exe").as_deref(),
            Some(HASH_A)
        );
        assert_eq!(
            lookup_sha256(&sums, "OpenShell-1.1.0-macos-universal.dmg").as_deref(),
            Some(HASH_B)
        );
        assert!(lookup_sha256(&sums, "missing.exe").is_none());
    }

    #[test]
    fn normalizes_hash_input() {
        assert_eq!(normalize_sha256(HASH_A), Some(HASH_A.to_string()));
        assert_eq!(
            normalize_sha256(&format!("sha256:{}", HASH_A.to_uppercase())),
            Some(HASH_A.to_string())
        );
        assert!(normalize_sha256("abc").is_none());
        assert!(normalize_sha256(&"z".repeat(64)).is_none());
    }
}
