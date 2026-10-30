import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AI_WIRE_LABELS, type AiProviderPreset } from "../../../types/ai";
import { Segmented } from "../../ui/Controls";
import { Input } from "../../ui/Field";
import { Badge, Card, EmptyState, SectionHeader } from "../../ui/Surface";
import { CheckIcon, ExternalLinkIcon, SearchIcon } from "../../ui/icons";
import { cn } from "../../ui/cn";
import { ProviderLogo } from "./ProviderLogo";

type PickerMode = "recommended" | "all";

export interface ProviderPickerProps {
  providers: AiProviderPreset[];
  selectedKey: string;
  onSelect: (provider: AiProviderPreset) => void;
  catalogMeta?: { source: string; version: string; fetched_at: string } | null;
  /** 目录不可用时，允许手动填写厂商标识。 */
  manualProvider: string;
  onManualProviderChange: (value: string) => void;
}

const ROW_HEIGHT = 46;

async function openDocs(url: string) {
  try {
    await openUrl(url);
  } catch {
    // 外部打开失败时保持静默，不影响设置页主流程
  }
}

/** 厂商选择：推荐网格 + 全量可搜索虚拟列表。 */
export function ProviderPicker({
  providers,
  selectedKey,
  onSelect,
  catalogMeta,
  manualProvider,
  onManualProviderChange,
}: ProviderPickerProps) {
  const [mode, setMode] = useState<PickerMode>("recommended");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const recommended = useMemo(() => {
    const picked = providers.filter((provider) => provider.recommended);
    return picked.length > 0 ? picked : providers.slice(0, 13);
  }, [providers]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return providers;
    return providers.filter((provider) => {
      if (provider.name.toLowerCase().includes(keyword)) return true;
      if (provider.key.toLowerCase().includes(keyword)) return true;
      return provider.models.some(
        (model) =>
          model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword),
      );
    });
  }, [providers, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const selected = providers.find((provider) => provider.key === selectedKey) ?? null;

  if (providers.length === 0) {
    return (
      <div className="space-y-2">
        <SectionHeader
          title="厂商"
          description="厂商目录暂不可用，可手动填写厂商标识与端点"
        />
        <Input
          value={manualProvider}
          onChange={(event) => onManualProviderChange(event.target.value)}
          placeholder="厂商标识，例如 openai / anthropic / ollama"
          mono
        />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <SectionHeader
        title="厂商"
        description={
          catalogMeta
            ? `推荐 ${recommended.length} 家 · 全部 ${providers.length} 家 · 目录 ${catalogMeta.version}`
            : `推荐 ${recommended.length} 家 · 全部 ${providers.length} 家`
        }
        actions={
          <Segmented<PickerMode>
            value={mode}
            onChange={setMode}
            size="sm"
            ariaLabel="厂商范围"
            options={[
              { value: "recommended", label: `推荐 ${recommended.length}` },
              { value: "all", label: `全部 ${providers.length}` },
            ]}
          />
        }
      />

      {mode === "recommended" ? (
        <div className="grid grid-cols-4 gap-2">
          {recommended.map((provider) => {
            const active = provider.key === selectedKey;
            return (
              <Card
                key={provider.key}
                selected={active}
                onClick={() => onSelect(provider)}
                title={provider.default_base_url || provider.name}
                className="p-2"
              >
                <div className="flex items-center gap-2">
                  <ProviderLogo logoKey={provider.logo_key} label={provider.name} size="sm" eager />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block truncate text-os-xs font-medium",
                        active ? "text-accent" : "text-ink",
                      )}
                    >
                      {provider.name}
                    </span>
                    <span className="block truncate text-os-2xs text-ink-tertiary">
                      {provider.local ? "本地模型" : provider.wire === "openai_chat" ? "OpenAI 兼容" : "专有协议"}
                    </span>
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
            <Input
              className="pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索厂商名称、标识或模型名"
              aria-label="搜索厂商"
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<SearchIcon className="h-6 w-6" />}
              title="没有匹配的厂商"
              description="可尝试厂商名、标识或模型名，例如 openrouter、gpt-4o、ollama。"
            />
          ) : (
            <div
              ref={listRef}
              className="h-[200px] overflow-y-auto rounded-os-md border border-line/10 bg-surface"
            >
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const provider = filtered[item.index];
                  const active = provider.key === selectedKey;
                  return (
                    <div
                      key={provider.key}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: item.size,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(provider)}
                        title={provider.default_base_url || provider.name}
                        className={cn(
                          "flex h-full w-full items-center gap-2.5 border-l-2 px-2.5 text-left transition-colors duration-150",
                          active
                            ? "border-accent bg-accent/5"
                            : "border-transparent hover:bg-line/5",
                        )}
                      >
                        <ProviderLogo logoKey={provider.logo_key} label={provider.name} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "truncate text-os-xs font-medium",
                                active ? "text-accent" : "text-ink",
                              )}
                            >
                              {provider.name}
                            </span>
                            <span className="shrink-0 font-mono text-os-2xs text-ink-tertiary">
                              {provider.key}
                            </span>
                            {provider.local && <Badge tone="accent">本地</Badge>}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-os-2xs text-ink-tertiary">
                            {provider.default_base_url || "未收录 API 端点，可手动填写"}
                          </span>
                        </span>
                        {active && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {selected && (
        <div className="flex flex-wrap items-center gap-2 text-os-xs text-ink-tertiary">
          <span className="font-medium text-ink-secondary">{selected.name}</span>
          <Badge>{selected.wire === "openai_chat" ? "OpenAI 兼容" : AI_WIRE_LABELS[selected.wire]}</Badge>
          {selected.docs_url && (
            <button
              type="button"
              onClick={() => void openDocs(selected.docs_url)}
              className="inline-flex items-center gap-0.5 text-os-xs text-accent transition-opacity duration-os hover:opacity-80"
            >
              官方文档
              <ExternalLinkIcon className="h-3 w-3" />
            </button>
          )}
          {!selected.default_base_url && (
            <span className="text-state-warning">该厂商未收录 API 端点，请手动填写端点。</span>
          )}
        </div>
      )}
    </div>
  );
}
