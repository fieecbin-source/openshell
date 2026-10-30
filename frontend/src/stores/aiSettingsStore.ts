/**
 * AI 模型设置的前端状态机。
 *
 * 生命周期：idle → loading → ready / catalog_error；
 * 连接测试：idle → testing → test_ok / test_failed。
 *
 * 安全约束：API Key 只在 `saveProfile` 调用时透传给 IPC，绝不进入 store 状态，
 * 也不做任何持久化或日志输出。
 */

import { create } from "zustand";
import {
  deleteAiProfile,
  getAiCatalog,
  getAiConfig,
  getAiLogo,
  saveAiProfile,
  setActiveAiProfile,
  setAiEnabled,
  testAiProfile,
} from "../lib/ai/aiIpc";
import { formatFriendlyError } from "../lib/errors";
import type {
  AiCatalogView,
  AiConfigView,
  AiProfile,
  AiProfileInput,
  ProviderTestResult,
} from "../types/ai";

/** 厂商目录不可用时的中文降级提示（此时仍允许手动填写端点与模型）。 */
export const AI_CATALOG_FALLBACK_MESSAGE = "厂商目录暂时不可用，可手动填写端点与模型";

function toUserMessage(err: unknown, action: string): string {
  const friendly = formatFriendlyError(err);
  const readable = /[\u4e00-\u9fa5]/.test(friendly)
    ? friendly
    : "客户端暂时无法完成该操作，请稍后重试。";
  return `${action}失败：${readable}`;
}

export interface AiSettingsState {
  enabled: boolean;
  config: AiConfigView | null;
  catalog: AiCatalogView | null;
  /** 目录不可用时的中文降级提示 */
  catalogError: string | null;
  loading: boolean;
  saving: boolean;
  testingProfileId: string | null;
  lastTest: ProviderTestResult | null;
  /** 最近一次操作的中文错误 */
  error: string | null;
  /** logoKey -> SVG data URL 缓存 */
  logos: Record<string, string>;
  /** 最近一次保存成功的档案 id，供组件在保存后立即测试/激活 */
  lastSavedProfileId: string | null;

  load: () => Promise<void>;
  toggleEnabled: (next: boolean) => Promise<void>;
  loadLogo: (logoKey: string) => Promise<void>;
  saveProfile: (input: AiProfileInput) => Promise<boolean>;
  removeProfile: (profileId: string) => Promise<boolean>;
  activateProfile: (profileId: string) => Promise<boolean>;
  testProfile: (profileId: string) => Promise<ProviderTestResult | null>;
  resetTest: () => void;
}

export const useAiSettingsStore = create<AiSettingsState>((set, get) => ({
  enabled: false,
  config: null,
  catalog: null,
  catalogError: null,
  loading: false,
  saving: false,
  testingProfileId: null,
  lastTest: null,
  error: null,
  logos: {},
  lastSavedProfileId: null,

  load: async () => {
    set({ loading: true, error: null });
    const [configResult, catalogResult] = await Promise.allSettled([
      getAiConfig(),
      getAiCatalog(),
    ]);

    const patch: Partial<AiSettingsState> = { loading: false };

    if (configResult.status === "fulfilled") {
      patch.config = configResult.value;
      patch.enabled = configResult.value.feature_enabled;
    } else {
      patch.error = toUserMessage(configResult.reason, "加载 AI 配置");
    }

    if (catalogResult.status === "fulfilled") {
      patch.catalog = catalogResult.value;
      patch.catalogError = null;
    } else {
      patch.catalogError = AI_CATALOG_FALLBACK_MESSAGE;
    }

    set(patch);
  },

  toggleEnabled: async (next: boolean) => {
    const previous = get().enabled;
    set({ enabled: next, error: null });
    try {
      await setAiEnabled(next);
      const config = get().config;
      if (config) set({ config: { ...config, feature_enabled: next } });
    } catch (err) {
      set({ enabled: previous, error: toUserMessage(err, "切换 AI 功能") });
    }
  },

  loadLogo: async (logoKey: string) => {
    if (!logoKey) return;
    if (get().logos[logoKey]) return;
    try {
      const svg = await getAiLogo(logoKey);
      if (!svg) return;
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      set((state) => ({ logos: { ...state.logos, [logoKey]: dataUrl } }));
    } catch {
      // 静默失败：组件用 CSS 图标兜底，不上抛、不写 error
    }
  },

  saveProfile: async (input: AiProfileInput) => {
    set({ saving: true, error: null });
    try {
      const saved: AiProfile = await saveAiProfile(input);
      const current = get().config;
      let profiles: AiProfile[] = [saved];
      if (current) {
        profiles = current.profiles.some((p) => p.id === saved.id)
          ? current.profiles.map((p) => (p.id === saved.id ? saved : p))
          : [...current.profiles, saved];
      }
      set({
        saving: false,
        config: current ? { ...current, profiles } : current,
        lastSavedProfileId: saved.id,
      });
      return true;
    } catch (err) {
      set({ saving: false, error: toUserMessage(err, "保存模型配置") });
      return false;
    }
  },

  removeProfile: async (profileId: string) => {
    set({ error: null });
    try {
      await deleteAiProfile(profileId);
      const current = get().config;
      set({
        config: current
          ? {
              ...current,
              profiles: current.profiles.filter((p) => p.id !== profileId),
              active_profile_id:
                current.active_profile_id === profileId ? null : current.active_profile_id,
            }
          : current,
        lastSavedProfileId:
          get().lastSavedProfileId === profileId ? null : get().lastSavedProfileId,
      });
      return true;
    } catch (err) {
      set({ error: toUserMessage(err, "删除模型配置") });
      return false;
    }
  },

  activateProfile: async (profileId: string) => {
    set({ error: null });
    try {
      await setActiveAiProfile(profileId);
      const current = get().config;
      if (current) set({ config: { ...current, active_profile_id: profileId } });
      return true;
    } catch (err) {
      set({ error: toUserMessage(err, "设为当前模型") });
      return false;
    }
  },

  testProfile: async (profileId: string) => {
    set({ testingProfileId: profileId, lastTest: null, error: null });
    try {
      const result = await testAiProfile(profileId);
      const current = get().config;
      set({
        testingProfileId: null,
        lastTest: result,
        config: current
          ? {
              ...current,
              profiles: current.profiles.map((p) =>
                p.id === profileId && result.ok
                  ? { ...p, verified_at: Date.now() }
                  : p
              ),
            }
          : current,
      });
      return result;
    } catch (err) {
      set({ testingProfileId: null, error: toUserMessage(err, "测试连接") });
      return null;
    }
  },

  resetTest: () => set({ lastTest: null, testingProfileId: null }),
}));
