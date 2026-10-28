import React, { useRef, useState } from "react";
import {
  THEMES,
  resolveTheme,
  useSettingsStore,
  type TerminalThemeConfig,
} from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";
import { formatFriendlyError } from "../lib/errors";
import {
  WALLPAPER_PRESETS,
  WALLPAPER_SIZES,
  SOLID_PRESETS,
  getBackgroundLabel,
  getWallpaperStyle,
  isLightColor,
} from "../lib/wallpapers";
import { AboutUpdateTab } from "../updater/AboutUpdateTab";

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;

export const SettingsModal: React.FC = () => {
  const {
    theme,
    customThemes,
    fontSize,
    fontFamily,
    cursorBlink,
    cursorStyle,
    scrollback,
    renderer,
    logSessionOutput,
    keepaliveDefaultSec,
    settingsModalOpen,
    backgroundId,
    backgroundCustom,
    backgroundOpacity,
    backgroundBlur,
    setTheme,
    setFontSize,
    setFontFamily,
    setCursorBlink,
    setCursorStyle,
    setScrollback,
    setRenderer,
    setLogSessionOutput,
    setKeepaliveDefaultSec,
    setSettingsModalOpen,
    saveCustomTheme,
    setBackgroundId,
    setBackgroundCustom,
    setBackgroundOpacity,
    setBackgroundBlur,
  } = useSettingsStore();

  const backgroundFileRef = useRef<HTMLInputElement>(null);
  const [backgroundMsg, setBackgroundMsg] = useState<string | null>(null);
  /** 背景选择器分组：全部 / 壁纸 / 纯色 */
  const [bgFilter, setBgFilter] = useState<"all" | "wallpaper" | "solid">("all");

  const [activeTab, setActiveTab] = useState<
    "theme" | "terminal" | "background" | "security" | "export" | "about"
  >("theme");
  const [importJson, setImportJson] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // 修改进入系统的保险库主密码
  const vaultStatus = useVaultStore((s) => s.status);
  const changeVaultPassword = useVaultStore((s) => s.changePassword);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  if (!settingsModalOpen) return null;

  const currentThemeConfig = resolveTheme(theme, customThemes);

  // 内置主题 + 用户导入的自定义主题，导入后必须出现在列表里才能真正被应用
  const themeOptions: { id: string; config: TerminalThemeConfig; custom: boolean }[] = [
    ...Object.keys(THEMES).map((id) => ({ id, config: THEMES[id], custom: false })),
    ...Object.keys(customThemes).map((id) => ({ id, config: customThemes[id], custom: true })),
  ];

  // 背景预览：与 AppLayout / XtermView 使用同一套解析逻辑，做到「所见即所得」
  const backgroundPreview = getWallpaperStyle(backgroundId, backgroundCustom);

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
      // 导入后立刻应用，否则用户会以为「解析并应用」没有任何效果
      await setTheme(customId);
      setImportMsg(`成功导入并应用主题 "${parsed.name}"！`);
      setImportJson("");
    } catch (e: any) {
      console.error("主题 JSON 解析失败:", e);
      const reason = e instanceof Error ? e.message : String(e);
      setImportMsg(`主题文件不是合法的 JSON，请检查内容（技术细节：${reason.slice(0, 120)}）`);
    }
  };

  const handlePickBackground = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBackgroundMsg("请选择图片文件（PNG / JPG / WebP 等）");
      return;
    }
    if (file.size > MAX_BACKGROUND_BYTES) {
      setBackgroundMsg("图片过大，请选择 8MB 以内的图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        setBackgroundMsg("读取图片失败，请重试");
        return;
      }
      await setBackgroundCustom(dataUrl);
      await setBackgroundId("custom");
      setBackgroundMsg("自定义壁纸已应用");
    };
    reader.onerror = () => setBackgroundMsg("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);
    if (!oldPassword) {
      setPasswordMsg("请输入当前主密码");
      return;
    }
    if (!newPassword) {
      setPasswordMsg("请输入新的主密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg("两次输入的新密码不一致，请重新输入");
      return;
    }

    setSavingPassword(true);
    try {
      await changeVaultPassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMsg("主密码已更新，下次启动请使用新密码解锁。");
    } catch (err: any) {
      setPasswordMsg(formatFriendlyError(err));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-white/95 border border-black/[0.08] rounded-2xl shadow-apple-lg flex flex-col overflow-hidden animate-in zoom-in-95 max-h-[85vh] text-[#1d1d1f] backdrop-blur-2xl">
        {/* 顶部标题栏 */}
        <div className="h-14 px-6 border-b border-black/[0.06] flex items-center justify-between gap-3 bg-white/70 shrink-0">
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
        <div className="px-6 py-2.5 bg-black/[0.02] border-b border-black/[0.06] flex items-center shrink-0 overflow-x-auto">
          <div className="flex shrink-0 bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium">
            <button
              onClick={() => setActiveTab("theme")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "theme"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              配色主题 ({themeOptions.length})
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
              onClick={() => setActiveTab("background")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "background"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              背景壁纸
            </button>
            <button
              onClick={() => setActiveTab("security")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "security"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              安全与主密码
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
            <button
              onClick={() => setActiveTab("about")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "about"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              关于与更新
            </button>
          </div>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-5 text-xs text-[#1d1d1f] overflow-y-auto flex-1 min-h-0">
          {activeTab === "theme" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="font-semibold text-[#1d1d1f]">终端与系统配色主题</label>
                <span className="text-[11px] text-[#86868b] font-mono">
                  当前应用: {currentThemeConfig.name}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {themeOptions.map(({ id, config: t, custom }) => {
                  const isSelected = theme === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTheme(id)}
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
                      <span
                        className={`flex items-center gap-1 max-w-full text-[11px] ${
                          isSelected ? "font-bold text-[#0071e3]" : "font-medium text-[#424245]"
                        }`}
                      >
                        <span className="truncate">{t.name}</span>
                        {custom && (
                          <span className="shrink-0 rounded bg-[#0071e3]/10 px-1 text-[9px] font-semibold text-[#0071e3]">
                            导入
                          </span>
                        )}
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

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">光标形状</label>
                  <select
                    value={cursorStyle}
                    onChange={(e) => setCursorStyle(e.target.value as "bar" | "block" | "underline")}
                    className="w-full px-2.5 py-1.5 bg-white border border-black/[0.08] rounded-lg text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3]"
                  >
                    <option value="bar">竖线 (bar)</option>
                    <option value="block">方块 (block)</option>
                    <option value="underline">下划线 (underline)</option>
                  </select>
                </div>

                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">滚动缓冲行数: {scrollback}</label>
                  <input
                    type="range"
                    min={1000}
                    max={20000}
                    step={1000}
                    value={scrollback}
                    onChange={(e) => setScrollback(Number(e.target.value))}
                    className="w-full accent-[#0071e3] bg-black/[0.08] rounded-lg cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-1">大输出场景可调高，代价是更多内存占用</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">终端渲染方式</label>
                  <select
                    value={renderer}
                    onChange={(e) => setRenderer(e.target.value as "dom" | "webgl")}
                    className="w-full px-2.5 py-1.5 bg-white border border-black/[0.08] rounded-lg text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3]"
                  >
                    <option value="dom">DOM（兼容性最好）</option>
                    <option value="webgl">WebGL（高吞吐更流畅）</option>
                  </select>
                  <p className="text-[10px] text-[#86868b] mt-1">
                    启用壁纸时会自动回落到 DOM；WebGL 上下文丢失时也会自动降级
                  </p>
                </div>

                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">
                    默认 KeepAlive 间隔: {keepaliveDefaultSec === 0 ? "关闭" : `${keepaliveDefaultSec}s`}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    step={5}
                    value={keepaliveDefaultSec}
                    onChange={(e) => setKeepaliveDefaultSec(Number(e.target.value))}
                    className="w-full accent-[#0071e3] bg-black/[0.08] rounded-lg cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-1">仅对新建会话生效；连续失败达到次数上限判定断线</p>
                </div>
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

          {activeTab === "background" && (
            <div className="space-y-5">
              <div>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <label className="font-semibold text-[#1d1d1f]">系统外观背景</label>
                    <p className="text-[11px] text-[#86868b] mt-0.5">
                      同时作用于终端画布与整个主界面，选择后立即生效
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-blue-200/70 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-[#0071e3]">
                    当前：{getBackgroundLabel(backgroundId)}
                  </span>
                </div>

                {/* 分类筛选 + 快捷操作 */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex bg-black/[0.06] p-0.5 rounded-xl text-[11px] font-medium">
                    {(
                      [
                        ["all", `全部 ${WALLPAPER_PRESETS.length + SOLID_PRESETS.length}`],
                        ["wallpaper", `壁纸 ${WALLPAPER_PRESETS.length}`],
                        ["solid", `纯色 ${SOLID_PRESETS.length}`],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setBgFilter(id)}
                        className={`px-2.5 py-1 rounded-lg transition active:scale-[0.98] ${
                          bgFilter === id
                            ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                            : "text-[#86868b] hover:text-[#1d1d1f]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setBackgroundId("")}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition active:scale-[0.98] ${
                        backgroundId === ""
                          ? "border-[#0071e3] text-[#0071e3] bg-blue-50/60"
                          : "border-black/[0.08] text-[#86868b] hover:border-black/[0.2] hover:text-[#1d1d1f]"
                      }`}
                    >
                      无背景
                    </button>
                    <button
                      type="button"
                      onClick={() => backgroundFileRef.current?.click()}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition active:scale-[0.98] ${
                        backgroundId === "custom"
                          ? "border-[#0071e3] text-[#0071e3] bg-blue-50/60"
                          : "border-black/[0.08] text-[#86868b] hover:border-black/[0.2] hover:text-[#1d1d1f]"
                      }`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      {backgroundId === "custom" ? "更换图片" : "上传图片"}
                    </button>
                  </div>
                </div>

                {/* 壁纸：多层渐变 / 纹理，卡片更大更易辨识 */}
                {(bgFilter === "all" || bgFilter === "wallpaper") && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[11px] font-semibold text-[#1d1d1f]">渐变 / 纹理壁纸</span>
                      <span className="text-[10px] text-[#86868b]">低对比度配色，不干扰代码阅读</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {WALLPAPER_PRESETS.map((w) => {
                        const selected = backgroundId === w.id;
                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => setBackgroundId(w.id)}
                            title={w.name}
                            className={`relative aspect-[16/10] rounded-xl border overflow-hidden transition active:scale-[0.98] ${
                              selected
                                ? "border-[#0071e3] ring-2 ring-[#0071e3]/25 shadow-apple-sm"
                                : "border-black/[0.08] hover:border-black/[0.25]"
                            }`}
                          >
                            <span
                              className="absolute inset-0"
                              style={{
                                backgroundImage: w.image,
                                backgroundSize: WALLPAPER_SIZES[w.id] || "cover",
                                backgroundColor: currentThemeConfig.background,
                              }}
                            />
                            <span className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-left text-[10px] font-semibold text-white bg-gradient-to-t from-black/70 via-black/25 to-transparent">
                              {w.name}
                            </span>
                            {selected && (
                              <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#0071e3] text-white shadow-apple-sm">
                                <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 纯色：色板 + 名称，浅色自动切换深色文字 */}
                {(bgFilter === "all" || bgFilter === "solid") && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[11px] font-semibold text-[#1d1d1f]">纯色</span>
                      <span className="text-[10px] text-[#86868b]">不叠加纹理，最省 GPU</span>
                    </div>
                    <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
                      {SOLID_PRESETS.map((w) => {
                        const selected = backgroundId === w.id;
                        const light = isLightColor(w.color);
                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => setBackgroundId(w.id)}
                            title={`${w.name} · ${w.color}`}
                            className={`relative h-14 rounded-xl border overflow-hidden transition active:scale-[0.97] ${
                              selected
                                ? "border-[#0071e3] ring-2 ring-[#0071e3]/25 shadow-apple-sm"
                                : "border-black/[0.08] hover:border-black/[0.3]"
                            }`}
                            style={{ backgroundColor: w.color }}
                          >
                            <span
                              className={`absolute inset-x-0 bottom-0 py-0.5 text-center text-[10px] font-semibold ${
                                light
                                  ? "bg-black/[0.04] text-[#1d1d1f]/75"
                                  : "bg-white/[0.08] text-white/85"
                              }`}
                            >
                              {w.name}
                            </span>
                            {selected && (
                              <svg
                                className={`absolute right-1 top-1 h-3.5 w-3.5 ${light ? "text-[#0071e3]" : "text-white"}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <input
                  ref={backgroundFileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    handlePickBackground(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />

                {backgroundMsg && (
                  <div className="mt-2 text-[11px] text-[#86868b]">{backgroundMsg}</div>
                )}

                {/* 实时预览：与主界面 / 终端使用完全相同的渲染参数 */}
                <div className="mt-3 relative h-24 rounded-xl overflow-hidden border border-black/[0.08] bg-[#f5f5f7]">
                  {backgroundPreview && (
                    <div
                      className="absolute inset-0 transition-all duration-200"
                      style={{
                        backgroundImage: backgroundPreview.backgroundImage,
                        backgroundSize: backgroundPreview.backgroundSize,
                        backgroundPosition: "center",
                        backgroundColor:
                          backgroundPreview.backgroundColor || currentThemeConfig.background,
                        filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
                        transform: backgroundBlur > 0 ? "scale(1.06)" : undefined,
                        opacity: Math.max(0, Math.min(100, backgroundOpacity)) / 100,
                      }}
                    />
                  )}
                  <div className="relative h-full flex items-center justify-center">
                    <span className="rounded-lg bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#1d1d1f] shadow-apple-sm backdrop-blur-sm">
                      {backgroundPreview ? "背景预览 · 主界面 + 终端" : "未启用背景（使用纯白终端底色）"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-2">
                    壁纸不透明度: {backgroundOpacity}%
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={backgroundOpacity}
                    onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[11px] text-[#86868b] mt-1.5">
                    数值越低越透明，代码越清晰
                  </p>
                </div>

                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-2">
                    背景模糊: {backgroundBlur}px
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={24}
                    step={1}
                    value={backgroundBlur}
                    onChange={(e) => setBackgroundBlur(Number(e.target.value))}
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[11px] text-[#86868b] mt-1.5">
                    适当模糊可弱化背景纹理，避免干扰阅读
                  </p>
                </div>
              </div>

              {!backgroundId && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-800">
                  当前未启用背景。选择任意壁纸 / 纯色预设或上传图片后，主界面与终端会立即应用，并写入本地设置下次启动继续生效。
                </div>
              )}
            </div>
          )}

          {activeTab === "security" && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-black/[0.06] bg-[#f5f5f7] shadow-apple-sm">
                <div className="font-semibold text-[#1d1d1f]">修改进入系统的主密码</div>
                <div className="text-[11px] text-[#86868b] mt-0.5 leading-relaxed">
                  主密码用于加密保护会话密码与私钥。修改后旧的登录凭据会用新密码重新加密，其他内容不受影响。
                </div>
              </div>

              {vaultStatus && vaultStatus.state !== "unlocked" ? (
                <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs">
                  保险库当前处于锁定状态，请先返回主界面解锁后再修改主密码。
                </div>
              ) : (
                <form onSubmit={handleChangePassword} className="space-y-3">
                  <div>
                    <label className="block font-semibold text-[#1d1d1f] mb-1.5">当前主密码</label>
                    <input
                      type="password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      placeholder="输入当前使用的主密码"
                      className="w-full px-3.5 py-2 rounded-xl border border-black/[0.08] bg-[#f5f5f7] text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-[#1d1d1f] mb-1.5">新主密码</label>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="设置新的主密码"
                        className="w-full px-3.5 py-2 rounded-xl border border-black/[0.08] bg-[#f5f5f7] text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-[#1d1d1f] mb-1.5">确认新主密码</label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="再次输入新主密码"
                        className="w-full px-3.5 py-2 rounded-xl border border-black/[0.08] bg-[#f5f5f7] text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                      />
                    </div>
                  </div>

                  {passwordMsg && (
                    <div
                      className={`text-xs ${
                        passwordMsg.includes("已更新") ? "text-emerald-700" : "text-red-600"
                      }`}
                    >
                      {passwordMsg}
                    </div>
                  )}

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={savingPassword}
                      className="px-4 py-2 rounded-xl bg-[#0071e3] hover:bg-[#0077ed] text-white font-semibold text-xs shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                    >
                      {savingPassword ? "正在更新..." : "确认修改主密码"}
                    </button>
                  </div>
                </form>
              )}
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

          {activeTab === "about" && <AboutUpdateTab />}
        </div>

        <div className="h-14 px-6 border-t border-black/[0.06] bg-white/70 flex items-center justify-end gap-2 shrink-0">
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
