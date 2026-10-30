//! AI 终端助手领域类型：模型档案、厂商预设、授权档位与联通测试结果。
//!
//! 本模块只定义契约，不包含任何网络访问、凭据存储或 UI 逻辑。
//! 安全约束：`AiProfileInput.api_key` 只用于入参，不实现 `Serialize`，且析构时清零。

use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::Zeroize;

/// 协议线格式。`OpenAiChat` 同时覆盖 OpenAI / Azure OpenAI / OpenRouter / Ollama / LM Studio。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiWireKind {
    /// OpenAI 兼容 Chat Completions（`POST {base}/chat/completions`）。
    #[default]
    #[serde(rename = "openai_chat")]
    OpenAiChat,
    /// Anthropic Messages（`POST {base}/messages`）。
    AnthropicMessages,
    /// Google Gemini generateContent（`POST {base}/models/{model}:streamGenerateContent`）。
    GeminiGenerateContent,
}

impl AiWireKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai_chat",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "openai_chat" => Some(Self::OpenAiChat),
            "anthropic_messages" => Some(Self::AnthropicMessages),
            "gemini_generate_content" => Some(Self::GeminiGenerateContent),
            _ => None,
        }
    }
}

impl fmt::Display for AiWireKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 三档执行授权（阶段 1 仅作为档案默认值与设置项存储，行为在阶段 4 生效）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// 手动确认（默认）。
    #[default]
    Manual,
    /// 半自动：只读白名单自动执行，风险命令请求确认。
    SemiAuto,
    /// 全自动：本地 high 红线仍需二次确认。
    FullAuto,
}

impl ApprovalPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::SemiAuto => "semi_auto",
            Self::FullAuto => "full_auto",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "semi_auto" => Some(Self::SemiAuto),
            "full_auto" => Some(Self::FullAuto),
            _ => None,
        }
    }
}

impl fmt::Display for ApprovalPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 已保存的模型档案（不含任何密钥明文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiProfile {
    pub id: String,
    /// 厂商 key，与厂商目录一致（如 `deepseek`）；自定义端点为 `custom`。
    pub provider: String,
    pub label: String,
    pub base_url: String,
    pub model_id: String,
    pub wire: AiWireKind,
    pub default_policy: ApprovalPolicy,
    pub logo_key: String,
    /// 最近一次联通测试成功的时间（Unix 毫秒）。
    pub verified_at: Option<i64>,
    /// 系统凭据库/回退文件是否已有该档案的 Key；只用于 UI 展示。
    #[serde(default)]
    pub has_api_key: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 保存档案入参。`api_key` 仅用于写入凭据库，绝不出现在任何响应中。
#[derive(Clone, Deserialize)]
pub struct AiProfileInput {
    /// 为空表示新建。
    pub id: Option<String>,
    pub provider: String,
    pub label: String,
    pub base_url: String,
    pub model_id: String,
    pub wire: AiWireKind,
    pub default_policy: ApprovalPolicy,
    pub logo_key: Option<String>,
    /// 为空表示保留已有密钥；`Some("")` 表示清除密钥。
    pub api_key: Option<String>,
}

impl fmt::Debug for AiProfileInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AiProfileInput")
            .field("id", &self.id)
            .field("provider", &self.provider)
            .field("label", &self.label)
            .field("base_url", &self.base_url)
            .field("model_id", &self.model_id)
            .field("wire", &self.wire)
            .field("default_policy", &self.default_policy)
            .field("logo_key", &self.logo_key)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl Drop for AiProfileInput {
    fn drop(&mut self) {
        if let Some(key) = self.api_key.as_mut() {
            key.zeroize();
        }
    }
}

/// 厂商目录中的单个模型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiModelPreset {
    pub id: String,
    pub name: String,
}

