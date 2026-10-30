/**
 * AI 模型配置相关的 IPC 封装。
 *
 * 只负责命令名与参数映射，业务错误处理统一交给 `aiSettingsStore`。
 * 安全约束：API Key 仅在 `saveAiProfile` 的入参中出现，任何返回结构都不含明文密钥。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AiCatalogView,
  AiConfigView,
  AiProfile,
  AiProfileInput,
  ProviderTestResult,
} from "../../types/ai";

export async function getAiConfig(): Promise<AiConfigView> {
  return await invoke<AiConfigView>("ai_config_get");
}

export async function getAiCatalog(): Promise<AiCatalogView> {
  return await invoke<AiCatalogView>("ai_catalog_get");
}

export async function saveAiProfile(profile: AiProfileInput): Promise<AiProfile> {
  return await invoke<AiProfile>("ai_config_save", { profile });
}

export async function deleteAiProfile(profileId: string): Promise<void> {
  await invoke("ai_delete_profile", { profileId });
}

export async function setActiveAiProfile(profileId: string): Promise<void> {
  await invoke("ai_set_active_profile", { profileId });
}

export async function testAiProfile(profileId: string): Promise<ProviderTestResult> {
  return await invoke<ProviderTestResult>("ai_profile_test", { profileId });
}

export async function getAiLogo(logoKey: string): Promise<string> {
  return await invoke<string>("ai_logo_get", { logoKey });
}

export async function setAiEnabled(enabled: boolean): Promise<void> {
  await invoke("ai_set_enabled", { enabled });
}
