import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ai/aiIpc", () => ({
  getAiConfig: vi.fn(),
  getAiCatalog: vi.fn(),
  saveAiProfile: vi.fn(),
  deleteAiProfile: vi.fn(),
  setActiveAiProfile: vi.fn(),
  testAiProfile: vi.fn(),
  getAiLogo: vi.fn(),
  setAiEnabled: vi.fn(),
}));

import * as aiIpc from "../lib/ai/aiIpc";
import { useAiSettingsStore, AI_CATALOG_FALLBACK_MESSAGE } from "./aiSettingsStore";
import type {
  AiCatalogView,
  AiConfigView,
  AiProfile,
  AiProfileInput,
  ProviderTestResult,
} from "../types/ai";

const CATALOG: AiCatalogView = {
  providers: [
    {
      key: "openai",
      name: "OpenAI",
      logo_key: "openai",
      default_base_url: "https://api.openai.com/v1",
      wire: "openai_chat",
      docs_url: "https://platform.openai.com/docs",
      verified_at: "2026-01-01",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      local: false,
      recommended: true,
    },
    {
      key: "ollama",
      name: "Ollama",
      logo_key: "ollama",
      default_base_url: "http://127.0.0.1:11434/v1",
      wire: "openai_chat",
      docs_url: "https://ollama.com",
      verified_at: "2026-01-01",
      models: [{ id: "llama3.1", name: "Llama 3.1" }],
      local: true,
      recommended: true,
    },
  ],
  source: "builtin",
  fetched_at: "2026-10-23",
  version: "1",
};

function makeConfig(profiles: AiProfile[] = [], enabled = true): AiConfigView {
  return {
    feature_enabled: enabled,
    active_profile_id: null,
    default_policy: "manual",
    profiles,
    key_backend: "keyring",
    key_backend_message: "密钥保存在系统钥匙串中",
  };
}