/// 厂商预设（端点 / 鉴权线格式 / Logo / 官方文档 / 核实日期）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiProviderPreset {
    /// 与 `AiProfile.provider` 一致。
    pub key: String,
    pub name: String,
    pub logo_key: String,
    pub default_base_url: String,
    pub wire: AiWireKind,
    /// 官方文档链接（核实依据）。
    pub docs_url: String,
    /// 核实日期（`YYYY-MM-DD`）。
    pub verified_at: String,
    pub models: Vec<AiModelPreset>,
    /// 本地推理端点（Ollama / LM Studio / vLLM）。
    #[serde(default)]
    pub local: bool,
    /// 是否为编辑推荐的常用厂商（设置页首屏展示）。
    #[serde(default)]
    pub recommended: bool,
}

/// 厂商目录快照视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiCatalogView {
    pub providers: Vec<AiProviderPreset>,
    /// 数据来源（如 `models.dev`）。
    pub source: String,
    /// 快照拉取时间（RFC3339 或 `YYYY-MM-DD`）。
    pub fetched_at: String,
    /// 快照版本标识。
    pub version: String,
}

/// 完整配置视图（返回给前端，永不含密钥）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConfigView {
    /// 功能开关，默认 `false`。
    pub feature_enabled: bool,
    pub active_profile_id: Option<String>,
    /// 全局默认授权档位。
    pub default_policy: ApprovalPolicy,
    pub profiles: Vec<AiProfile>,
    /// 凭据后端：`keyring` / `vault_file` / `unavailable`。
    pub key_backend: String,
    /// 凭据后端说明（中文，用于设置页提示）。
    pub key_backend_message: String,
}

/// 一键联通测试结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTestResult {
    pub ok: bool,
    /// 首字延迟（毫秒）。
    pub latency_ms: u64,
    pub model: String,
    /// 面向用户的中文描述。
    pub message: String,
    /// 归一后的错误码（成功时为 `None`）。
    pub code: Option<String>,
}

/// 本地命令历史条目（阶段 2 补全数据源）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandHistoryEntry {
    pub id: String,
    pub tab_id: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub executed_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_and_policy_roundtrip() {
        for wire in [
            AiWireKind::OpenAiChat,
            AiWireKind::AnthropicMessages,
            AiWireKind::GeminiGenerateContent,
        ] {
            assert_eq!(AiWireKind::parse(wire.as_str()), Some(wire));
        }
        for policy in [
            ApprovalPolicy::Manual,
            ApprovalPolicy::SemiAuto,
            ApprovalPolicy::FullAuto,
        ] {
            assert_eq!(ApprovalPolicy::parse(policy.as_str()), Some(policy));
        }
        assert_eq!(ApprovalPolicy::default(), ApprovalPolicy::Manual);
        assert_eq!(AiWireKind::default(), AiWireKind::OpenAiChat);
    }

    #[test]
    fn serde_wire_values_match_as_str() {
        for wire in [
            AiWireKind::OpenAiChat,
            AiWireKind::AnthropicMessages,
            AiWireKind::GeminiGenerateContent,
        ] {
            let json = serde_json::to_string(&wire).expect("serialize wire");
            assert_eq!(json, format!("\"{}\"", wire.as_str()));
            let back: AiWireKind = serde_json::from_str(&json).expect("deserialize wire");
            assert_eq!(back, wire);
        }
        for policy in [
            ApprovalPolicy::Manual,
            ApprovalPolicy::SemiAuto,
            ApprovalPolicy::FullAuto,
        ] {
            let json = serde_json::to_string(&policy).expect("serialize policy");
            assert_eq!(json, format!("\"{}\"", policy.as_str()));
        }
    }

    #[test]
    fn profile_input_debug_never_prints_key() {
        let input = AiProfileInput {
            id: None,
            provider: "deepseek".into(),
            label: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model_id: "deepseek-chat".into(),
            wire: AiWireKind::OpenAiChat,
            default_policy: ApprovalPolicy::Manual,
            logo_key: None,
            api_key: Some("sk-super-secret".into()),
        };
        let debug = format!("{input:?}");
        assert!(!debug.contains("sk-super-secret"));
        assert!(debug.contains("<redacted>"));
    }
}
