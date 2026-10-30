//! `logos sync`：下载厂商 SVG Logo 并生成内嵌映射。
//!
//! 覆盖范围 = 精选厂商（`LOGO_SOURCES`）+ `all_providers.json` 中的全量厂商。
//! 解析顺序：精选指定文件 → 别名文件 → 通用命名（`{key}-color.svg`、`{key}.svg`）
//! → models.dev → 既有本地文件 → 内置赛博朋克回退图标。

use crate::util::{self, BUILTIN_LOGO};
use flate2::read::GzDecoder;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read};
use std::time::Duration;
use tar::Archive;

const REGISTRY: &str = "https://registry.npmjs.org/@lobehub%2Ficons-static-svg";
const PINNED_TARBALL: &str =
    "https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.98.0.tgz";
const MODELS_DEV_LOGO: &str = "https://models.dev/logos";

/// Logo 资产总体积上限，超出时给出告警（当前目标 ≤3MB）。
const MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024;

/// (catalog provider key, @lobehub/icons-static-svg 中的文件名)
const LOGO_SOURCES: &[(&str, &str)] = &[
    ("openai", "openai.svg"),
    ("anthropic", "anthropic.svg"),
    ("google", "gemini-color.svg"),
    ("xai", "xai.svg"),
    ("openrouter", "openrouter-color.svg"),
    ("agentrouter", "agentrouter-color.svg"),
    ("deepseek", "deepseek-color.svg"),
    ("alibaba", "qwen-color.svg"),
    ("zhipuai", "zhipu-color.svg"),
    ("moonshotai", "kimi-color.svg"),
    ("volcengine", "doubao-color.svg"),
    ("ollama", "ollama.svg"),
    ("custom", ""),
];

/// 全量厂商中命名差异较大的 lobehub 图标文件名别名。
const LOGO_ALIASES: &[(&str, &[&str])] = &[
    ("agentrouter", &["agentrouter-color.svg", "agentrouter.svg"]),
    ("alibaba-cn", &["qwen-color.svg"]),
    ("alibaba-coding-plan", &["qwen-color.svg"]),
    ("alibaba-coding-plan-cn", &["qwen-color.svg"]),
    ("alibaba-token-plan", &["qwen-color.svg"]),
    ("alibaba-token-plan-cn", &["qwen-color.svg"]),
    ("bailing", &["lingyiwanwu-color.svg"]),
    ("minimax", &["minimax-color.svg"]),
    ("minimax-cn", &["minimax-color.svg"]),
    ("minimax-coding-plan", &["minimax-color.svg"]),
    ("minimax-cn-coding-plan", &["minimax-color.svg"]),
    ("siliconflow", &["siliconcloud-color.svg"]),
    ("siliconflow-cn", &["siliconcloud-color.svg"]),
    ("stepfun", &["stepfun-color.svg"]),
    ("stepfun-ai", &["stepfun-color.svg"]),
    ("stepfun-ai-step-plan", &["stepfun-color.svg"]),
    ("stepfun-step-plan", &["stepfun-color.svg"]),
    ("tencent", &["tencent-color.svg"]),
    ("tencent-coding-plan", &["tencent-color.svg"]),
    ("tencent-token-plan", &["tencent-color.svg"]),
    ("tencent-tokenhub", &["tencent-color.svg"]),
    ("xiaomi", &["xiaomi-color.svg"]),
    ("xiaomi-token-plan-ams", &["xiaomi-color.svg"]),
    ("xiaomi-token-plan-cn", &["xiaomi-color.svg"]),
    ("xiaomi-token-plan-sgp", &["xiaomi-color.svg"]),
    ("togetherai", &["togetherai-color.svg"]),
    ("huggingface", &["huggingface-color.svg"]),
    ("perplexity", &["perplexity-color.svg"]),
    ("perplexity-agent", &["perplexity-color.svg"]),
    ("groq", &["groq.svg"]),
    ("mistral", &["mistral-color.svg"]),
    ("cohere", &["cohere-color.svg"]),
    ("nvidia", &["nvidia-color.svg"]),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogoOrigin {
    LobeHub,
    ModelsDev,
    Existing,
    Builtin,
}

impl LogoOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::LobeHub => "lobehub",
            Self::ModelsDev => "models.dev",
            Self::Existing => "existing",
            Self::Builtin => "内置回退",
        }
    }
}

