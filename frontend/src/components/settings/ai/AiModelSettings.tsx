import { useEffect, useState } from "react";
import {
  AI_WIRE_LABELS,
  APPROVAL_POLICY_LABELS,
  type AiProfile,
  type AiProfileInput,
  type AiProviderPreset,
  type ApprovalPolicy,
} from "../../../types/ai";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, IconButton } from "../../ui/Button";
import { Checkbox, Switch } from "../../ui/Controls";
import { Field, Input, Select } from "../../ui/Field";
import { InlineNotice } from "../../ui/Notice";
import { ConfirmDialog } from "../../ui/Overlay";
import { Badge, EmptyState, Panel, SectionHeader, type Tone } from "../../ui/Surface";
import { ExternalLinkIcon, RefreshIcon, TrashIcon } from "../../ui/icons";
import { ProviderPicker } from "./ProviderPicker";
import { ModelCombobox } from "./ModelCombobox";
import { ProfileList } from "./ProfileList";

interface Draft {
  id: string | null;
  provider: string;
  label: string;
  base_url: string;
  model_id: string;
  wire: AiProfileInput["wire"];
  default_policy: ApprovalPolicy;
  logo_key: string;
}

interface Notice {
  tone: Tone;
  text: string;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  provider: "",
  label: "",
  base_url: "",
  model_id: "",
  wire: "openai_chat",
  default_policy: "manual",
  logo_key: "",
};

const POLICY_OPTIONS: ApprovalPolicy[] = ["manual", "semi_auto", "full_auto"];

const TEST_CODE_TEXT: Record<string, string> = {
  AI_AUTH: "鉴权失败：API Key 无效或没有访问该模型的权限，请核对密钥。",
  AI_RATE_LIMIT: "请求被限流：请稍后重试，或检查账户配额与并发限制。",
  AI_TIMEOUT: "请求超时：请检查网络状况与端点地址是否可达。",
  AI_MODEL_NOT_FOUND: "模型不存在：请确认模型标识在该厂商下可用。",
  AI_NETWORK: "网络不可用：请检查本机网络与端点地址。",
  AI_CERTIFICATE: "证书校验失败：请检查 HTTPS 证书或改用受信任的端点。",
  AI_CONFIG: "配置有误：请检查端点地址、协议与模型标识是否匹配。",
};

