import { useEffect, useMemo, useRef, useState } from "react";
import type { AiModelPreset } from "../../../types/ai";
import { Input } from "../../ui/Field";
import { CheckIcon, SearchIcon } from "../../ui/icons";
import { cn } from "../../ui/cn";

export interface ModelComboboxProps {
  models: AiModelPreset[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

const MAX_VISIBLE_MODELS = 100;

/** 可搜索的模型选择器：预设列表 + 自由输入任意模型 ID。 */
export function ModelCombobox({ models, value, onChange, disabled = false }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const matched = keyword
      ? models.filter(
          (model) =>
            model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword),
        )
      : models;
    return matched.slice(0, MAX_VISIBLE_MODELS);
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const isPreset = models.some((model) => model.id === value);

  const commit = (modelId: string) => {
    onChange(modelId);
    setQuery("");
    setHighlight(0);
    setOpen(false);
  };

  if (models.length === 0) {
    return (
      <Input
        mono
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="输入模型标识，例如 gpt-4o-mini"
      />
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
        <Input
          className="pl-8"
          mono
          disabled={disabled}
          value={open ? query : value}
          placeholder={value || "搜索预设模型，或直接输入模型 ID"}
          aria-label="模型"
          aria-expanded={open}
          role="combobox"
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setHighlight((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const preset = filtered[highlight];
              if (preset) commit(preset.id);
              else if (query.trim()) commit(query.trim());
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>

      <p className="mt-1 text-os-2xs text-ink-tertiary">
        当前模型 ID：
        <span className="ml-1 font-mono text-ink-secondary">{value || "未选择"}</span>
        {value && !isPreset && <span className="ml-1.5 text-accent">自定义</span>}
      </p>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="预设模型"
          className="absolute left-0 right-0 top-[34px] z-30 mt-1 max-h-[180px] overflow-y-auto rounded-os-md border border-line/10 bg-surface py-1 shadow-os-lg"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-os-xs text-ink-tertiary">
              {query.trim() ? (
                <button
                  type="button"
                  onClick={() => commit(query.trim())}
                  className="w-full text-left text-accent"
                >
                  使用「{query.trim()}」作为模型 ID
                </button>
              ) : (
                "该厂商没有预设模型，请直接输入模型 ID"
              )}
            </div>
          ) : (
            filtered.map((model, index) => {
              const selected = model.id === value;
              return (
                <button
                  key={model.id}
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => commit(model.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150",
                    index === highlight ? "bg-line/5" : "bg-transparent",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-os-xs text-ink">{model.name}</span>
                    <span className="block truncate font-mono text-os-2xs text-ink-tertiary">
                      {model.id}
                    </span>
                  </span>
                  {selected && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
