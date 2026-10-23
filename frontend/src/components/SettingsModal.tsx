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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-xl bg-white/95 border border-black/[0.08] rounded-2xl shadow-apple-lg flex flex-col overflow-hidden animate-in zoom-in-95 max-h-[85vh] text-[#1d1d1f] backdrop-blur-2xl">
        {/* 顶部标题栏 */}
        <div className="h-13 px-6 border-b border-black/[0.06] flex items-center justify-between bg-white/70 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 border border-blue-200/60 flex items-center justify-center text-[#0071e3] shadow-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#1d1d1f] tracking-tight">系统外观与偏好设置</h3>
              <p className="text-[11px] text-[#86868b]">调整终端配色主题、字号渲染及会话审计选项</p>
            </div>
          </div>

          <button
            onClick={() => setSettingsModalOpen(false)}
            className="p-1.5 text-[#86868b] hover:text-[#1d1d1f] rounded-lg hover:bg-black/[0.05] active:scale-95 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签栏 (Apple 风格分段胶囊) */}
        <div className="px-6 py-2.5 bg-black/[0.02] border-b border-black/[0.06] flex items-center shrink-0">
          <div className="flex bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium">
            <button
              onClick={() => setActiveTab("theme")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "theme"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              配色主题 ({Object.keys(THEMES).length} 预设)
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "terminal"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              终端与字体
            </button>
            <button
              onClick={() => setActiveTab("export")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "export"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              主题导入 / 导出
            </button>
          </div>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-5 text-xs text-[#1d1d1f] overflow-y-auto flex-1">
          {activeTab === "theme" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="font-semibold text-[#1d1d1f]">终端与系统配色主题</label>
                <span className="text-[11px] text-[#86868b] font-mono">
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
                      className={`p-3 rounded-xl border flex flex-col items-center gap-2 text-center transition active:scale-[0.98] ${
                        isSelected
                          ? "bg-blue-50/50 border-[#0071e3] shadow-apple-sm text-[#0071e3]"
                          : "bg-[#f5f5f7] border-black/[0.06] hover:border-black/[0.12] text-[#1d1d1f]"
                      }`}
                    >
                      <div
                        className="w-full h-8 rounded-lg border border-black/[0.08] flex items-center justify-center gap-1.5 px-2 shadow-inner"
                        style={{ backgroundColor: t.background }}
                      >
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.red }} />
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.green }} />
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.blue }} />
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.yellow }} />
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.magenta }} />
                      </div>
                      <span className={`text-[11px] truncate ${isSelected ? "font-bold text-[#0071e3]" : "font-medium text-[#424245]"}`}>
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
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-2">字号大小: {fontSize}px</label>
                  <input
                    type="range"
                    min={11}
                    max={22}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-[#0071e3] bg-black/[0.08] rounded-lg cursor-pointer"
                  />
                </div>

                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06] flex flex-col justify-center">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">光标闪烁</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="cursorBlink"
                      checked={cursorBlink}
                      onChange={(e) => setCursorBlink(e.target.checked)}
                      className="rounded border-black/[0.2] text-[#0071e3] focus:ring-0 accent-[#0071e3] w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="cursorBlink" className="text-xs text-[#1d1d1f] cursor-pointer">
                      启用终端光标闪烁
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-[#1d1d1f] mb-1.5">等宽字体族名 (Font Family)</label>
                <input
                  type="text"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                />
              </div>

              <div className="p-3.5 bg-[#f5f5f7] border border-black/[0.06] rounded-xl flex items-center justify-between shadow-apple-sm">
                <div>
                  <h5 className="font-semibold text-[#1d1d1f] text-xs">自动记录会话屏幕日志</h5>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    记录终端所有交互输出以供安全审计与追溯
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={logSessionOutput}
                  onChange={(e) => setLogSessionOutput(e.target.checked)}
                  className="rounded border-black/[0.2] text-[#0071e3] focus:ring-0 w-4 h-4 cursor-pointer accent-[#0071e3]"
                />
              </div>
            </div>
          )}

          {activeTab === "export" && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-black/[0.06] bg-[#f5f5f7] flex items-center justify-between shadow-apple-sm">
                <div>
                  <div className="font-semibold text-[#1d1d1f]">导出当前主题 ({currentThemeConfig.name})</div>
                  <div className="text-[11px] text-[#86868b]">将当前 16 色 ANSI 及前景背景配置下载为 JSON</div>
                </div>
                <button
                  type="button"
                  onClick={handleExportTheme}
                  className="px-3.5 py-1.5 rounded-xl bg-white hover:bg-black/[0.04] text-[#0071e3] font-semibold text-xs border border-black/[0.08] shadow-apple-sm transition active:scale-[0.98]"
                >
                  导出 JSON
                </button>
              </div>

              <div className="space-y-2">
                <label className="block font-semibold text-[#1d1d1f]">导入第三方主题 JSON</label>
                <textarea
                  rows={5}
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder="粘贴 Theme JSON 格式内容（需包含 name, background, foreground, 16 色 ANSI 等）..."
                  className="w-full p-3 rounded-xl border border-black/[0.08] bg-[#f5f5f7] font-mono text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                />
                {importMsg && (
                  <div className={`text-xs ${importMsg.includes("失败") ? "text-red-600" : "text-emerald-700"}`}>
                    {importMsg}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleImportTheme}
                  className="px-4 py-2 rounded-xl bg-[#0071e3] hover:bg-[#0077ed] text-white font-semibold text-xs shadow-sm transition active:scale-[0.98]"
                >
                  解析并应用新主题
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="h-13 px-6 border-t border-black/[0.06] bg-white/70 flex items-center justify-end shrink-0">
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="px-4 py-2 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-xs font-semibold shadow-sm transition active:scale-[0.98]"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