export function AiModelSettings() {
  const enabled = useAiSettingsStore((s) => s.enabled);
  const config = useAiSettingsStore((s) => s.config);
  const catalog = useAiSettingsStore((s) => s.catalog);
  const catalogError = useAiSettingsStore((s) => s.catalogError);
  const loading = useAiSettingsStore((s) => s.loading);
  const saving = useAiSettingsStore((s) => s.saving);
  const testingProfileId = useAiSettingsStore((s) => s.testingProfileId);
  const lastTest = useAiSettingsStore((s) => s.lastTest);
  const error = useAiSettingsStore((s) => s.error);
  const load = useAiSettingsStore((s) => s.load);
  const toggleEnabled = useAiSettingsStore((s) => s.toggleEnabled);
  const saveProfile = useAiSettingsStore((s) => s.saveProfile);
  const removeProfile = useAiSettingsStore((s) => s.removeProfile);
  const activateProfile = useAiSettingsStore((s) => s.activateProfile);
  const testProfile = useAiSettingsStore((s) => s.testProfile);
  const resetTest = useAiSettingsStore((s) => s.resetTest);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = catalog?.providers ?? [];
  const activeId = config?.active_profile_id ?? null;
  const editingProfile = config?.profiles.find((profile) => profile.id === draft.id) ?? null;
  const hasStoredKey = editingProfile?.has_api_key ?? false;
  const selectedProvider = providers.find((provider) => provider.key === draft.provider) ?? null;
  const modelOptions = selectedProvider?.models ?? [];
  const testing = testingProfileId !== null;

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setApiKey("");
    setClearApiKey(false);
    resetTest();
  };

  const applyProvider = (provider: AiProviderPreset) => {
    setDraft({
      id: null,
      provider: provider.key,
      label: provider.name,
      base_url: provider.default_base_url,
      model_id: provider.models[0]?.id ?? "",
      wire: provider.wire,
      default_policy: config?.default_policy ?? "manual",
      logo_key: provider.logo_key,
    });
    setApiKey("");
    setClearApiKey(false);
    resetTest();
    setNotice(
      provider.default_base_url
        ? null
        : { tone: "warning", text: "该厂商未收录 API 端点，请手动填写端点地址。" },
    );
  };

  const editProfile = (profile: AiProfile) => {
    setDraft({
      id: profile.id,
      provider: profile.provider,
      label: profile.label,
      base_url: profile.base_url,
      model_id: profile.model_id,
      wire: profile.wire,
      default_policy: profile.default_policy,
      logo_key: profile.logo_key,
    });
    setApiKey("");
    setClearApiKey(false);
    setNotice(null);
    resetTest();
  };

  const handleSave = async () => {
    setNotice(null);
    if (!draft.provider.trim()) {
      setNotice({ tone: "danger", text: "请先选择厂商，或在目录不可用时手动填写厂商标识。" });
      return;
    }
    if (!draft.label.trim()) {
      setNotice({ tone: "danger", text: "请填写档案名称。" });
      return;
    }
    if (!draft.base_url.trim()) {
      setNotice({ tone: "danger", text: "请填写 API 端点地址。" });
      return;
    }
    if (!/^https?:\/\//i.test(draft.base_url.trim())) {
      setNotice({
        tone: "danger",
        text: "端点地址需以 http:// 或 https:// 开头（本地端点允许 http）。",
      });
      return;
    }
    if (!draft.model_id.trim()) {
      setNotice({ tone: "danger", text: "请选择预设模型或手动输入模型标识。" });
      return;
    }

    const input: AiProfileInput = {
      id: draft.id,
      provider: draft.provider.trim(),
      label: draft.label.trim(),
      base_url: draft.base_url.trim(),
      model_id: draft.model_id.trim(),
      wire: draft.wire,
      default_policy: draft.default_policy,
      logo_key: draft.logo_key || null,
    };

    const trimmedKey = apiKey.trim();
    if (clearApiKey) {
      input.api_key = "";
    } else if (trimmedKey) {
      input.api_key = trimmedKey;
    }

    const ok = await saveProfile(input);
    if (!ok) return;

    const savedId = useAiSettingsStore.getState().lastSavedProfileId;
    if (savedId) setDraft((prev) => ({ ...prev, id: savedId }));
    // 密钥只提交一次，保存成功后立即从内存中清除输入框
    setApiKey("");
    setClearApiKey(false);
    resetTest();
    setNotice({ tone: "success", text: "模型配置已保存。" });
  };

  const handleTest = async () => {
    setNotice(null);
    if (!draft.id) {
      setNotice({ tone: "danger", text: "请先保存配置再测试连接。" });
      return;
    }
    await testProfile(draft.id);
  };

  const handleActivate = async () => {
    setNotice(null);
    if (!draft.id) {
      setNotice({ tone: "danger", text: "请先保存配置再设为当前模型。" });
      return;
    }
    const ok = await activateProfile(draft.id);
    if (ok) setNotice({ tone: "success", text: "已切换为当前使用的模型配置。" });
  };

  const handleDeleteConfirm = async () => {
    const profileId = deleteTargetId;
    if (!profileId) return;
    setNotice(null);
    const ok = await removeProfile(profileId);
    setDeleteTargetId(null);
    if (!ok) return;
    if (draft.id === profileId) resetDraft();
    setNotice({ tone: "success", text: "已删除该模型配置。" });
  };

  const openDocs = async () => {
    if (!selectedProvider?.docs_url) return;
    try {
      await openUrl(selectedProvider.docs_url);
    } catch {
      // 外部打开失败时保持静默
    }
  };

  if (!config) {
    return (
      <div className="space-y-3">
        <SectionHeader
          title="AI 模型"
          description="AI 功能默认关闭，开启后才会向模型发送上下文"
        />
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {catalogError && <InlineNotice tone="warning">{catalogError}</InlineNotice>}
        {loading ? (
          <EmptyState title="正在加载 AI 配置…" />
        ) : (
          <EmptyState
            title="暂时无法读取 AI 配置"
            description="请检查客户端状态后重试。"
            action={
              <Button variant="primary" onClick={() => void load()} leading={<RefreshIcon className="h-3.5 w-3.5" />}>
                重新加载
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Panel>
        <Switch
          checked={enabled}
          onChange={(next) => void toggleEnabled(next)}
          label="启用 AI 终端助手"
          hint="AI 功能默认关闭，开启后才会向模型发送上下文"
        />
      </Panel>

      {config.key_backend === "unavailable" ? (
        <InlineNotice tone="warning" title="凭据存储不可用">
          {config.key_backend_message || "系统钥匙串不可用，密钥可能无法安全保存。"}
        </InlineNotice>
      ) : (
        <p className="text-os-xs text-ink-tertiary">{config.key_backend_message}</p>
      )}

      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      {catalogError && <InlineNotice tone="warning">{catalogError}</InlineNotice>}
      {notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}

      <ProviderPicker
        providers={providers}
        selectedKey={draft.provider}
        onSelect={applyProvider}
        catalogMeta={
          catalog
            ? { source: catalog.source, version: catalog.version, fetched_at: catalog.fetched_at }
            : null
        }
        manualProvider={draft.provider}
        onManualProviderChange={(value) => setDraft((prev) => ({ ...prev, provider: value }))}
      />

      <Panel className="space-y-3">
        <SectionHeader
          title={draft.id ? "编辑模型档案" : "新建模型档案"}
          description={AI_WIRE_LABELS[draft.wire]}
          actions={
            <>
              {draft.id && activeId === draft.id && <Badge tone="accent">当前使用</Badge>}
              {selectedProvider?.docs_url && (
                <IconButton label="打开厂商文档" size="sm" onClick={() => void openDocs()}>
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </>
          }
        />

        <Field label="档案名称" htmlFor="ai-profile-label">
          <Input
            id="ai-profile-label"
            value={draft.label}
            onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
            placeholder="例如：团队共用 GPT-4o"
          />
        </Field>

        <Field label="API 端点" htmlFor="ai-profile-base-url" hint="本地端点允许 http://，其余请使用 https://">
          <Input
            id="ai-profile-base-url"
            mono
            value={draft.base_url}
            onChange={(event) => setDraft((prev) => ({ ...prev, base_url: event.target.value }))}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="协议">
            <div className="flex h-[34px] items-center rounded-os-md border border-line/10 bg-line/5 px-2.5 text-os-xs text-ink-secondary">
              {AI_WIRE_LABELS[draft.wire]}
            </div>
          </Field>
          <Field label="授权档位" htmlFor="ai-profile-policy">
            <Select
              id="ai-profile-policy"
              value={draft.default_policy}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  default_policy: event.target.value as ApprovalPolicy,
                }))
              }
            >
              {POLICY_OPTIONS.map((policy) => (
                <option key={policy} value={policy}>
                  {APPROVAL_POLICY_LABELS[policy]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="模型" hint="可搜索预设模型，也可直接输入任意模型 ID">
          <ModelCombobox
            models={modelOptions}
            value={draft.model_id}
            onChange={(modelId) => setDraft((prev) => ({ ...prev, model_id: modelId }))}
          />
        </Field>

        <Field
          label="API Key"
          htmlFor="ai-profile-key"
          hint="密钥仅在保存时提交一次，不会显示在界面上，也不会写入本地缓存。"
        >
          <div className="space-y-2">
            <Input
              id="ai-profile-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={hasStoredKey ? "已配置（留空保持不变）" : "请输入 API Key"}
            />
            {hasStoredKey && (
              <Checkbox
                checked={clearApiKey}
                onChange={setClearApiKey}
                label={<span className="text-os-xs text-ink-tertiary">清除已保存的密钥（保存后不再保留）</span>}
              />
            )}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" onClick={() => void handleSave()} loading={saving}>
            保存
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleTest()}
            disabled={!draft.id || saving}
            loading={testing}
          >
            测试连接
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleActivate()}
            disabled={!draft.id || saving || activeId === draft.id}
          >
            {activeId === draft.id ? "已是当前模型" : "设为当前模型"}
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-state-danger"
            onClick={() => draft.id && setDeleteTargetId(draft.id)}
            disabled={!draft.id || saving}
            leading={<TrashIcon className="h-3.5 w-3.5" />}
          >
            删除
          </Button>
        </div>

        {lastTest && (
          <InlineNotice tone={lastTest.ok ? "success" : "danger"}>
            {lastTest.ok
              ? `连接成功：${lastTest.model || "模型"}，耗时 ${lastTest.latency_ms} ms`
              : `连接失败：${
                  (lastTest.code && TEST_CODE_TEXT[lastTest.code]) ||
                  lastTest.message ||
                  "未知原因"
                }`}
          </InlineNotice>
        )}
      </Panel>

      <div className="space-y-2">
        <SectionHeader
          title="已保存的模型档案"
          description={config.profiles.length === 0 ? undefined : "点击档案可编辑"}
        />
        {config.profiles.length === 0 ? (
          <EmptyState
            title="尚未添加模型档案"
            description="选择厂商、填写 Key 后点击「保存」即可开始。"
          />
        ) : (
          <ProfileList
            profiles={config.profiles}
            activeId={activeId}
            selectedId={draft.id}
            busy={saving}
            onSelect={editProfile}
            onDelete={(profile) => setDeleteTargetId(profile.id)}
          />
        )}
      </div>

      {catalog && (
        <p className="text-os-2xs text-ink-tertiary">
          目录来源 {catalog.source} · 版本 {catalog.version} · 更新于 {catalog.fetched_at}
        </p>
      )}

      <ConfirmDialog
        open={deleteTargetId !== null}
        title="删除模型配置"
        message="确定删除该模型配置？此操作不可撤销。"
        confirmText="删除"
        tone="danger"
        busy={saving}
        onCancel={() => setDeleteTargetId(null)}
        onConfirm={() => void handleDeleteConfirm()}
      />
    </div>
  );
}
