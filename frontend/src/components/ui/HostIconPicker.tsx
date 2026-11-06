import { useMemo, useState } from "react";
import { HostIcon } from "./HostIcon";
import { HOST_ICONS, HOST_ICON_GROUPS, type HostIconDef } from "../../lib/hostIcons";
import { CheckIcon, SearchIcon, SparklesIcon, XIcon } from "./icons";

export interface HostIconPickerProps {
  value: string;
  onChange: (key: string) => void;
  /** 提供时显示“自动识别”按钮 */
  onAutoDetect?: () => void;
  hint?: string | null;
  radioName?: string;
  compact?: boolean;
}

/** 添加/编辑服务器与高级设置共用的图标选择器 */
export function HostIconPicker({
  value,
  onChange,
  onAutoDetect,
  hint,
  radioName = "host-icon",
  compact = false,
}: HostIconPickerProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo<HostIconDef[]>(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return HOST_ICONS;
    return HOST_ICONS.filter((icon) => [icon.label, icon.key, HOST_ICON_GROUPS[icon.group], ...icon.keywords]
      .join(" ").toLowerCase().includes(keyword));
  }, [query]);

  return <div>
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-ink-secondary">主机图标</span>
      {onAutoDetect && (
        <button type="button" onClick={onAutoDetect}
          title="根据会话名称、主机地址和用户名匹配图标"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1 text-[10px] font-semibold text-accent transition hover:bg-accent/10">
          <SparklesIcon className="h-3 w-3" />
          自动识别
        </button>
      )}
    </div>
    <div className="mb-2 flex items-center gap-1.5 rounded-xl border border-line/15 bg-surface-muted/50 px-2.5 py-1.5 focus-within:border-accent/40">
      <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        aria-label="搜索图标"
        className="w-full min-w-0 bg-transparent text-xs text-ink placeholder:text-ink-tertiary outline-none" />
      {query && (
        <button type="button" aria-label="清空图标搜索" onClick={() => setQuery("")}
          className="shrink-0 text-ink-tertiary transition hover:text-accent">
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    <div className={compact ? "max-h-36 overflow-y-auto pr-1" : "max-h-[min(56vh,26rem)] overflow-y-auto pr-1"}>
      <div className="grid grid-cols-5 gap-1.5">
        {filtered.map((icon) => (
          <label key={icon.key} className="min-w-0 cursor-pointer"
            title={icon.group === "default" ? icon.label : `${icon.label}（${HOST_ICON_GROUPS[icon.group]}）`}>
            <input type="radio" name={radioName} value={icon.key} aria-label={`图标 ${icon.label}`}
              checked={value === icon.key}
              onChange={() => onChange(icon.key)}
              className="peer sr-only" />
            <span className="relative flex flex-col items-center gap-1 rounded-xl border border-transparent px-1 py-2 text-[10px] text-ink-secondary transition-colors hover:bg-line/5 peer-checked:border-accent/40 peer-checked:bg-accent/5 peer-checked:text-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
              {value === icon.key && (
                <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-surface">
                  <CheckIcon className="h-2.5 w-2.5" />
                </span>
              )}
              <HostIcon iconKey={icon.key} className="h-9 w-9" />
              <span className="max-w-full truncate">{icon.label}</span>
            </span>
          </label>
        ))}
      </div>
      {filtered.length === 0 && (
        <p className="py-6 text-center text-[11px] text-ink-tertiary">
          未找到图标
        </p>
      )}
    </div>
    {hint && <p role="status" className="mt-1.5 text-[10px] text-accent">{hint}</p>}
  </div>;
}
