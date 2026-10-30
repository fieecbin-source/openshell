//! 厂商目录与 Logo 资源。
//!
//! `catalog.json` 与 `assets/logos/*.svg` 由 `cargo run -p openshell-xtask -- catalog fetch`
//! 与 `logos sync` 在构建期生成并随二进制内嵌；运行时只读内置资源，不依赖外网。
//!
//! 安全约束：Logo 下载内容在生成阶段已完成脚本/内联事件校验；本模块只暴露静态字符串。

use openshell_core_domain::{AiCatalogView, AiModelPreset, AiProviderPreset, AiWireKind};
use serde::Deserialize;
use std::sync::OnceLock;

use crate::error::AiError;

pub mod logos_generated;

const CATALOG_JSON: &str = include_str!("../../assets/catalog/catalog.json");
const ALL_PROVIDERS_JSON: &str = include_str!("../../assets/catalog/all_providers.json");

/// 厂商 Logo 缺失或 key 未知时使用的赛博朋克风格 AI 核心图标。
const DEFAULT_LOGO: &str = include_str!("../../assets/logos/custom.svg");

static CATALOG: OnceLock<Result<AiCatalogView, String>> = OnceLock::new();

/// 目录文件中间结构：`wire` 使用 `AiWireKind::as_str()` 的线值，
/// 再经 `AiWireKind::parse` 归一，避免依赖枚举的 serde 派生命名。
#[derive(Deserialize)]
struct CatalogFile {
    source: String,
    fetched_at: String,
    version: String,
    providers: Vec<ProviderPresetFile>,
}

#[derive(Deserialize)]
struct ProviderPresetFile {
    key: String,
    name: String,
    logo_key: String,
    default_base_url: String,
    wire: String,
    docs_url: String,
    verified_at: String,
    models: Vec<AiModelPreset>,
    #[serde(default)]
    local: bool,
}

/// 全量厂商紧凑索引（`cargo run -p openshell-xtask -- catalog fetch` 生成）。
#[derive(Deserialize)]
struct AllProvidersFile {
    #[serde(default)]
    fetched_at: String,
    #[serde(default)]
    providers: Vec<CompactProviderFile>,
}

#[derive(Deserialize)]
struct CompactProviderFile {
    key: String,
    name: String,
    api: String,
    #[serde(default)]
    docs_url: String,
    wire: String,
    #[serde(default)]
    models: Vec<AiModelPreset>,
}

/// 解析并返回内置厂商目录快照（进程内只解析一次）。
pub fn catalog() -> Result<&'static AiCatalogView, AiError> {
    CATALOG
        .get_or_init(parse_catalog)
        .as_ref()
        .map_err(|message| AiError::parse(message.clone()))
}

fn parse_catalog() -> Result<AiCatalogView, String> {
    let raw: CatalogFile =
        serde_json::from_str(CATALOG_JSON).map_err(|err| format!("内置厂商目录解析失败：{err}"))?;
    let mut providers = Vec::with_capacity(raw.providers.len());
    let mut seen = std::collections::HashSet::new();
    for preset in raw.providers {
        let wire = AiWireKind::parse(&preset.wire)
            .ok_or_else(|| format!("厂商 {} 的 wire 值不合法：{}", preset.key, preset.wire))?;
        seen.insert(preset.key.clone());
        providers.push(AiProviderPreset {
            key: preset.key,
            name: preset.name,
            logo_key: preset.logo_key,
            default_base_url: preset.default_base_url,
            wire,
            docs_url: preset.docs_url,
            verified_at: preset.verified_at,
            models: preset.models,
            local: preset.local,
            recommended: true,
        });
    }

    let full: AllProvidersFile = serde_json::from_str(ALL_PROVIDERS_JSON)
        .map_err(|err| format!("全量厂商索引解析失败：{err}"))?;
    let verified_at = full
        .fetched_at
        .get(..10)
        .unwrap_or(full.fetched_at.as_str())
        .to_string();
    for preset in full.providers {
        if !seen.insert(preset.key.clone()) {
            continue;
        }
        let wire = AiWireKind::parse(&preset.wire)
            .ok_or_else(|| format!("全量厂商 {} 的 wire 值不合法：{}", preset.key, preset.wire))?;
        providers.push(AiProviderPreset {
            key: preset.key.clone(),
            name: preset.name,
            logo_key: preset.key,
            default_base_url: preset.api,
            wire,
            docs_url: preset.docs_url,
            verified_at: verified_at.clone(),
            models: preset.models,
            local: false,
            recommended: false,
        });
    }

    Ok(AiCatalogView {
        providers,
        source: raw.source,
        fetched_at: raw.fetched_at,
        version: raw.version,
    })
}

