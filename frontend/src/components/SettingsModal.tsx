import React, { useState } from "react";
import { THEMES, useSettingsStore, type TerminalTheme, type TerminalThemeConfig } from "../stores/settingsStore";

export const SettingsModal: React.FC = () => {
  const {
    theme,
    fontSize,
    fontFamily,
    cursorBlink,
    logSessionOutput,
    settingsModalOpen,
    setTheme,
    setFontSize,
    setFontFamily,
    setCursorBlink,
    setLogSessionOutput,
    setSettingsModalOpen,
    saveCustomTheme,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<"theme" | "terminal" | "export">("theme");
  const [importJson, setImportJson] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  if (!settingsModalOpen) return null;

  const currentThemeConfig = THEMES[theme] || THEMES.dark;

  const handleExportTheme = () => {
    const jsonStr = JSON.stringify(currentThemeConfig, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openshell_theme_${theme}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportTheme = async () => {
    if (!importJson.trim()) return;
    try {
      const parsed = JSON.parse(importJson) as TerminalThemeConfig;
      if (!parsed.name || !parsed.background || !parsed.foreground) {
        setImportMsg("导入失败：JSON 缺少 name / background / foreground 等必要键");
        return;
      }
      const customId = "custom_" + Date.now();
      await saveCustomTheme(customId, parsed);
      setImportMsg(`成功导入主题 "${parsed.name}"！`);
      setImportJson("");
    } catch (e: any) {
      setImportMsg("解析 JSON 失败: " + e?.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 max-h-[85vh]">
        {/* 顶部标题栏 */}
        <div className="h-12 px-6 border-b border-surface-800 flex items-center justify-between bg-surface-950/70 shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <h3 className="text-sm font-bold text-white">系统外观与偏好设置</h3>
          </div>

          <button
            onClick={() => setSettingsModalOpen(false)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-surface-800 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签栏 */}
        <div className="flex border-b border-surface-800 bg-surface-950/40 px-6 shrink-0 text-xs">
          <button
            onClick={() => setActiveTab("theme")}
            className={`py-2.5 px-3 border-b-2 font-medium transition ${
              activeTab === "theme"
                ? "border-emerald-500 text-emerald-400 font-bold"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            配色主题 ({Object.keys(THEMES).length} 预设)
          </button>
          <button
            onClick={() => setActiveTab("terminal")}
            className={`py-2.5 px-3 border-b-2 font-medium transition ${
              activeTab === "terminal"
                ? "border-emerald-500 text-emerald-400 font-bold"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            终端与字体
          </button>
          <button
            onClick={() => setActiveTab("export")}
            className={`py-2.5 px-3 border-b-2 font-medium transition ${
              activeTab === "export"
                ? "border-emerald-500 text-emerald-400 font-bold"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            主题导入 / 导出 JSON
          </button>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-5 text-xs text-slate-300 overflow-y-auto flex-1">
          {activeTab === "theme" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="font-semibold text-white">终端与系统配色主题</label>
                <span className="text-[11px] text-slate-500 font-mono">
                  当前应用: {currentThemeConfig.name}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {(Object.keys(THEMES) as TerminalTheme[]).map((key) => {
                  const t = THEMES[key];
                  const isSelected = theme === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTheme(key)}
                      className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 text-center transition ${
                        isSelected
                          ? "bg-surface-950 border-emerald-500 shadow-sm shadow-emerald-500/20"
                          : "bg-surface-950/60 border-surface-800 hover:border-surface-700"
                      }`}
                    >
                      <div
                        className="w-full h-7 rounded-lg border border-surface-800 flex items-center justify-center gap-1 px-1.5"
                        style={{ backgroundColor: t.background }}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.red }} />
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.green }} />
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.blue }} />
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.yellow }} />
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.magenta }} />
                      </div>
                      <span className={`text-[11px] font-medium truncate ${isSelected ? "text-emerald-400 font-bold" : "text-slate-400"}`}>
                        {t.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === "terminal" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-white mb-1.5">字号大小: {fontSize}px</label>
                  <input
                    type="range"
                    min={11}
                    max={22}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-emerald-500 bg-surface-950 rounded-lg cursor-pointer"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-white mb-1.5">光标闪烁</label>
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="cursorBlink"
                      checked={cursorBlink}
                      onChange={(e) => setCursorBlink(e.target.checked)}
                      className="rounded border-surface-700 text-emerald-500 focus:ring-0"
                    />
                    <label htmlFor="cursorBlink" className="text-xs text-slate-300 cursor-pointer">
                      启用终端光标闪烁
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-white mb-1.5">等宽字体族名 (Font Family)</label>
                <input
                  type="text"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg font-mono text-xs text-white outline-none focus:border-emerald-500"
                />
              </div>

              <div className="p-3 bg-surface-950 border border-surface-800 rounded-xl flex items-center justify-between">
                <div>
                  <h5 className="font-semibold text-white text-xs">自动记录会话屏幕日志</h5>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    记录终端所有交互输出以供安全审计与追溯
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={logSessionOutput}
                  onChange={(e) => setLogSessionOutput(e.target.checked)}
                  className="rounded border-surface-700 text-emerald-500 focus:ring-0 w-4 h-4 cursor-pointer"
                />
              </div>
            </div>
          )}

          {activeTab === "export" && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-surface-800 bg-surface-950 flex items-center justify-between">
                <div>
                  <div className="font-bold text-white">导出当前主题 ({currentThemeConfig.name})</div>
                  <div className="text-[11px] text-slate-500">将当前 16 色 ANSI 及前景背景配置下载为 JSON</div>
                </div>
                <button
                  type="button"
                  onClick={handleExportTheme}
                  className="px-3 py-1.5 rounded-lg bg-surface-800 hover:bg-surface-700 text-emerald-400 font-medium text-xs border border-surface-700 transition"
                >
                  导出 JSON
                </button>
              </div>

              <div className="space-y-2">
                <label className="block font-semibold text-white">导入第三方主题 JSON</label>
                <textarea
                  rows={5}
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder="粘贴 Theme JSON 格式内容（需包含 name, background, foreground, 16 色 ANSI 等）..."
                  className="w-full p-2.5 rounded-xl border border-surface-800 bg-surface-950 font-mono text-xs text-white outline-none focus:border-emerald-500"
                />
                {importMsg && (
                  <div className={`text-xs ${importMsg.includes("失败") ? "text-rose-400" : "text-emerald-400"}`}>
                    {importMsg}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleImportTheme}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-sm transition"
                >
                  解析并应用新主题
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="h-12 px-6 border-t border-surface-800 bg-surface-950/60 flex items-center justify-end shrink-0">
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm transition"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
