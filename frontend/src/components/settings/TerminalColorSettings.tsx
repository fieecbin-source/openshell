import { useEffect, useState } from "react";
import {
  allThemes, colorContrast, DEFAULT_SETTINGS, resolveTheme, useSettingsStore,
  type TerminalColorKey,
} from "../../stores/settingsStore";
import { Button } from "../ui/Button";

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value.slice(0, 7));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(value.slice(0, 7)); setError(""); }, [value]);
  const commit = async (color: string) => {
    setError("");
    try { await onChange(color); } catch (cause) { setError(String((cause as Error).message)); }
  };
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="text-os-xs font-medium text-ink-secondary">{label}</span>
      <span className="flex items-center gap-2 rounded-os-md border border-line/20 bg-surface px-2.5 py-2 focus-within:border-accent">
        <input type="color" aria-label={`${label}选择器`} value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : value.slice(0, 7)}
          onChange={(event) => { setDraft(event.target.value); void commit(event.target.value); }}
          className="h-6 w-7 shrink-0 cursor-pointer border-0 bg-transparent p-0" />
        <input aria-label={`${label}色值`} value={draft} spellCheck={false} maxLength={7}
          aria-invalid={!!error} onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit(draft)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(draft); } }}
          className="min-w-0 flex-1 bg-transparent font-mono text-os-xs text-ink outline-none" />
      </span>
      {error && <span role="alert" className="block text-os-2xs text-state-danger">{error}</span>}
    </label>
  );
}

const BASE_COLORS: { key: TerminalColorKey; label: string }[] = [
  { key: "foreground", label: "文字颜色" }, { key: "background", label: "终端底色" },
  { key: "cursor", label: "光标颜色" }, { key: "selectionBackground", label: "选区颜色" },
];
const ANSI_COLORS: { key: TerminalColorKey; label: string }[] = [
  { key: "black", label: "基础深灰" }, { key: "red", label: "错误 / 红" },
  { key: "green", label: "成功 / 绿" }, { key: "yellow", label: "警告 / 黄" },
  { key: "blue", label: "链接 / 蓝" }, { key: "magenta", label: "品红" },
  { key: "cyan", label: "青色" }, { key: "white", label: "基础浅灰" },
  { key: "brightBlack", label: "高亮深灰" }, { key: "brightRed", label: "高亮红" },
  { key: "brightGreen", label: "高亮绿" }, { key: "brightYellow", label: "高亮黄" },
  { key: "brightBlue", label: "高亮蓝" }, { key: "brightMagenta", label: "高亮品红" },
  { key: "brightCyan", label: "高亮青" }, { key: "brightWhite", label: "高亮浅灰" },
];

export function TerminalColorSettings() {
  const { theme, customThemes, fontSize, fontFamily, fontWeight,
    setTheme, setTerminalColor, setFontSize, setFontFamily, setFontWeight } = useSettingsStore();
  const current = resolveTheme(theme, customThemes);
  const contrast = colorContrast(current.foreground, current.background);
  const reset = async () => {
    await Promise.all([setTheme(DEFAULT_SETTINGS.theme), setFontSize(DEFAULT_SETTINGS.fontSize),
      setFontFamily(DEFAULT_SETTINGS.fontFamily), setFontWeight(DEFAULT_SETTINGS.fontWeight)]);
  };
  return (
    <section className="space-y-5" aria-label="终端配色设置">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-os-md font-semibold text-ink">清晰、舒适的浅色终端</h3>
          <p className="mt-1 text-os-xs text-ink-secondary">选择浅色预设，或单独调整文字和 ANSI 颜色。修改会即时应用并自动保存。</p>
        </div>
        <Button size="sm" onClick={() => void reset()}>恢复清晰默认值</Button>
      </div>

      <div className="overflow-hidden rounded-os-lg border border-line/20" data-testid="terminal-color-preview"
        style={{ backgroundColor: current.background, color: current.foreground }}>
        <div className="flex items-center justify-between border-b border-line/10 px-4 py-2 text-os-2xs text-ink-secondary">
          <span>实时预览 · {fontSize}px · 字重 {fontWeight}</span>
          <span className="font-medium text-state-success">对比度 {contrast.toFixed(2)}:1</span>
        </div>
        <div className="space-y-1 px-4 py-4" style={{ fontFamily, fontSize, fontWeight, lineHeight: 1.5 }}>
          <p><span style={{ color: current.blue }}>ops@workspace</span> <span style={{ color: current.cyan }}>~/services</span> $ systemctl status api</p>
          <p><span style={{ color: current.green }}>● active (running)</span> 服务运行正常，连接稳定</p>
          <p><span style={{ color: current.yellow }}>WARN</span> 日志与命令输出清晰可读 · Aa 0O 1Il 0123456789</p>
          <p><span style={{ backgroundColor: current.selectionBackground }}>选区文本预览</span> <span style={{ backgroundColor: current.cursor, color: current.cursorAccent }}>▏</span></p>
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-os-xs font-semibold text-ink">浅色主题</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.entries(allThemes(customThemes)).map(([key, config]) => (
            <button type="button" key={key} aria-pressed={theme === key} onClick={() => void setTheme(key)}
              className={`flex items-center gap-2 rounded-os-md border px-3 py-2.5 text-left text-os-xs transition-colors ${theme === key
                ? "border-accent/60 bg-accent/5 text-accent" : "border-line/15 bg-surface/70 text-ink-secondary hover:border-accent/40"}`}>
              <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded border border-line/15 font-mono font-semibold"
                style={{ backgroundColor: config.background, color: config.foreground }}>Aa</span>
              <span className="truncate">{config.name}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {BASE_COLORS.map(({ key, label }) => <ColorField key={key} label={label} value={current[key]}
          onChange={(value) => setTerminalColor(key, value)} />)}
      </div>
      <p className="text-os-2xs text-ink-secondary">终端文字保持独立渲染；背景模糊与折射只作用于玻璃材质。系统自动增强 ANSI 文本对比度。</p>

      <details className="border-t border-line/15 pt-3">
        <summary className="cursor-pointer text-os-xs font-medium text-ink">高级 ANSI 颜色 · 16 色</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ANSI_COLORS.map(({ key, label }) => <ColorField key={key} label={label} value={current[key]}
            onChange={(value) => setTerminalColor(key, value)} />)}
        </div>
      </details>
    </section>
  );
}
