import React, { useRef, useState, useEffect } from "react";
import {
  useSettingsStore,
  THEMES,
  resolveTheme,
  type TerminalThemeConfig,
} from "../stores/settingsStore";
import {
  WALLPAPER_PRESETS,
  WALLPAPER_SIZES,
} from "../lib/wallpapers";
import { useVaultStore } from "../stores/vaultStore";

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;

interface SettingsModalProps {
  initialTab?: "general" | "terminal" | "security";
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

  const [activeTab, setActiveTab] = useState<"general" | "terminal" | "security">(initialTab);

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

  const themeOptions: { id: string; config: TerminalThemeConfig }[] = Object.keys(THEMES).map(
    (id) => ({ id, config: THEMES[id] })
  );

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
      setBackgroundMsg(`已选择本地壁纸：${file.name}`);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => setSettingsModalOpen(false)}
    >
      <div
        className="w-full max-w-[680px] bg-white rounded-2xl shadow-apple-xl border border-black/[0.08] flex flex-col max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div className="h-14 px-6 border-b border-black/[0.06] flex items-center justify-between shrink-0 bg-white/80 backdrop-blur-xl">
          <div>
            <h2 className="text-sm font-bold text-[#1d1d1f]">系统偏好设置</h2>
            <p className="text-[11px] text-[#86868b]">个性化定制外观、终端操作与主密码</p>
          </div>
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="p-1 rounded-full text-[#86868b] hover:text-[#1d1d1f] hover:bg-black/[0.05] transition"
            title="关闭 (Esc)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签导航栏 */}
        <div className="px-6 py-2.5 bg-black/[0.02] border-b border-black/[0.06] flex items-center shrink-0">
          <div className="flex bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium">
            <button
              onClick={() => setActiveTab("general")}
              className={`px-4 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "general"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              通用外观与壁纸
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-4 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "terminal"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              终端显示偏好
            </button>
            <button
              onClick={() => setActiveTab("security")}
              className={`px-4 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "security"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              安全与主密码
            </button>
          </div>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-5 text-xs text-[#1d1d1f] overflow-y-auto flex-1 min-h-0">
          {activeTab === "general" && (
            <div className="space-y-6">
              {/* 配色主题 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="font-semibold text-[#1d1d1f] text-sm">系统与终端配色方案</label>
                  <span className="text-[11px] text-[#86868b] font-mono">
                    当前应用: {currentThemeConfig.name}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {themeOptions.map((t) => {
                    const isSelected = theme === t.id;
                    const previewColors = [
                      t.config.red,
                      t.config.green,
                      t.config.yellow,
                      t.config.blue,
                      t.config.cyan,
                    ];
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTheme(t.id)}
                        className={`flex flex-col text-left p-3 rounded-xl border transition active:scale-[0.98] ${
                          isSelected
                            ? "border-[#0071e3] ring-2 ring-[#0071e3]/20 bg-blue-50/20 shadow-apple-sm"
                            : "border-black/[0.08] hover:border-black/[0.2] bg-white"
                        }`}
                      >
                        <div
                          className="h-10 w-full rounded-lg mb-2 flex flex-col justify-between p-2 font-mono text-[9px] shadow-inner"
                          style={{
                            backgroundColor: t.config.background,
                            color: t.config.foreground,
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <span>$ ls -la</span>
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: t.config.cursor }}
                            />
                          </div>
                          <div className="flex gap-1">
                            {previewColors.map((c, i) => (
                              <span
                                key={i}
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#1d1d1f] truncate text-xs">
                            {t.config.name}
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

              {/* 背景壁纸 */}
              <div className="pt-4 border-t border-black/[0.06]">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <label className="font-semibold text-[#1d1d1f] text-sm">主界面与终端背景壁纸</label>
                    <p className="text-[11px] text-[#86868b] mt-0.5">
                      壁纸仅存储在本地设备，绝不参与多端同步
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
                    {(backgroundId !== "" || backgroundCustom) && (
                      <button
                        type="button"
                        onClick={handleRestoreDefaultBackground}
                        className="px-3 py-1.5 rounded-xl border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 font-medium transition shadow-apple-sm"
                      >
                        恢复默认背景
                      </button>
                    )}
                  </div>
                </div>

                {backgroundMsg && (
                  <div className="mb-3 p-2 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                    {backgroundMsg}
                  </div>
                )}

                {/* 预设壁纸网格 */}
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
                        <span className="absolute inset-x-0 bottom-0 px-2 py-1 text-left text-[10px] font-semibold text-white bg-gradient-to-t from-black/70 to-transparent">
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

                {/* 透明度与模糊调节 */}
                <div className="mt-4 grid grid-cols-2 gap-4 bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                  <div>
                    <label className="block font-semibold text-[#1d1d1f] mb-1">
                      壁纸透明度: {backgroundOpacity}%
                    </label>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={backgroundOpacity}
                      onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                      className="w-full accent-[#0071e3] cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-[#1d1d1f] mb-1">
                      背景模糊度: {backgroundBlur}px
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      value={backgroundBlur}
                      onChange={(e) => setBackgroundBlur(Number(e.target.value))}
                      className="w-full accent-[#0071e3] cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

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
                  <p className="text-[10px] text-[#86868b] mt-1">支持快捷键 Ctrl/Cmd +/-/0 缩放</p>
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

          {activeTab === "security" && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl border border-black/[0.06] bg-[#f5f5f7]">
                <div className="font-semibold text-[#1d1d1f] mb-1">主保险库状态</div>
                <div className="text-[11px] text-[#86868b]">
                  当前状态:{" "}
                  <span className="font-mono text-emerald-600 font-bold">
                    {vaultStatus?.state === "unlocked" ? "已解锁 (正常读写)" : "已锁定"}
                  </span>
                </div>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-3">
                <div>
                  <label className="block font-semibold text-[#1d1d1f] mb-1">当前旧主密码</label>
                  <input
                    type="password"
                    required
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-[#1d1d1f] mb-1">新主密码</label>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-[#1d1d1f] mb-1">再次确认新主密码</label>
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white"
                  />
                </div>

                {passwordMsg && (
                  <div
                    className={`text-xs p-2.5 rounded-lg ${
                      passwordMsg.includes("成功")
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : "bg-red-50 text-red-700 border border-red-200"
                    }`}
                  >
                    {passwordMsg}
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={savingPassword}
                    className="px-4 py-2 rounded-xl bg-[#0071e3] hover:bg-[#0077ed] text-white font-semibold text-xs shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                  >
                    {savingPassword ? "正在更新..." : "确认修改主密码"}
                  </button>
                </div>
              </form>
            </div>
          )}
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
