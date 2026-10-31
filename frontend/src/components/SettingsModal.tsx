import { GlassMaterial } from "./ui/GlassMaterial";
import React, { useRef, useState, useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  SCENIC_WALLPAPERS,
  ARTISTIC_WALLPAPERS,
  getBackgroundLabel,
  getStoredCustomWallpapers,
  addStoredCustomWallpaper,
  removeStoredCustomWallpaper,
  type CustomWallpaperItem,
} from "../lib/wallpapers";
import { useDialogBehavior } from "../lib/useDialogBehavior";
import { TerminalColorSettings } from "./settings/TerminalColorSettings";
import { ImageIcon, MountainIcon, SettingsIcon, SlidersIcon } from "./ui/icons";
import { useVaultStore } from "../stores/vaultStore";

const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;

export type SettingsTab = "wallpaper" | "terminal" | "colors" | "security";

interface SettingsModalProps {
  initialTab?: SettingsTab;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ initialTab = "wallpaper" }) => {
  const {
    fontSize,
    fontFamily,
    fontWeight,
    cursorBlink,
    cursorStyle,
    scrollback,
    renderer,
    keepaliveDefaultSec,
    settingsModalOpen,
    backgroundId,
    backgroundOpacity,
    backgroundBlur,
    setFontSize,
    setFontFamily,
    setFontWeight,
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

  // 分类筛选
  const [selectedCategory, setSelectedCategory] = useState<string>("全部");

  // 自定义网络图片 URL 输入
  const [customUrlInput, setCustomUrlInput] = useState("");
  const [customNameInput, setCustomNameInput] = useState("");
  const [urlTesting, setUrlTesting] = useState(false);

  // 自定义壁纸列表（从 localStorage 同步）
  const [customWallpapers, setCustomWallpapers] = useState<CustomWallpaperItem[]>([]);

  useEffect(() => {
    if (settingsModalOpen) {
      setCustomWallpapers(getStoredCustomWallpapers());
      if (initialTab) {
        setActiveTab(initialTab);
      }
    }
  }, [initialTab, settingsModalOpen]);

  // 修改主保险库密码
  const vaultStatus = useVaultStore((s) => s.status);
  const changeVaultPassword = useVaultStore((s) => s.changePassword);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(settingsModalOpen, () => setSettingsModalOpen(false), panelRef);

  if (!settingsModalOpen) return null;

  const categories = ["全部", "山川湖泊", "极光星空", "森林秘境", "日落霞光", "城市天际", "旷野大地"];
  const filteredScenic =
    selectedCategory === "全部"
      ? SCENIC_WALLPAPERS
      : SCENIC_WALLPAPERS.filter((s) => s.category === selectedCategory);

  // 1. 本地图片选择
  const handlePickLocalBackground = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBackgroundMsg("请选择图片文件（PNG / JPG / WebP 等）");
      return;
    }
    if (file.size > MAX_BACKGROUND_BYTES) {
      setBackgroundMsg("图片过大，请选择 10MB 以内的本地图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      await setBackgroundCustom(dataUrl);
      await setBackgroundId("custom");
      // 同时也存入用户自定库
      const item = addStoredCustomWallpaper(file.name.replace(/\.[^/.]+$/, ""), dataUrl);
      setCustomWallpapers(getStoredCustomWallpapers());
      await setBackgroundId(item.id);
      setBackgroundMsg(`已成功应用并保存本地壁纸：${item.name}`);
    };
    reader.readAsDataURL(file);
  };

  // 2. 添加并应用网络图片 URL
  const handleAddCustomUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = customUrlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setBackgroundMsg("请输入以 http:// 或 https:// 开头的合法图片链接");
      return;
    }

    setUrlTesting(true);
    setBackgroundMsg(null);

    // 预加载测试图片是否有效
    const img = new Image();
    img.onload = async () => {
      setUrlTesting(false);
      const name = customNameInput.trim() || `自定壁纸 ${customWallpapers.length + 1}`;
      const item = addStoredCustomWallpaper(name, url);
      setCustomWallpapers(getStoredCustomWallpapers());
      await setBackgroundId(item.id);
      setCustomUrlInput("");
      setCustomNameInput("");
      setBackgroundMsg(`✓ 已成功添加并切换为终端背景：${item.name}`);
    };
    img.onerror = () => {
      setUrlTesting(false);
      setBackgroundMsg("图片链接无法加载或存在跨域保护，请确认 URL 是否直接指向图片");
    };
    img.src = url;
  };

  // 3. 删除自定义壁纸
  const handleDeleteCustomWallpaper = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeStoredCustomWallpaper(id);
    setCustomWallpapers(getStoredCustomWallpapers());
    if (backgroundId === id) {
      setBackgroundId("");
    }
  };

  // 4. 恢复终端主题底色
  const handleRestoreDefaultBackground = async () => {
    await setBackgroundCustom(null);
    await setBackgroundId("");
    setBackgroundMsg("已恢复终端默认纯净背景");
  };

  // 5. 修改保险库主密码
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
      setPasswordMsg("主密码已更新，下次解锁请使用新密码。");
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => setSettingsModalOpen(false)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        tabIndex={-1}
        className="glass-host relative outline-none w-full max-w-[800px] rounded-3xl liquid-glass-panel flex flex-col max-h-[88vh] overflow-hidden shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        <GlassMaterial radius={24} />
        {/* 顶部标题栏 (Liquid Glass Header) */}
        <div className="h-14 px-6 border-b border-line/10  flex items-center justify-between shrink-0 bg-surface/40  backdrop-blur-md">
          <div className="flex items-center gap-3">
            <SettingsIcon className="h-5 w-5 text-accent" />
            <div>
              <h2 id="preferences-title" className="text-sm font-semibold text-ink">系统偏好设置</h2>
              <p className="text-[11px] text-ink-secondary ">
                管理终端显示、工作区背景与保险库安全
              </p>
            </div>
          </div>
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="w-7 h-7 rounded-full flex items-center justify-center text-ink-secondary hover:text-ink  bg-line/5  hover:bg-line/10 transition"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>

        {/* 标签导航栏 (Liquid Glass Capsule Tabs) */}
        <div className="px-6 py-2.5 bg-line/5  border-b border-line/10  flex items-center shrink-0">
          <div className="flex bg-line/5  p-1 rounded-2xl text-xs font-medium gap-1">
            <button
              onClick={() => setActiveTab("wallpaper")}
              className={`px-4 py-1.5 rounded-xl transition ${
                activeTab === "wallpaper"
                  ? "liquid-glass-pill-active"
                  : "text-ink-secondary  hover:text-ink"
              }`}
            >
              背景与壁纸
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-4 py-1.5 rounded-xl transition ${
                activeTab === "terminal"
                  ? "liquid-glass-pill-active"
                  : "text-ink-secondary  hover:text-ink"
              }`}
            >
              终端显示
            </button>
            <button onClick={() => setActiveTab("colors")}
              className={`px-4 py-1.5 rounded-xl transition ${activeTab === "colors" ? "liquid-glass-pill-active" : "text-ink-secondary hover:text-ink"}`}>
              终端配色
            </button>
            <button
              onClick={() => setActiveTab("security")}
              className={`px-4 py-1.5 rounded-xl transition ${
                activeTab === "security"
                  ? "liquid-glass-pill-active"
                  : "text-ink-secondary  hover:text-ink"
              }`}
            >
              安全与主密码
            </button>
          </div>
        </div>

        {/* 表单内容区 */}
        <div className="p-6 space-y-6 text-xs text-ink  overflow-y-auto flex-1 min-h-0">
          {activeTab === "colors" && <TerminalColorSettings />}
          {/* TAB 1: 终端风景壁纸与毛玻璃定制 */}
          {activeTab === "wallpaper" && (
            <div className="space-y-6">
              {/* 当前背景状态与恢复默认 */}
              <div className="flex items-center justify-between pb-2 border-b border-line/10 ">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink-secondary ">
                    当前终端背景:
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-accent/15 text-accent font-semibold text-[11px] border border-accent/20">
                    {getBackgroundLabel(backgroundId)}
                  </span>
                </div>
                {backgroundId !== "" && (
                  <button
                    type="button"
                    onClick={handleRestoreDefaultBackground}
                    className="px-3 py-1 rounded-xl border border-state-danger/30  bg-state-danger/10  text-state-danger  hover:bg-state-danger/10 font-semibold transition text-xs shadow-apple-sm"
                  >
                    恢复主题底色
                  </button>
                )}
              </div>

              {/* 壁纸强度只使用一个 0–100% 滑条，文字不参与透明度变化。 */}
              <div className="p-4 rounded-2xl liquid-glass-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <SlidersIcon className="h-4 w-4 text-ink-secondary" />
                    <div>
                      <h4 className="font-bold text-xs text-ink ">
                        壁纸不透明度
                      </h4>
                      <p className="text-[10px] text-ink-tertiary">
                        拖动调节 0–100%，默认 100%，仅改变壁纸，不影响终端文字
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-accent font-bold text-xs px-2.5 py-1 rounded-lg bg-accent/15 border border-accent/25">
                    {backgroundOpacity}%
                  </span>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-ink-tertiary">0%</span>
                    <span className="text-ink-tertiary">100%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={backgroundOpacity}
                    aria-label="壁纸不透明度"
                    aria-valuetext={`${backgroundOpacity}%`}
                    onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5 pt-2 border-t border-white/[0.08]">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-ink-secondary">
                      毛玻璃模糊度 (Blur)
                    </span>
                    <span className="font-mono text-ink-tertiary">{backgroundBlur}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={24}
                    step={1}
                    value={backgroundBlur}
                    onChange={(e) => setBackgroundBlur(Number(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                </div>
              </div>

              {backgroundMsg && (
                <div className="p-3 rounded-2xl bg-accent/10  border border-accent/30  text-xs text-accent  flex items-center justify-between animate-fade-in">
                  <span>{backgroundMsg}</span>
                  <button
                    onClick={() => setBackgroundMsg(null)}
                    className="text-accent hover:text-accent ml-2"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* 1. 精选 4K/高清电脑桌面风景壁纸 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="font-bold text-sm text-ink  flex items-center gap-1.5">
                      <MountainIcon className="h-4 w-4" /> 精选电脑风景桌面壁纸
                    </h3>
                    <p className="text-[11px] text-ink-secondary  mt-0.5">
                      点击即可瞬间切换当前终端背景，支持高分辨率自然风光
                    </p>
                  </div>
                </div>

                {/* 分类胶囊按钮 */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-3 py-1 rounded-full text-[11px] font-medium transition ${
                        selectedCategory === cat
                          ? "bg-action text-white shadow-apple-sm font-semibold"
                          : "bg-line/5  text-ink-secondary  hover:bg-line/10"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* 风景壁纸卡片瀑布网格 */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {selectedCategory === "全部" && (
                    <button
                      type="button"
                      onClick={handleRestoreDefaultBackground}
                      className={`group relative aspect-[16/10] rounded-2xl overflow-hidden border transition active:scale-[0.98] ${
                        backgroundId === ""
                          ? "border-accent ring-2 ring-accent/40 shadow-lg scale-[1.02]"
                          : "border-line/10  hover:border-line/10 "
                      }`}
                    >
                      <div className="w-full h-full bg-surface flex flex-col items-center justify-center p-3 text-center">
                        <div className="w-7 h-7 rounded-full bg-surface-muted flex items-center justify-center mb-1 text-ink-secondary">
                          ⬛
                        </div>
                        <span className="font-semibold text-ink text-xs">默认纯色</span>
                        <span className="text-[10px] text-ink-tertiary">纯黑底色</span>
                      </div>
                      {backgroundId === "" && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-action text-white flex items-center justify-center text-xs shadow-md">
                          ✓
                        </div>
                      )}
                    </button>
                  )}
                  {filteredScenic.map((s) => {
                    const isSelected = backgroundId === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => (isSelected ? handleRestoreDefaultBackground() : setBackgroundId(s.id))}
                        className={`group relative aspect-[16/10] rounded-2xl overflow-hidden border transition active:scale-[0.98] ${
                          isSelected
                            ? "border-accent ring-2 ring-accent/40 shadow-lg scale-[1.02]"
                            : "border-line/10  hover:border-line/10 "
                        }`}
                      >
                        <img
                          src={s.thumbnail}
                          alt={s.name}
                          loading="lazy"
                          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-white/95 via-white/60 to-transparent flex flex-col justify-end p-2.5 text-left">
                          <span className="text-[10px] text-ink-secondary font-medium opacity-90 text-ink-secondary">
                            {s.category}
                          </span>
                          <span className="font-semibold text-ink text-xs truncate">
                            {s.name}
                          </span>
                        </div>
                        {isSelected && (
                          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-action text-white flex items-center justify-center text-xs shadow-md">
                            ✓
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. 开源与自由自定义壁纸 (用户自定 URL 与本地上传) */}
              <div className="p-4 rounded-2xl liquid-glass-card">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-base">🎨</span>
                    <div>
                      <h4 className="font-bold text-xs text-ink ">
                        开源自由自定义壁纸
                      </h4>
                      <p className="text-[10px] text-ink-secondary ">
                        支持输入任意网络图片 URL、或上传本地高清照片
                      </p>
                    </div>
                  </div>
                  <input
                    ref={backgroundFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePickLocalBackground(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => backgroundFileRef.current?.click()}
                    className="px-3 py-1.5 rounded-xl border border-line/10  bg-surface/80  text-ink-secondary  hover:bg-surface font-medium transition shadow-apple-sm flex items-center gap-1.5"
                  >
                    <span>📷</span>
                    浏览本地图片...
                  </button>
                </div>

                {/* 网络图片 URL 添加表单 */}
                <form onSubmit={handleAddCustomUrl} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="输入网络壁纸图片链接 (https://...)"
                    className="flex-1 px-3 py-1.5 bg-surface/70  border border-line/10  rounded-xl text-xs text-ink  outline-none focus:border-accent"
                  />
                  <input
                    type="text"
                    value={customNameInput}
                    onChange={(e) => setCustomNameInput(e.target.value)}
                    placeholder="壁纸名称 (选填)"
                    className="w-32 px-3 py-1.5 bg-surface/70  border border-line/10  rounded-xl text-xs text-ink  outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={urlTesting || !customUrlInput.trim()}
                    className="px-4 py-1.5 rounded-xl bg-action text-white font-medium hover:bg-action/90 transition disabled:opacity-50 shadow-apple-sm shrink-0"
                  >
                    {urlTesting ? "测试中..." : "+ 添加壁纸"}
                  </button>
                </form>

                {/* 用户已添加的自定壁纸网格 */}
                {customWallpapers.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-ink-tertiary mb-2 uppercase tracking-wider">
                      已收藏自定壁纸库 ({customWallpapers.length})
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {customWallpapers.map((item) => {
                        const isSelected = backgroundId === item.id;
                        return (
                          <div
                            key={item.id}
                            onClick={() => (isSelected ? handleRestoreDefaultBackground() : setBackgroundId(item.id))}
                            className={`group relative aspect-[16/10] rounded-xl overflow-hidden border cursor-pointer transition active:scale-[0.98] ${
                              isSelected
                                ? "border-accent ring-2 ring-accent/40 shadow-apple-sm"
                                : "border-line/10  hover:border-line/10"
                            }`}
                          >
                            <img
                              src={item.url}
                              alt={item.name}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-white/95 to-transparent flex items-center justify-between text-ink text-[10px] font-medium">
                              <span className="truncate">{item.name}</span>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteCustomWallpaper(item.id, e)}
                                className="opacity-0 group-hover:opacity-100 hover:text-state-danger transition p-0.5"
                                title="删除此自定壁纸"
                              >
                                🗑️
                              </button>
                            </div>
                            {isSelected && (
                              <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-action text-white flex items-center justify-center text-[10px]">
                                ✓
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* 3. 艺术渐变与质感壁纸备选 */}
              <div>
                <h4 className="font-bold text-xs text-ink-secondary  mb-2 flex items-center gap-1.5">
                  <ImageIcon className="h-4 w-4" /> 质感渐变微光备选
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {ARTISTIC_WALLPAPERS.map((art) => {
                    const isSelected = backgroundId === art.id;
                    return (
                      <button
                        key={art.id}
                        type="button"
                        onClick={() => (isSelected ? handleRestoreDefaultBackground() : setBackgroundId(art.id))}
                        className={`relative aspect-[16/10] rounded-2xl overflow-hidden border transition active:scale-[0.98] ${
                          isSelected
                            ? "border-accent ring-2 ring-accent/40 shadow-apple-sm"
                            : "border-line/10  hover:border-line/10"
                        }`}
                        style={{ backgroundImage: art.image }}
                      >
                        <span className="absolute inset-x-0 bottom-0 px-2 py-1 text-left text-[10px] font-semibold text-ink bg-gradient-to-t from-white/95 to-transparent">
                          {art.name}
                        </span>
                        {isSelected && (
                          <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-action text-white text-[10px]">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 终端显示偏好 */}
          {activeTab === "terminal" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-2xl liquid-glass-card p-4">
                <div><label htmlFor="terminal-font-weight" className="text-os-xs font-semibold text-ink">文字清晰度</label>
                  <p className="mt-1 text-os-2xs text-ink-secondary">默认 14px 等宽字体，1.3 倍行高，增强文字对比度。</p></div>
                <select id="terminal-font-weight" value={fontWeight} onChange={(event) => setFontWeight(Number(event.target.value) as 400 | 500 | 600)}
                  className="rounded-os-md border border-line/20 bg-surface px-3 py-2 text-os-xs text-ink">
                  <option value={400}>标准 · 400</option><option value={500}>清晰 · 500（默认）</option><option value={600}>加粗 · 600</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="liquid-glass-card p-4 rounded-2xl">
                  <div className="flex justify-between items-center mb-2">
                    <label className="font-semibold text-ink ">
                      终端字号大小
                    </label>
                    <span className="font-mono text-accent font-bold">{fontSize}px</span>
                  </div>
                  <input
                    type="range"
                    min={11}
                    max={24}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                  <p className="text-[10px] text-ink-secondary  mt-1">
                    在终端内亦可按 Ctrl/Cmd +/-/0 实时缩放
                  </p>
                </div>

                <div className="liquid-glass-card p-4 rounded-2xl flex flex-col justify-center">
                  <label className="block font-semibold text-ink  mb-2">
                    光标呼吸闪烁
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="cursorBlink"
                      checked={cursorBlink}
                      onChange={(e) => setCursorBlink(e.target.checked)}
                      className="rounded text-accent focus:ring-0 accent-accent w-4 h-4 cursor-pointer"
                    />
                    <label
                      htmlFor="cursorBlink"
                      className="text-xs text-ink-secondary  cursor-pointer"
                    >
                      启用终端光标平滑呼吸闪烁
                    </label>
                  </div>
                </div>
              </div>

              <div className="liquid-glass-card p-4 rounded-2xl">
                <label className="block font-semibold text-ink  mb-1.5">
                  等宽字体族名 (Font Family)
                </label>
                <input
                  type="text"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-full px-3 py-2 bg-surface/70  border border-line/10  rounded-xl font-mono text-xs text-ink  outline-none focus:border-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="liquid-glass-card p-4 rounded-2xl">
                  <label className="block font-semibold text-ink  mb-1.5">
                    光标样式
                  </label>
                  <select
                    value={cursorStyle}
                    onChange={(e) => setCursorStyle(e.target.value as "bar" | "block" | "underline")}
                    className="w-full px-3 py-1.5 bg-surface/80  border border-line/10  rounded-xl text-xs text-ink  outline-none"
                  >
                    <option value="bar">竖线 (bar)</option>
                    <option value="block">方块 (block)</option>
                    <option value="underline">下划线 (underline)</option>
                  </select>
                </div>

                <div className="liquid-glass-card p-4 rounded-2xl">
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="font-semibold text-ink ">
                      滚动缓冲历史行数
                    </label>
                    <span className="font-mono text-accent font-bold">{scrollback} 行</span>
                  </div>
                  <input
                    type="range"
                    min={1000}
                    max={20000}
                    step={1000}
                    value={scrollback}
                    onChange={(e) => setScrollback(Number(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="liquid-glass-card p-4 rounded-2xl">
                  <label className="block font-semibold text-ink  mb-1.5">
                    终端渲染引擎
                  </label>
                  <select
                    value={renderer}
                    onChange={(e) => setRenderer(e.target.value as "dom" | "webgl")}
                    className="w-full px-3 py-1.5 bg-surface/80  border border-line/10  rounded-xl text-xs text-ink  outline-none"
                  >
                    <option value="dom">DOM（通用稳定）</option>
                    <option value="webgl">WebGL（高吞吐硬件加速）</option>
                  </select>
                </div>

                <div className="liquid-glass-card p-4 rounded-2xl">
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="font-semibold text-ink ">
                      KeepAlive 默认心跳间隔
                    </label>
                    <span className="font-mono text-accent font-bold">
                      {keepaliveDefaultSec === 0 ? "关闭" : `${keepaliveDefaultSec}s`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    step={5}
                    value={keepaliveDefaultSec}
                    onChange={(e) => setKeepaliveDefaultSec(Number(e.target.value))}
                    className="w-full accent-accent cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 安全与主密码 */}
          {activeTab === "security" && (
            <div className="space-y-4">
              <div className="liquid-glass-card p-4 rounded-2xl">
                <div className="font-bold text-ink  mb-1">主保险库安全状态</div>
                <div className="text-ink-secondary  text-[11px] leading-relaxed">
                  当前状态:{" "}
                  <span className="font-semibold text-state-success ">
                    {vaultStatus?.state === "unlocked" ? "已解锁 (可安全解密主机口令)" : "未解锁"}
                  </span>
                  <br />
                  采用行业级 Argon2id 派生密钥与 AES-256-GCM 硬件加密保护，密码仅在本地解密，服务端永远无法获取。
                </div>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-3 pt-2">
                <div className="font-bold text-sm text-ink ">修改主密码</div>

                <div>
                  <label className="block text-ink-secondary  mb-1">当前旧密码</label>
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="输入当前主密码"
                    className="w-full px-3 py-2 bg-surface/70  border border-line/10  rounded-xl text-xs text-ink  outline-none focus:border-accent"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-ink-secondary  mb-1">
                      新主密码 (至少 8 位)
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="设置新主密码"
                      className="w-full px-3 py-2 bg-surface/70  border border-line/10  rounded-xl text-xs text-ink  outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-ink-secondary  mb-1">确认新主密码</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="再次确认新主密码"
                      className="w-full px-3 py-2 bg-surface/70  border border-line/10  rounded-xl text-xs text-ink  outline-none focus:border-accent"
                    />
                  </div>
                </div>

                {passwordMsg && (
                  <div
                    className={`p-3 rounded-xl text-xs border ${
                      passwordMsg.includes("成功")
                        ? "bg-state-success/10 text-state-success border-state-success/30"
                        : "bg-state-danger/10 text-state-danger border-state-danger/30"
                    }`}
                  >
                    {passwordMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={savingPassword}
                  className="px-4 py-2 bg-action text-white rounded-xl font-medium hover:bg-action/90 transition shadow-apple-sm disabled:opacity-50"
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