pub fn sync() {
    let root = util::workspace_root();
    let logos_dir = root.join("backend/crates/ai/assets/logos");
    let all_providers_path = root.join("backend/crates/ai/assets/catalog/all_providers.json");
    let generated_path = root.join("backend/crates/ai/src/catalog/logos_generated.rs");

    if let Err(err) = fs::create_dir_all(&logos_dir) {
        eprintln!("⚠ 无法创建 Logo 目录 {}：{err}", logos_dir.display());
        return;
    }

    let keys = collect_keys(&all_providers_path);
    println!(
        "→ 需要同步 {} 个厂商 Logo（精选 {} 个 + 全量）",
        keys.len(),
        LOGO_SOURCES.len()
    );

    let client = reqwest::blocking::Client::builder()
        .user_agent("openshell-xtask/1.0 (+https://example.invalid/openshell)")
        .timeout(Duration::from_secs(120))
        .build()
        .ok();

    let mut lobehub: HashMap<String, String> = HashMap::new();
    if let Some(client) = client.as_ref() {
        println!("→ 从 @lobehub/icons-static-svg 下载图标包");
        match download_lobehub(client) {
            Ok(icons) => {
                println!("  解压得到 {} 个可用图标", icons.len());
                lobehub = icons;
            }
            Err(err) => eprintln!("⚠ lobehub 图标包获取失败：{err}"),
        }
    }

    let mut written = 0usize;
    let mut falls_back = 0usize;
    let mut total_bytes = 0u64;
    let mut summary: Vec<String> = Vec::new();

    for key in &keys {
        let path = logos_dir.join(format!("{key}.svg"));
        let curated_file = LOGO_SOURCES
            .iter()
            .find(|(source_key, _)| source_key == key)
            .map(|(_, file)| *file)
            .unwrap_or_default();
        let mut origin = LogoOrigin::Builtin;
        let mut content: Option<String> = None;

        if !curated_file.is_empty() {
            if let Some(text) = lobehub
                .get(curated_file)
                .filter(|text| util::is_safe_svg(text))
            {
                content = Some(text.clone());
                origin = LogoOrigin::LobeHub;
            }
        }

        if content.is_none() {
            for candidate in lobehub_candidates(key) {
                if let Some(text) = lobehub
                    .get(&candidate)
                    .filter(|text| util::is_safe_svg(text))
                {
                    content = Some(text.clone());
                    origin = LogoOrigin::LobeHub;
                    break;
                }
            }
        }

        if content.is_none() && key != "custom" {
            if let Some(client) = client.as_ref() {
                let url = format!("{MODELS_DEV_LOGO}/{key}.svg");
                if let Ok(text) = fetch_text(client, &url) {
                    if util::is_safe_svg(&text) {
                        content = Some(text);
                        origin = LogoOrigin::ModelsDev;
                    } else {
                        eprintln!("⚠ 拒绝不安全的 SVG（{url}）");
                    }
                }
            }
        }

        if content.is_none() {
            if let Ok(existing) = fs::read_to_string(&path) {
                if util::is_safe_svg(&existing) {
                    content = Some(existing);
                    origin = LogoOrigin::Existing;
                }
            }
        }

        let (text, origin) = match content {
            Some(text) => (text, origin),
            None => (BUILTIN_LOGO.to_string(), LogoOrigin::Builtin),
        };
        if origin == LogoOrigin::Builtin {
            falls_back += 1;
        }
        total_bytes += text.len() as u64;
        if fs::write(&path, text.as_bytes()).is_ok() {
            written += 1;
        } else {
            eprintln!("⚠ 写入 {} 失败", path.display());
        }
        summary.push(format!("{key}={}", origin.as_str()));
    }

    if let Some(parent) = generated_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("⚠ 无法创建 {}：{err}", parent.display());
            return;
        }
    }
    let generated = render_generated(&keys);
    if let Err(err) = fs::write(&generated_path, generated) {
        eprintln!("⚠ 写入 {} 失败：{err}", generated_path.display());
        return;
    }

    println!("✓ 已写入 {written} 个 Logo 到 {}", logos_dir.display());
    println!("✓ 已生成 {}", generated_path.display());
    println!(
        "  资产总体积 {:.1} KB（上限 {} KB）",
        total_bytes as f64 / 1024.0,
        MAX_TOTAL_BYTES / 1024
    );
    println!("  其中使用内置赛博朋克回退图标 {falls_back} 个");
    if total_bytes > MAX_TOTAL_BYTES {
        eprintln!("⚠ Logo 资产超过体积预算，请精简或改用 models.dev 小尺寸图标");
    }
    if std::env::var_os("OPENSHELL_LOGOS_VERBOSE").is_some() {
        println!("  来源：{}", summary.join("，"));
    }
}