/// 按厂商 key 查找预设。
pub fn provider(key: &str) -> Option<&'static AiProviderPreset> {
    catalog()
        .ok()?
        .providers
        .iter()
        .find(|preset| preset.key == key)
}

/// 返回厂商 Logo SVG 文本。未知 key 也会返回内置默认图标，因此始终为 `Some`。
pub fn logo_svg(key: &str) -> Option<&'static str> {
    Some(logos_generated::logo_svg(key).unwrap_or(DEFAULT_LOGO))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::AiWireKind;
    use std::collections::HashSet;

    #[test]
    fn catalog_parses_with_expected_metadata() {
        let catalog = catalog().expect("内置 catalog.json 应可解析");
        assert_eq!(catalog.source, "https://models.dev/api.json");
        assert!(!catalog.fetched_at.trim().is_empty());
        assert!(!catalog.version.trim().is_empty());
        assert!(catalog.providers.len() >= 10, "厂商预设应不少于 10 家");

        let documented = catalog
            .providers
            .iter()
            .filter(|preset| {
                preset.docs_url.starts_with("https://") && !preset.verified_at.trim().is_empty()
            })
            .count();
        assert!(documented >= 6, "带官方文档与核实日期的厂商应不少于 6 家");
    }

    #[test]
    fn presets_are_unique_and_wire_matches_endpoint() {
        let catalog = catalog().expect("内置 catalog.json 应可解析");
        let mut keys = HashSet::new();
        for preset in &catalog.providers {
            assert!(
                keys.insert(preset.key.as_str()),
                "厂商 key 重复：{}",
                preset.key
            );
            assert!(!preset.name.trim().is_empty());
            assert!(
                preset.default_base_url.starts_with("http"),
                "端点应为 http(s) URL"
            );
            assert!(!preset.models.is_empty(), "{} 缺少推荐模型", preset.key);
            for model in &preset.models {
                assert!(!model.id.trim().is_empty());
                assert!(!model.name.trim().is_empty());
            }

            let expected = match preset.key.as_str() {
                "anthropic" => AiWireKind::AnthropicMessages,
                "google" => AiWireKind::GeminiGenerateContent,
                "openai" | "xai" | "openrouter" | "agentrouter" | "deepseek" | "alibaba"
                | "zhipuai" | "moonshotai" | "volcengine" | "ollama" | "custom" => {
                    AiWireKind::OpenAiChat
                }
                _ => {
                    // 全量厂商的线格式由构建期按 npm 推导，这里只校验精选厂商。
                    assert!(!preset.recommended, "未覆盖的精选厂商：{}", preset.key);
                    preset.wire
                }
            };
            if preset.recommended {
                assert_eq!(preset.wire, expected, "{} 的线格式与端点不匹配", preset.key);
            }
        }

        let ollama = provider("ollama").expect("应存在 Ollama 预设");
        assert!(ollama.local);
        assert_eq!(ollama.default_base_url, "http://localhost:11434/v1");
        assert_eq!(ollama.wire, AiWireKind::OpenAiChat);
    }

    #[test]
    fn every_provider_logo_resolves_and_is_safe() {
        let catalog = catalog().expect("内置 catalog.json 应可解析");
        for preset in &catalog.providers {
            let svg = logo_svg(&preset.logo_key)
                .unwrap_or_else(|| panic!("{} 的 Logo 缺失", preset.logo_key));
            assert!(!svg.trim().is_empty(), "{} 的 Logo 为空", preset.logo_key);
            assert!(svg.contains("<svg"), "{} 不是 SVG", preset.logo_key);
            let lower = svg.to_ascii_lowercase();
            assert!(
                !lower.contains("<script"),
                "{} 的 Logo 含脚本",
                preset.logo_key
            );
            assert!(
                !lower.contains("javascript:"),
                "{} 的 Logo 含 javascript:",
                preset.logo_key
            );
            assert!(
                !lower.contains("onload="),
                "{} 的 Logo 含内联事件",
                preset.logo_key
            );
            assert!(
                !lower.contains("onerror="),
                "{} 的 Logo 含内联事件",
                preset.logo_key
            );
        }

        assert!(logo_svg("provider_that_does_not_exist").is_some());
        assert!(logos_generated::logo_keys().contains(&"custom"));
    }

    #[test]
    fn snapshot_metadata_is_complete() {
        let raw: serde_json::Value =
            serde_json::from_str(CATALOG_JSON).expect("catalog.json 应为合法 JSON");
        for field in ["source", "fetched_at", "version", "sha256"] {
            let value = raw
                .get(field)
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("缺少快照元数据字段：{field}"));
            assert!(!value.trim().is_empty(), "快照元数据字段为空：{field}");
        }
        let sha256 = raw["sha256"].as_str().unwrap();
        assert_eq!(sha256.len(), 64, "sha256 应为 64 位十六进制");
        assert!(sha256.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn full_catalog_is_merged_and_agentrouter_is_recommended() {
        let catalog = catalog().expect("厂商目录应可解析");
        assert!(
            catalog.providers.len() >= 190,
            "全量厂商应不少于 190 家，实际 {}",
            catalog.providers.len()
        );
        let recommended = catalog
            .providers
            .iter()
            .filter(|preset| preset.recommended)
            .count();
        assert_eq!(recommended, 13, "精选厂商应为 13 家");

        let agentrouter = provider("agentrouter").expect("应存在 AgentRouter 预设");
        assert!(agentrouter.recommended);
        assert_eq!(agentrouter.default_base_url, "https://agentrouter.org/v1");
        assert_eq!(agentrouter.wire, AiWireKind::OpenAiChat);
        assert!(agentrouter.models.len() >= 5);
        assert!(agentrouter.models.iter().any(|model| model.id == "glm-5.3"));

        // 精选厂商必须排在全量厂商之前。
        let last_recommended = catalog
            .providers
            .iter()
            .rposition(|preset| preset.recommended)
            .expect("存在精选厂商");
        assert!(catalog.providers[..=last_recommended]
            .iter()
            .all(|preset| preset.recommended));
    }

    #[test]
    fn all_providers_index_is_compact_and_valid() {
        assert!(
            ALL_PROVIDERS_JSON.len() < 2 * 1024 * 1024,
            "全量厂商索引不应超过 2 MB，实际 {} 字节",
            ALL_PROVIDERS_JSON.len()
        );
        let parsed: AllProvidersFile =
            serde_json::from_str(ALL_PROVIDERS_JSON).expect("all_providers.json 应为合法 JSON");
        assert!(!parsed.providers.is_empty());
        for preset in &parsed.providers {
            assert!(!preset.key.trim().is_empty());
            assert!(!preset.name.trim().is_empty());
            assert!(
                preset.api.starts_with("http://") || preset.api.starts_with("https://"),
                "{} 的端点不合法：{}",
                preset.key,
                preset.api
            );
            assert!(!preset.models.is_empty(), "{} 缺少模型", preset.key);
            assert!(
                AiWireKind::parse(&preset.wire).is_some(),
                "{} 的 wire 不合法：{}",
                preset.key,
                preset.wire
            );
        }
    }
}