function makeProfile(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    id: "prof_1",
    provider: "openai",
    label: "我的 GPT",
    base_url: "https://api.openai.com/v1",
    model_id: "gpt-4o",
    wire: "openai_chat",
    default_policy: "manual",
    logo_key: "openai",
    verified_at: null,
    has_api_key: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const INPUT: AiProfileInput = {
  id: null,
  provider: "openai",
  label: "我的 GPT",
  base_url: "https://api.openai.com/v1",
  model_id: "gpt-4o",
  wire: "openai_chat",
  default_policy: "manual",
  logo_key: "openai",
  api_key: "sk-live-secret-123",
};

const AUTH_FAILED: ProviderTestResult = {
  ok: false,
  latency_ms: 120,
  model: "gpt-4o",
  message: "鉴权失败",
  code: "AI_AUTH",
};

const TEST_OK: ProviderTestResult = {
  ok: true,
  latency_ms: 88,
  model: "gpt-4o",
  message: "连接成功",
  code: null,
};

describe("aiSettingsStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAiSettingsStore.setState({
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
    });
  });

  it("load() 同时拉取 config 与 catalog", async () => {
    vi.mocked(aiIpc.getAiConfig).mockResolvedValue(makeConfig());
    vi.mocked(aiIpc.getAiCatalog).mockResolvedValue(CATALOG);

    await useAiSettingsStore.getState().load();

    const state = useAiSettingsStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.config?.feature_enabled).toBe(true);
    expect(state.catalog?.providers).toHaveLength(2);
    expect(state.catalogError).toBeNull();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("catalog 失败时降级但不丢 config", async () => {
    vi.mocked(aiIpc.getAiConfig).mockResolvedValue(makeConfig([makeProfile()]));
    vi.mocked(aiIpc.getAiCatalog).mockRejectedValue(new Error("catalog offline"));

    await useAiSettingsStore.getState().load();

    const state = useAiSettingsStore.getState();
    expect(state.catalogError).toBe(AI_CATALOG_FALLBACK_MESSAGE);
    expect(state.catalog).toBeNull();
    expect(state.config?.profiles).toHaveLength(1);
    expect(state.loading).toBe(false);
  });

  it("未配置 → 保存 → 测试失败 → 测试成功的完整状态迁移", async () => {
    vi.mocked(aiIpc.getAiConfig).mockResolvedValue(makeConfig([]));
    vi.mocked(aiIpc.getAiCatalog).mockResolvedValue(CATALOG);
    await useAiSettingsStore.getState().load();
    expect(useAiSettingsStore.getState().config?.profiles).toHaveLength(0);

    vi.mocked(aiIpc.saveAiProfile).mockResolvedValue(makeProfile());
    const saved = await useAiSettingsStore.getState().saveProfile(INPUT);

    expect(saved).toBe(true);
    expect(aiIpc.saveAiProfile).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: "sk-live-secret-123" })
    );

    const afterSave = useAiSettingsStore.getState();
    expect(afterSave.config?.profiles).toHaveLength(1);
    expect(afterSave.config?.profiles[0].has_api_key).toBe(true);
    expect(afterSave.lastSavedProfileId).toBe("prof_1");
    expect(afterSave.saving).toBe(false);
    // 明文密钥不得留在 store 的任何角落
    expect(JSON.stringify(afterSave)).not.toContain("sk-live-secret-123");

    vi.mocked(aiIpc.testAiProfile).mockResolvedValueOnce(AUTH_FAILED);
    const failed = await useAiSettingsStore.getState().testProfile("prof_1");
    expect(failed).toEqual(AUTH_FAILED);
    const afterFail = useAiSettingsStore.getState();
    expect(afterFail.lastTest?.ok).toBe(false);
    expect(afterFail.lastTest?.code).toBe("AI_AUTH");
    expect(afterFail.testingProfileId).toBeNull();

    vi.mocked(aiIpc.testAiProfile).mockResolvedValueOnce(TEST_OK);
    await useAiSettingsStore.getState().testProfile("prof_1");
    const afterOk = useAiSettingsStore.getState();
    expect(afterOk.lastTest?.ok).toBe(true);
    expect(afterOk.lastTest?.latency_ms).toBe(88);
    expect(afterOk.config?.profiles[0].verified_at).not.toBeNull();
  });

  it("saveProfile 失败时返回 false 并写入中文错误", async () => {
    vi.mocked(aiIpc.getAiConfig).mockResolvedValue(makeConfig());
    await useAiSettingsStore.getState().load();

    vi.mocked(aiIpc.saveAiProfile).mockRejectedValue({
      code: "AI_KEY_WRITE_FAILED",
      message: "无法写入系统钥匙串，请检查系统权限。",
    });

    const ok = await useAiSettingsStore.getState().saveProfile(INPUT);

    const state = useAiSettingsStore.getState();
    expect(ok).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.error).toBeTruthy();
    expect(state.error).toMatch(/[\u4e00-\u9fa5]/);
  });

  it("toggleEnabled 失败时回滚并给出中文错误", async () => {
    vi.mocked(aiIpc.getAiConfig).mockResolvedValue(makeConfig([], true));
    await useAiSettingsStore.getState().load();
    expect(useAiSettingsStore.getState().enabled).toBe(true);

    vi.mocked(aiIpc.setAiEnabled).mockRejectedValue(new Error("set_enabled failed"));

    await useAiSettingsStore.getState().toggleEnabled(false);

    const state = useAiSettingsStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.config?.feature_enabled).toBe(true);
    expect(state.error).toBeTruthy();
    expect(state.error).toMatch(/[\u4e00-\u9fa5]/);
  });

  it("logo 加载失败不抛错，成功则缓存为 data URL", async () => {
    vi.mocked(aiIpc.getAiLogo).mockRejectedValueOnce(new Error("logo missing"));
    await expect(
      useAiSettingsStore.getState().loadLogo("openai")
    ).resolves.toBeUndefined();
    expect(useAiSettingsStore.getState().logos).toEqual({});
    expect(useAiSettingsStore.getState().error).toBeNull();

    vi.mocked(aiIpc.getAiLogo).mockResolvedValueOnce("<svg><circle /></svg>");
    await useAiSettingsStore.getState().loadLogo("ollama");
    expect(useAiSettingsStore.getState().logos.ollama).toContain("data:image/svg+xml");
  });
});
