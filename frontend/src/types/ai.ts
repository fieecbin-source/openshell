/**
 * AI 终端助手类型契约（阶段 1：模型配置与凭据）。
 *
 * 与后端 `backend/crates/core-domain/src/ai.rs` 及 `backend/crates/ai/src/error.rs` 一一对应。
 * 安全约束：API Key 只出现在 `AiProfileInput` 入参中，任何响应结构都不含密钥。
 */

export type AiWireKind =
  | "openai_chat"
  | "anthropic_messages"
  | "gemini_generate_content";

export type ApprovalPolicy = "manual" | "semi_auto" | "full_auto";

export type AiKeyBackend = "keyring" | "vault_file" | "unavailable";

export type AiErrorCode =
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_MODEL_NOT_FOUND"
  | "AI_NETWORK"
  | "AI_CERTIFICATE"
  | "AI_CONTEXT_TOO_LONG"
  | "AI_TIMEOUT"
  | "AI_CANCELLED"
  | "AI_BAD_REQUEST"
  | "AI_SERVER"
  | "AI_CONFIG"
  | "AI_KEYRING_UNAVAILABLE"
  | "AI_KEY_WRITE_FAILED"
  | "AI_KEY_DECRYPT_FAILED"
  | "AI_VAULT_LOCKED"
  | "AI_PARSE"
  | "AI_NOT_IMPLEMENTED"
  | "AI_INTERNAL";

/** 已保存的模型档案（不含密钥）。 */
export interface AiProfile {
  id: string;
  provider: string;
  label: string;
  base_url: string;
  model_id: string;
  wire: AiWireKind;
  default_policy: ApprovalPolicy;
  logo_key: string;
  verified_at: number | null;
  has_api_key: boolean;
  created_at: number;
  updated_at: number;
}

/** 保存档案入参；`api_key` 为空表示沿用旧密钥，空字符串表示清除。 */
export interface AiProfileInput {
  id?: string | null;
  provider: string;
  label: string;
  base_url: string;
  model_id: string;
  wire: AiWireKind;
  default_policy: ApprovalPolicy;
  logo_key?: string | null;
  api_key?: string | null;
}

export interface AiModelPreset {
  id: string;
  name: string;
}

export interface AiProviderPreset {
  key: string;
  name: string;
  logo_key: string;
  default_base_url: string;
  wire: AiWireKind;
  docs_url: string;
  verified_at: string;
  models: AiModelPreset[];
  local: boolean;
  /** 是否为编辑推荐的常用厂商（设置页首屏展示）。 */
  recommended: boolean;
}

export interface AiCatalogView {
  providers: AiProviderPreset[];
  source: string;
  fetched_at: string;
  version: string;
}

export interface AiConfigView {
  feature_enabled: boolean;
  active_profile_id: string | null;
  default_policy: ApprovalPolicy;
  profiles: AiProfile[];
  key_backend: AiKeyBackend;
  key_backend_message: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  message: string;
  code: string | null;
}

export interface CommandHistoryEntry {
  id: string;
  tab_id: string;
  command: string;
  exit_code: number | null;
  executed_at: number;
}

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  manual: "手动确认",
  semi_auto: "半自动",
  full_auto: "全自动",
};

export const AI_WIRE_LABELS: Record<AiWireKind, string> = {
  openai_chat: "OpenAI 兼容 Chat Completions",
  anthropic_messages: "Anthropic Messages",
  gemini_generate_content: "Google Gemini",
};