/// 精选 key（保持原有顺序）+ 全量索引中的其余 key（按字母序）。
/// 仅保留可安全用于文件名与 Rust 字符串的 key。
fn collect_keys(all_providers_path: &std::path::Path) -> Vec<String> {
    let mut keys: Vec<String> = LOGO_SOURCES
        .iter()
        .map(|(key, _)| (*key).to_string())
        .collect();
    let mut seen: std::collections::HashSet<String> = keys.iter().cloned().collect();

    let raw = fs::read_to_string(all_providers_path).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if let Some(providers) = parsed.get("providers").and_then(Value::as_array) {
        let mut extra: Vec<String> = Vec::new();
        for provider in providers {
            let Some(key) = provider.get("key").and_then(Value::as_str) else {
                continue;
            };
            if !is_safe_key(key) || seen.contains(key) {
                continue;
            }
            seen.insert(key.to_string());
            extra.push(key.to_string());
        }
        extra.sort();
        keys.extend(extra);
    } else {
        eprintln!(
            "⚠ 无法读取全量厂商索引 {}，仅同步精选 Logo",
            all_providers_path.display()
        );
    }
    keys
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// 通用命名候选：别名优先，其次 `{key}-color.svg`、`{key}.svg`。
fn lobehub_candidates(key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some((_, aliases)) = LOGO_ALIASES.iter().find(|(alias_key, _)| *alias_key == key) {
        out.extend(aliases.iter().map(|alias| (*alias).to_string()));
    }
    out.push(format!("{key}-color.svg"));
    out.push(format!("{key}.svg"));
    out
}

fn download_lobehub(client: &reqwest::blocking::Client) -> Result<HashMap<String, String>, String> {
    let tarball_url = match client.get(REGISTRY).send() {
        Ok(response) if response.status().is_success() => match response.json::<Value>() {
            Ok(meta) => meta
                .get("dist-tags")
                .and_then(|tags| tags.get("latest"))
                .and_then(Value::as_str)
                .and_then(|latest| {
                    meta.get("versions")?
                        .get(latest)?
                        .get("dist")?
                        .get("tarball")?
                        .as_str()
                })
                .map(str::to_string)
                .unwrap_or_else(|| PINNED_TARBALL.to_string()),
            Err(_) => PINNED_TARBALL.to_string(),
        },
        _ => PINNED_TARBALL.to_string(),
    };

    let bytes = fetch_bytes(client, &tarball_url)?;

    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(decoder);
    let entries = archive.entries().map_err(|err| err.to_string())?;
    let mut icons = HashMap::new();
    for entry in entries {
        let mut entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = match entry.path() {
            Ok(path) => path.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let Some(file) = path.strip_prefix("package/icons/") else {
            continue;
        };
        if !file.ends_with(".svg") || file.contains('/') {
            continue;
        }
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_ok() && util::is_safe_svg(&text) {
            icons.insert(file.to_string(), text);
        }
    }
    if icons.is_empty() {
        return Err("未找到可用的厂商图标".to_string());
    }
    Ok(icons)
}

fn fetch_bytes(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client.get(url).send().map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let bytes = response.bytes().map_err(|err| err.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("响应体积异常（>16MB）".to_string());
    }
    Ok(bytes.to_vec())
}

fn fetch_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let bytes = fetch_bytes(client, url)?;
    String::from_utf8(bytes).map_err(|_| "响应不是 UTF-8 文本".to_string())
}

fn render_generated(keys: &[String]) -> String {
    let mut out = String::from(
        "// 本文件由 `cargo run -p openshell-xtask -- logos sync` 自动生成，请勿手动修改。\n\
         // 图标来源：@lobehub/icons-static-svg（MIT）与 models.dev（MIT）；缺失时回退内置图标。\n\n\
         pub const LOGO_KEYS: &[&str] = &[\n",
    );
    for key in keys {
        out.push_str(&format!("    \"{key}\",\n"));
    }
    out.push_str("];\n\npub fn logo_keys() -> &'static [&'static str] {\n    LOGO_KEYS\n}\n\n");
    out.push_str("pub fn logo_svg(key: &str) -> Option<&'static str> {\n    match key {\n");
    for key in keys {
        out.push_str(&format!(
            "        \"{key}\" => Some(include_str!(\"../../assets/logos/{key}.svg\")),\n"
        ));
    }
    out.push_str("        _ => None,\n    }\n}\n");
    out
}
