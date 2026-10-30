import React, { useRef, useState, useEffect } from "react";
import {
  useSettingsStore,
  THEMES,
  resolveTheme,
  isLightBackground,
} from "../stores/settingsStore";
import {
  WALLPAPER_PRESETS,
  SOLID_PRESETS,
  WALLPAPER_SIZES,
  getBackgroundLabel,
} from "../lib/wallpapers";
import { useVaultStore } from "../stores/vaultStore";

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;

export type SettingsTab = "general" | "wallpaper" | "terminal" | "security";

interface SettingsModalProps {
  initialTab?: SettingsTab;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ initialTab = "general" }) => {
  const {
    theme,
    customThemes,
    fontSize,
    fontFamily,
    cursorBlink,
    cursorStyle,
    scrollback,
    renderer,
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
    setKeepaliveDefaultSec,
    setSettingsModalOpen,
    setBackgroundId,
    setBackgroundCustom,
    setBackgroundOpacity,
    setBackgroundBlur,
  } = useSettingsStore();

  const backgroundFileRef = useRef<HTMLInputElement>(null);
  const [backgroundMsg, setBackgroundMsg] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab, settingsModalOpen]);

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

  const allThemeKeys = Object.keys(THEMES);
  const darkThemeKeys = allThemeKeys.filter((id) => !isLightBackground(THEMES[id].background));
  const lightThemeKeys = allThemeKeys.filter((id) => isLightBackground(THEMES[id].background));

  // 纯色背景按深浅分类
  const darkSolids = SOLID_PRESETS.filter((s) => !isLightBackground(s.color));
  const lightSolids = SOLID_PRESETS.filter((s) => isLightBackground(s.color));

  const handlePickBackground = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBackgroundMsg("请选择图片文件（PNG / JPG / WebP 等）");
      return;
    }
    if (file.size > MAX_BACKGROUND_BYTES) {
      setBackgroundMsg("图片过大，请选择 8MB 以内的本地图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      await setBackgroundCustom(dataUrl);
      await setBackgroundId("custom");
      setBackgroundMsg(`已成功应用本地壁纸：${file.name}`);
    };
    reader.readAsDataURL(file);
  };

  const handleRestoreDefaultBackground = async () => {
    await setBackgroundCustom(null);
    await setBackgroundId("");
    setBackgroundMsg("已恢复默认纯净背景");
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);
    if (!oldPassword) {
      setPasswordMsg("请输入当前旧密码");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg("新密码长度不能少于 8 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg("两次输入的新密码不一致");
      return;
    }

    setSavingPassword(true);
    try {
      await changeVaultPassword(oldPassword, newPassword);
      setPasswordMsg("主密码修改成功！下次启动或解锁请使用新密码。");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPasswordMsg(`修改失败: ${err?.message || err}`);
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => setSettingsModalOpen(false)}
    >
      <div
        className="w-full max-w-[720px] bg-white rounded-2xl shadow-apple-xl border border-black/[0.08] flex flex-col max-h-[88vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div className="h-14 px-6 border-b border-black/[0.06] flex items-center justify-between shrink-0 bg-white/80 backdrop-blur-xl">
          <div>
            <h2 className="text-sm font-bold text-[#1d1d1f]">系统偏好设置</h2>
            <p className="text-[11px] text-[#86868b]">个性化定制主题色彩、背景壁纸与终端体验</p>
          </div>
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="p-1.5 rounded-full text-[#86868b] hover:text-[#1d1d1f] hover:bg-black/[0.05] transition"
            title="关闭 (Esc)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签导航栏 - 4 栏架构 */}
        <div className="px-6 py-2.5 bg-black/[0.02] border-b border-black/[0.06] flex items-center shrink-0">
          <div className="flex bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium">
            <button
              onClick={() => setActiveTab("general")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "general"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              🎨 主题配色
            </button>
            <button
              onClick={() => setActiveTab("wallpaper")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "wallpaper"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              🖼️ 壁纸与背景
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "terminal"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              📟 终端偏好
            </button>
            <button
              onClick={() => setActiveTab("security")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "security"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              🔒 安全与主密码
            </button>
          </div>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-6 text-xs text-[#1d1d1f] overflow-y-auto flex-1 min-h-0">
          {/* TAB 1: 主题配色 */}
          {activeTab === "general" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-1 border-b border-black/[0.06]">
                <div>
                  <h3 className="font-bold text-sm text-[#1d1d1f]">系统与终端配色方案</h3>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    选中即时应用到终端控制台及全局界面边框、画布底色与组件
                  </p>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-[#0071e3]/10 text-[#0071e3] font-semibold">
                  当前: {currentThemeConfig.name}
                </span>
              </div>

              {/* 深色系主题 */}
              <div>
                <h4 className="font-semibold text-xs text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <span>🌙</span> 沉浸深色系 (Dark Palettes)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {darkThemeKeys.map((id) => {
                    const cfg = THEMES[id];
                    const isSelected = theme === id;
                    const previewDots = [cfg.red, cfg.green, cfg.yellow, cfg.blue, cfg.cyan];
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        className={`flex flex-col text-left p-2.5 rounded-xl border transition active:scale-[0.98] ${
                          isSelected
                            ? "border-[#0071e3] ring-2 ring-[#0071e3]/20 bg-blue-50/20 shadow-apple-sm"
                            : "border-black/[0.08] hover:border-black/[0.2] bg-white"
                        }`}
                      >
                        <div
                          className="h-11 w-full rounded-lg mb-2 flex flex-col justify-between p-2 font-mono text-[9px] shadow-inner"
                          style={{
                            backgroundColor: cfg.background,
                            color: cfg.foreground,
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <span className="truncate">$ openshell</span>
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: cfg.cursor }}
                            />
                          </div>
                          <div className="flex gap-1">
                            {previewDots.map((c, i) => (
                              <span
                                key={i}
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#1d1d1f] truncate text-xs">
                            {cfg.name}
                          </span>
                          {isSelected && (
                            <span className="h-1.5 w-1.5 rounded-full bg-[#0071e3] shrink-0" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 明亮系主题 */}
              <div>
                <h4 className="font-semibold text-xs text-slate-700 mb-2.5 flex items-center gap-1.5">
                  <span>☀️</span> 明亮清爽系 (Light Palettes)
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {lightThemeKeys.map((id) => {
                    const cfg = THEMES[id];
                    const isSelected = theme === id;
                    const previewDots = [cfg.red, cfg.green, cfg.yellow, cfg.blue, cfg.cyan];
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTheme(id)}
                        className={`flex flex-col text-left p-2.5 rounded-xl border transition active:scale-[0.98] ${
                          isSelected
                            ? "border-[#0071e3] ring-2 ring-[#0071e3]/20 bg-blue-50/20 shadow-apple-sm"
                            : "border-black/[0.08] hover:border-black/[0.2] bg-white"
                        }`}
                      >
                        <div
                          className="h-11 w-full rounded-lg mb-2 flex flex-col justify-between p-2 font-mono text-[9px] shadow-inner border border-black/[0.08]"
                          style={{
                            backgroundColor: cfg.background,
                            color: cfg.foreground,
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <span className="truncate">$ openshell</span>
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: cfg.cursor }}
                            />
                          </div>
                          <div className="flex gap-1">
                            {previewDots.map((c, i) => (
                              <span
                                key={i}
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#1d1d1f] truncate text-xs">
                            {cfg.name}
                          </span>
                          {isSelected && (
                            <span className="h-1.5 w-1.5 rounded-full bg-[#0071e3] shrink-0" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 壁纸与背景 (单独开一栏) */}
          {activeTab === "wallpaper" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-1 border-b border-black/[0.06]">
                <div>
                  <h3 className="font-bold text-sm text-[#1d1d1f]">主界面与终端背景定制</h3>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    支持自定义本地图片、丰富经典纯色与质感艺术壁纸（数据纯本地保存）
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">
                    当前: {getBackgroundLabel(backgroundId)}
                  </span>
                  {(backgroundId !== "" || backgroundCustom) && (
                    <button
                      type="button"
                      onClick={handleRestoreDefaultBackground}
                      className="px-2.5 py-1 rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 font-semibold transition text-xs shadow-apple-sm"
                    >
                      恢复默认无壁纸
                    </button>
                  )}
                </div>
              </div>

              {backgroundMsg && (
                <div className="p-2 rounded-xl bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  {backgroundMsg}
                </div>
              )}

              {/* 1. 自定义本地图片壁纸 */}
              <div className="p-4 rounded-xl border border-black/[0.08] bg-[#fbfbfd]">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-base">📸</span>
                    <div>
                      <h4 className="font-semibold text-xs text-[#1d1d1f]">本地图片壁纸</h4>
                      <p className="text-[10px] text-[#86868b]">支持 PNG / JPG / WebP 等图片格式，文件上限 8MB</p>
                    </div>
                  </div>
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
                  <button
                    type="button"
                    onClick={() => backgroundFileRef.current?.click()}
                    className="px-3 py-1.5 rounded-xl border border-black/[0.1] bg-white text-slate-700 hover:bg-slate-50 font-medium transition shadow-apple-sm flex items-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    浏览本地图片...
                  </button>
                </div>

                {backgroundId === "custom" && backgroundCustom && (
                  <div className="relative aspect-[16/7] rounded-xl overflow-hidden border border-[#0071e3] ring-2 ring-[#0071e3]/20 shadow-apple-sm mt-2">
                    <img
                      src={backgroundCustom}
                      alt="Local wallpaper preview"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-2.5 text-white text-[11px] font-semibold">
                      <span>✓ 正在使用本地图片壁纸</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 2. 经典质感纯色背景 - 调整为合理的各种颜色 */}
              <div>
                <div className="mb-2.5">
                  <h4 className="font-semibold text-xs text-slate-700 flex items-center gap-1.5">
                    <span>🎨</span> 经典质感纯色背景 (Solid Color Schemes)
                  </h4>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    纯色底色极致省 GPU，无噪点干扰，在终端上具备最高的可读性
                  </p>
                </div>

                {/* 深色纯色 */}
                <div className="mb-3">
                  <div className="text-[10px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">
                    深邃沉稳色系
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {darkSolids.map((s) => {
                      const isSelected = backgroundId === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setBackgroundId(s.id)}
                          className={`flex flex-col items-center p-2 rounded-xl border transition active:scale-[0.98] ${
                            isSelected
                              ? "border-[#0071e3] ring-2 ring-[#0071e3]/25 bg-blue-50/20 shadow-apple-sm"
                              : "border-black/[0.08] hover:border-black/[0.2] bg-white"
                          }`}
                        >
                          <span
                            className="w-7 h-7 rounded-full shadow-inner mb-1.5 border border-white/20 flex items-center justify-center text-white text-[10px]"
                            style={{ backgroundColor: s.color }}
                          >
                            {isSelected && "✓"}
                          </span>
                          <span className="font-semibold text-[#1d1d1f] text-[11px]">{s.name}</span>
                          <span className="text-[9px] text-slate-400 font-mono">{s.color}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 浅色纯色 */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">
                    柔和清新色系
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
                    {lightSolids.map((s) => {
                      const isSelected = backgroundId === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setBackgroundId(s.id)}
                          className={`flex flex-col items-center p-2 rounded-xl border transition active:scale-[0.98] ${
                            isSelected
                              ? "border-[#0071e3] ring-2 ring-[#0071e3]/25 bg-blue-50/20 shadow-apple-sm"
                              : "border-black/[0.08] hover:border-black/[0.2] bg-white"
                          }`}
                        >
                          <span
                            className="w-7 h-7 rounded-full shadow-inner mb-1.5 border border-black/15 flex items-center justify-center text-slate-700 text-[10px]"
                            style={{ backgroundColor: s.color }}
                          >
                            {isSelected && "✓"}
                          </span>
                          <span className="font-semibold text-[#1d1d1f] text-[11px]">{s.name}</span>
                          <span className="text-[9px] text-slate-400 font-mono">{s.color}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 3. 艺术渐变与质感壁纸 */}
              <div>
                <div className="mb-2.5">
                  <h4 className="font-semibold text-xs text-slate-700 flex items-center gap-1.5">
                    <span>🌌</span> 质感渐变与纹理艺术壁纸 (Artistic Wallpapers)
                  </h4>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    精美多层 CSS 渐变、点阵网格与碳纤质感
                  </p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {WALLPAPER_PRESETS.map((w) => {
                    const selected = backgroundId === w.id;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setBackgroundId(w.id)}
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
                        <span className="absolute inset-x-0 bottom-0 px-2 py-1 text-left text-[10px] font-semibold text-white bg-gradient-to-t from-black/75 to-transparent">
                          {w.name}
                        </span>
                        {selected && (
                          <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#0071e3] text-white">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 4. 透明度与模糊微调 */}
              <div className="grid grid-cols-2 gap-4 bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                <div>
                  <label className="block font-semibold text-[#1d1d1f] mb-1">
                    壁纸透光度 (Opacity): {backgroundOpacity}%
                  </label>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={backgroundOpacity}
                    onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-0.5">调节终端背景透出底图/纯色的强度</p>
                </div>
                <div>
                  <label className="block font-semibold text-[#1d1d1f] mb-1">
                    背景模糊度 (Blur): {backgroundBlur}px
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    value={backgroundBlur}
                    onChange={(e) => setBackgroundBlur(Number(e.target.value))}
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-0.5">调节高斯模糊以营造磨砂亚克力玻璃质感</p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 终端显示偏好 */}
          {activeTab === "terminal" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-2">
                    字号大小: {fontSize}px
                  </label>
                  <input
                    type="range"
                    min={11}
                    max={24}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-1">支持快捷键 Ctrl/Cmd +/-/0 实时缩放</p>
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
                      启用终端光标呼吸闪烁
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
                    className="w-full px-2.5 py-1.5 bg-white border border-black/[0.08] rounded-lg text-xs text-[#1d1d1f] outline-none"
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
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                  <p className="text-[10px] text-[#86868b] mt-1">终端历史输出保留行数</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <label className="block font-semibold text-[#1d1d1f] mb-1.5">终端渲染方式</label>
                  <select
                    value={renderer}
                    onChange={(e) => setRenderer(e.target.value as "dom" | "webgl")}
                    className="w-full px-2.5 py-1.5 bg-white border border-black/[0.08] rounded-lg text-xs text-[#1d1d1f] outline-none"
                  >
                    <option value="dom">DOM（通用稳定）</option>
                    <option value="webgl">WebGL（高吞吐硬件加速）</option>
                  </select>
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
                    className="w-full accent-[#0071e3] cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: 安全与主密码 */}
          {activeTab === "security" && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-black/[0.06] bg-[#f5f5f7]">
                <div className="font-semibold text-[#1d1d1f] mb-1">主保险库状态</div>
                <div className="text-[#86868b] text-[11px] leading-relaxed">
                  当前状态:{" "}
                  <span className="font-semibold text-emerald-600">
                    {vaultStatus?.state === "unlocked" ? "已解锁 (可解密主机口令)" : "未解锁"}
                  </span>
                  <br />
                  采用 Argon2id 派生密钥与 AES-256-GCM 硬件加密保护，密码仅在本地解密，服务端永远无法获取。
                </div>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-3 pt-2">
                <div className="font-semibold text-sm text-[#1d1d1f]">修改主保险库密码</div>

                <div>
                  <label className="block text-[#86868b] mb-1">当前旧密码</label>
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="输入当前主密码"
                    className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[#86868b] mb-1">新主密码 (至少 8 位)</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="设置新主密码"
                      className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                    />
                  </div>
                  <div>
                    <label className="block text-[#86868b] mb-1">确认新主密码</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="再次确认新主密码"
                      className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                    />
                  </div>
                </div>

                {passwordMsg && (
                  <div
                    className={`p-2 rounded-lg text-xs border ${
                      passwordMsg.includes("成功")
                        ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                        : "bg-red-50 text-red-600 border-red-100"
                    }`}
                  >
                    {passwordMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={savingPassword}
                  className="px-4 py-2 bg-[#0071e3] text-white rounded-xl font-medium hover:bg-[#0077ed] transition shadow-apple-sm disabled:opacity-50"
                >
                  {savingPassword ? "正在派生更新密钥..." : "确认修改主密码"}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
