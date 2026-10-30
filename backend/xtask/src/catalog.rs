//! `catalog fetch`：拉取 models.dev 快照并整理为运行时可内嵌的厂商目录。

use crate::util;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::Duration;

const SOURCE: &str = "https://models.dev/api.json";
const VERIFIED_AT: &str = "2026-10-23";
/// 全量厂商紧凑索引体积上限，超出时拒绝写入并保留旧文件。
const MAX_ALL_PROVIDERS_BYTES: usize = 2 * 1024 * 1024;

struct ProviderSpec {
    key: &'static str,
    name: &'static str,
    logo_key: &'static str,
    default_base_url: &'static str,
    wire: &'static str,
    docs_url: &'static str,
    /// models.dev 中的 provider id；`None` 表示不依赖快照（自定义端点）。
    snapshot_provider: Option<&'static str>,
    /// 推荐模型：(model id, 快照缺失时的展示名回退)。
    models: &'static [(&'static str, &'static str)],
    local: bool,
}

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        key: "openai",
        name: "OpenAI",
        logo_key: "openai",
        default_base_url: "https://api.openai.com/v1",
        wire: "openai_chat",
        docs_url: "https://platform.openai.com/docs/models",
        snapshot_provider: Some("openai"),
        models: &[
            ("gpt-5.4", "GPT-5.4"),
            ("gpt-5.1", "GPT-5.1"),
            ("gpt-5-mini", "GPT-5 mini"),
            ("gpt-5-nano", "GPT-5 nano"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "anthropic",
        name: "Anthropic",
        logo_key: "anthropic",
        default_base_url: "https://api.anthropic.com/v1",
        wire: "anthropic_messages",
        docs_url: "https://docs.anthropic.com/en/docs/about-claude/models",
        snapshot_provider: Some("anthropic"),
        models: &[
            ("claude-opus-4-8", "Claude Opus 4.8"),
            ("claude-sonnet-5", "Claude Sonnet 5"),
            ("claude-sonnet-4-5", "Claude Sonnet 4.5"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "google",
        name: "Google Gemini",
        logo_key: "google",
        default_base_url: "https://generativelanguage.googleapis.com/v1beta",
        wire: "gemini_generate_content",
        docs_url: "https://ai.google.dev/gemini-api/docs/models",
        snapshot_provider: Some("google"),
        models: &[
            ("gemini-4-argon", "Gemini 4 Argon"),
            ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "xai",
        name: "xAI",
        logo_key: "xai",
        default_base_url: "https://api.x.ai/v1",
        wire: "openai_chat",
        docs_url: "https://docs.x.ai/docs/models",
        snapshot_provider: Some("xai"),
        models: &[
            ("grok-4.7", "Grok 4.7"),
            ("grok-4.6", "Grok 4.6"),
            ("grok-4.5", "Grok 4.5"),
            ("grok-4.3", "Grok 4.3"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "openrouter",
        name: "OpenRouter",
        logo_key: "openrouter",
        default_base_url: "https://openrouter.ai/api/v1",
        wire: "openai_chat",
        docs_url: "https://openrouter.ai/models",
        snapshot_provider: Some("openrouter"),
        models: &[
            ("openrouter/auto", "Auto Router"),
            ("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"),
            ("openai/gpt-5.1", "GPT-5.1"),
            ("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "agentrouter",
        name: "AgentRouter",
        logo_key: "agentrouter",
        default_base_url: "https://agentrouter.org/v1",
        wire: "openai_chat",
        docs_url: "https://agentrouter.org/docs/opencode.html",
        snapshot_provider: Some("agentrouter"),
        models: &[
            ("glm-5.3", "GLM-5.3"),
            ("gpt-5.6-sol", "GPT-5.6 Sol"),
            ("claude-opus-4-8", "Claude Opus 4.8"),
            ("claude-opus-5", "Claude Opus 5"),
            ("deepseek-v4-flash", "DeepSeek V4 Flash"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "deepseek",
        name: "DeepSeek",
        logo_key: "deepseek",
        default_base_url: "https://api.deepseek.com/v1",
        wire: "openai_chat",
        docs_url: "https://api-docs.deepseek.com/quick_start/pricing",
        snapshot_provider: Some("deepseek"),
        models: &[
            ("deepseek-v4-pro", "DeepSeek V4 Pro"),
            ("deepseek-v4-flash", "DeepSeek V4 Flash"),
            ("deepseek-flash", "DeepSeek V4.1 Flash 1017"),
            (
                "deepseek-v4-flash-vision-exp",
                "DeepSeek V4 Flash Vision Exp",
            ),
        ],
        local: false,
    },
    ProviderSpec {
        key: "alibaba",
        name: "阿里云百炼（DashScope 兼容模式）",
        logo_key: "alibaba",
        default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        wire: "openai_chat",
        docs_url: "https://www.alibabacloud.com/help/en/model-studio/models",
        snapshot_provider: Some("alibaba-cn"),
        models: &[
            ("qwen3.8-max", "Qwen3.8 Max"),
            ("qwen3.7-max", "Qwen3.7 Max"),
            ("qwen3-max", "Qwen3 Max"),
            ("qwen3.6-plus", "Qwen3.6 Plus"),
            ("qwen3-coder-plus", "Qwen3 Coder Plus"),
            ("deepseek-v4-pro", "DeepSeek V4 Pro"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "zhipuai",
        name: "智谱 AI",
        logo_key: "zhipuai",
        default_base_url: "https://open.bigmodel.cn/api/paas/v4",
        wire: "openai_chat",
        docs_url: "https://docs.bigmodel.cn/cn/guide/start/pricing",
        snapshot_provider: Some("zhipuai"),
        models: &[
            ("glm-5.3", "GLM-5.3"),
            ("glm-5.2", "GLM-5.2"),
            ("glm-5.1", "GLM-5.1"),
            ("glm-4.7", "GLM-4.7"),
            ("glm-4.5-air", "GLM-4.5-Air"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "moonshotai",
        name: "月之暗面 Kimi",
        logo_key: "moonshotai",
        default_base_url: "https://api.moonshot.cn/v1",
        wire: "openai_chat",
        docs_url: "https://platform.moonshot.cn/docs/api/chat",
        snapshot_provider: Some("moonshotai-cn"),
        models: &[
            ("kimi-k3", "Kimi K3"),
            ("kimi-k2.7-code", "Kimi K2.7 Code"),
            ("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed"),
            ("kimi-k2.6", "Kimi K2.6"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "volcengine",
        name: "火山方舟（豆包）",
        logo_key: "volcengine",
        default_base_url: "https://ark.cn-beijing.volces.com/api/v3",
        wire: "openai_chat",
        docs_url: "https://www.volcengine.com/docs/82379/1330310",
        snapshot_provider: Some("volcengine"),
        models: &[
            ("doubao-seed-2-1-pro-260628", "Seed 2.1 Pro"),
            ("doubao-seed-2-0-pro-260215", "Seed 2.0 Pro"),
            ("doubao-seed-2-1-turbo-260628", "Seed 2.1 Turbo"),
            ("doubao-seed-2-0-code-preview-260215", "Seed 2.0 Code"),
            ("doubao-seed-1-6-251015", "Seed 1.6"),
        ],
        local: false,
    },
    ProviderSpec {
        key: "ollama",
        name: "Ollama（本地）",
        logo_key: "ollama",
        default_base_url: "http://localhost:11434/v1",
        wire: "openai_chat",
        docs_url: "https://docs.ollama.com/api/openai-compatibility",
        // models.dev 仅收录 ollama-cloud；本地 Ollama 可拉取同名模型 Tag。
        snapshot_provider: Some("ollama-cloud"),
        models: &[
            ("gpt-oss:20b", "GPT OSS 20B"),
            ("glm-5.2", "GLM-5.2"),
            ("deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
            ("kimi-k2.6", "Kimi K2.6"),
        ],
        local: true,
    },
    ProviderSpec {
        key: "custom",
        name: "自定义 OpenAI 兼容端点",
        logo_key: "custom",
        default_base_url: "https://your-endpoint.example/v1",
        wire: "openai_chat",
        docs_url: "https://platform.openai.com/docs/api-reference/chat",
        snapshot_provider: None,
        models: &[
            ("gpt-4o-mini", "GPT-4o mini"),
            ("gpt-4.1", "GPT-4.1"),
            ("claude-sonnet-4-5", "Claude Sonnet 4.5"),
        ],
        local: false,
    },
];

#[derive(Serialize)]
struct CatalogFile {
    source: String,
    fetched_at: String,
    version: String,
    sha256: String,
    providers: Vec<ProviderPreset>,
}

/// 全量厂商紧凑索引：只保留调用所需字段，控制内嵌体积。
#[derive(Serialize)]
struct AllProvidersFile {
    source: String,
    fetched_at: String,
    version: String,
    providers: Vec<CompactProvider>,
}

#[derive(Serialize)]
struct CompactProvider {
    key: String,
    name: String,
    api: String,
    docs_url: String,
    wire: String,
    models: Vec<ModelPreset>,
}

#[derive(Serialize)]
struct ProviderPreset {
    key: String,
    name: String,
    logo_key: String,
    default_base_url: String,
    wire: String,
    docs_url: String,
    verified_at: String,
    models: Vec<ModelPreset>,
    local: bool,
}

#[derive(Serialize)]
struct ModelPreset {
    id: String,
    name: String,
}

pub fn fetch() {
    let root = util::workspace_root();
    let assets = root.join("backend/crates/ai/assets/catalog");
    let snapshot_path = assets.join("models_snapshot.json");
    let catalog_path = assets.join("catalog.json");
    let all_providers_path = assets.join("all_providers.json");

    let client = match reqwest::blocking::Client::builder()
        .user_agent("openshell-xtask/1.0 (+https://example.invalid/openshell)")
        .timeout(Duration::from_secs(90))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            warn_keep_existing(&format!("HTTP 客户端初始化失败：{err}"));
            return;
        }
    };

    println!("→ 拉取 {SOURCE}");
    let response = match client.get(SOURCE).send() {
        Ok(response) => response,
        Err(err) => {
            warn_keep_existing(&format!("请求失败：{err}"));
            return;
        }
    };
    if !response.status().is_success() {
        warn_keep_existing(&format!("远端返回 HTTP {}", response.status()));
        return;
    }
    let bytes = match response.bytes() {
        Ok(bytes) => bytes,
        Err(err) => {
            warn_keep_existing(&format!("读取响应失败：{err}"));
            return;
        }
    };
    if bytes.len() > 32 * 1024 * 1024 {
        warn_keep_existing("快照体积异常（>32MB），拒绝写入");
        return;
    }
    let snapshot: Value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) if value.is_object() => value,
        Ok(_) => {
            warn_keep_existing("快照根节点不是 JSON 对象");
            return;
        }
        Err(err) => {
            warn_keep_existing(&format!("快照不是合法 JSON：{err}"));
            return;
        }
    };

    let sha256 = hex_sha256(&bytes);
    let now = time::OffsetDateTime::now_utc();
    let fetched_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "2026-10-23T00:00:00Z".to_string());
    let date = now
        .format(time::macros::format_description!("[year]-[month]-[day]"))
        .unwrap_or_else(|_| VERIFIED_AT.to_string());
    let version = format!("{date}-{}", &sha256[..8]);

    if let Err(err) = fs::create_dir_all(&assets) {
        eprintln!("⚠ 无法创建目录 {}：{err}", assets.display());
        return;
    }
    if let Err(err) = write_if_changed(&snapshot_path, &bytes) {
        eprintln!("⚠ 写入快照失败 {}：{err}", snapshot_path.display());
        return;
    }

    let mut providers = Vec::with_capacity(PROVIDERS.len());
    let mut snapshot_models = 0usize;
    let mut fallback_models = 0usize;
    for spec in PROVIDERS {
        let models = spec
            .models
            .iter()
            .map(|(id, fallback_name)| {
                let from_snapshot = spec
                    .snapshot_provider
                    .and_then(|provider| snapshot_model_name(&snapshot, provider, id));
                let (name, hit) = match from_snapshot {
                    Some(name) => (name, true),
                    None => {
                        fallback_models += 1;
                        ((*fallback_name).to_string(), false)
                    }
                };
                if hit {
                    snapshot_models += 1;
                }
                ModelPreset {
                    id: (*id).to_string(),
                    name,
                }
            })
            .collect();
        providers.push(ProviderPreset {
            key: spec.key.to_string(),
            name: spec.name.to_string(),
            logo_key: spec.logo_key.to_string(),
            default_base_url: spec.default_base_url.to_string(),
            wire: spec.wire.to_string(),
            docs_url: spec.docs_url.to_string(),
            verified_at: VERIFIED_AT.to_string(),
            models,
            local: spec.local,
        });
    }

    let catalog = CatalogFile {
        source: SOURCE.to_string(),
        fetched_at: fetched_at.clone(),
        version: version.clone(),
        sha256: sha256.clone(),
        providers,
    };
    let json = match serde_json::to_vec_pretty(&catalog) {
        Ok(json) => json,
        Err(err) => {
            eprintln!("⚠ 序列化 catalog.json 失败：{err}");
            return;
        }
    };
    if let Err(err) = fs::write(&catalog_path, &json) {
        eprintln!("⚠ 写入 {} 失败：{err}", catalog_path.display());
        return;
    }

    let (compact_providers, skipped) = build_all_providers(&snapshot);
    let all_file = AllProvidersFile {
        source: SOURCE.to_string(),
        fetched_at: fetched_at.clone(),
        version: version.clone(),
        providers: compact_providers,
    };
    let all_json = match serde_json::to_vec(&all_file) {
        Ok(json) => json,
        Err(err) => {
            eprintln!("⚠ 序列化 all_providers.json 失败：{err}");
            return;
        }
    };
    if all_json.len() > MAX_ALL_PROVIDERS_BYTES {
        eprintln!(
            "⚠ 全量厂商索引体积异常（{} 字节，上限 {}），已保留旧文件",
            all_json.len(),
            MAX_ALL_PROVIDERS_BYTES
        );
    } else if let Err(err) = fs::write(&all_providers_path, &all_json) {
        eprintln!("⚠ 写入 {} 失败：{err}", all_providers_path.display());
        return;
    } else {
        println!("✓ 全量厂商索引已写入 {}", all_providers_path.display());
    }

    println!("✓ 快照已写入 {}", snapshot_path.display());
    println!("✓ 目录已写入 {}", catalog_path.display());
    let compact_models: usize = all_file
        .providers
        .iter()
        .map(|provider| provider.models.len())
        .sum();
    println!(
        "  source={SOURCE}\n  fetched_at={fetched_at}\n  version={version}\n  sha256={sha256}\n  精选厂商 {} 家；推荐模型 {} 个（快照命中 {snapshot_models}，回退 {fallback_models}）\n  全量可用厂商 {} 家；模型 {} 个；跳过 {} 家（缺少 api 或协议不受支持）\n  全量索引 {} 字节",
        catalog.providers.len(),
        catalog.providers.iter().map(|p| p.models.len()).sum::<usize>(),
        all_file.providers.len(),
        compact_models,
        skipped,
        all_json.len()
    );
}

fn snapshot_model_name(snapshot: &Value, provider: &str, model_id: &str) -> Option<String> {
    snapshot
        .get(provider)?
        .get("models")?
        .get(model_id)?
        .get("name")?
        .as_str()
        .map(str::to_string)
}

/// 由 models.dev 的 npm 包名推导可用的线格式；无法映射的厂商直接跳过。
fn wire_from_npm(npm: &str) -> Option<&'static str> {
    match npm {
        "@ai-sdk/openai-compatible" | "@ai-sdk/openai" | "@openrouter/ai-sdk-provider" => {
            Some("openai_chat")
        }
        "@ai-sdk/anthropic" => Some("anthropic_messages"),
        "@ai-sdk/google" => Some("gemini_generate_content"),
        _ => None,
    }
}

/// 从快照构建全量厂商紧凑索引（仅保留有 api 且协议可映射的厂商）。
fn build_all_providers(snapshot: &Value) -> (Vec<CompactProvider>, usize) {
    let Some(root) = snapshot.as_object() else {
        return (Vec::new(), 0);
    };
    let mut providers = Vec::new();
    let mut skipped = 0usize;

    for (key, provider) in root {
        let api = provider
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let npm = provider.get("npm").and_then(Value::as_str).unwrap_or("");
        let Some(wire) = wire_from_npm(npm) else {
            skipped += 1;
            continue;
        };
        // 部分厂商的 api 是模板占位（如 `${NEON_AI_GATEWAY_BASE_URL}/v1`），无法直接使用。
        if !api.starts_with("http://") && !api.starts_with("https://") {
            skipped += 1;
            continue;
        }

        let name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(key)
            .to_string();
        let docs_url = provider
            .get("doc")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let mut models: Vec<ModelPreset> = provider
            .get("models")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(id, model)| {
                        let model_id = model.get("id").and_then(Value::as_str).unwrap_or(id);
                        if model_id.trim().is_empty() {
                            return None;
                        }
                        let model_name = model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(model_id);
                        Some(ModelPreset {
                            id: model_id.to_string(),
                            name: model_name.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        models.sort_by(|left, right| left.id.cmp(&right.id));
        if models.is_empty() {
            skipped += 1;
            continue;
        }

        providers.push(CompactProvider {
            key: key.clone(),
            name,
            api: api.to_string(),
            docs_url,
            wire: wire.to_string(),
            models,
        });
    }

    providers.sort_by(|left, right| left.key.cmp(&right.key));
    (providers, skipped)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Ok(existing) = fs::read(path) {
        if existing == bytes {
            return Ok(());
        }
    }
    fs::write(path, bytes)
}

fn warn_keep_existing(reason: &str) {
    eprintln!("⚠ 厂商目录拉取失败：{reason}");
    eprintln!("  已保留仓库内现有快照与 catalog.json，构建将继续（退出码 0）。");
}
