import React, { useEffect, useRef, useState } from "react";

interface SettingsDropdownProps {
  onOpenSettings: (tab?: "general" | "wallpaper" | "terminal" | "security") => void;
  onOpenSync: () => void;
  onOpenAbout: () => void;
  onCheckUpdate: () => void;
}

export const SettingsDropdown: React.FC<SettingsDropdownProps> = ({
  onOpenSettings,
  onOpenSync,
  onOpenAbout,
  onCheckUpdate,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`p-1.5 rounded-xl border transition shadow-apple-sm ${
          open
            ? "border-accent bg-accent/10 text-accent"
            : "border-slate-200/80 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        }`}
        title="系统设置与偏好 (点击展开分项菜单)"
        aria-label="设置菜单"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-52 origin-top-right rounded-xl border border-line/10 bg-white/95 backdrop-blur-xl py-1 text-xs text-slate-700 shadow-apple-lg z-50 animate-fade-in">
          <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            系统偏好设置
          </div>

          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings("general");
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">🎨</span>
            <div>
              <div className="font-medium text-slate-800">系统主题与配色</div>
              <div className="text-[10px] text-slate-400">深色/明亮多套精选主题</div>
            </div>
          </button>

          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings("wallpaper");
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">🖼️</span>
            <div>
              <div className="font-medium text-slate-800">壁纸与背景设置</div>
              <div className="text-[10px] text-slate-400">本地图片、丰富纯色与艺术纹理</div>
            </div>
          </button>

          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings("terminal");
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">📟</span>
            <div>
              <div className="font-medium text-slate-800">终端显示偏好</div>
              <div className="text-[10px] text-slate-400">字体、字号、光标与渲染引擎</div>
            </div>
          </button>

          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings("security");
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">🔒</span>
            <div>
              <div className="font-medium text-slate-800">安全与主密码</div>
              <div className="text-[10px] text-slate-400">主保险库密码与密钥派生</div>
            </div>
          </button>

          <button
            onClick={() => {
              setOpen(false);
              onOpenSync();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">☁️</span>
            <div>
              <div className="font-medium text-slate-800">账号与云同步</div>
              <div className="text-[10px] text-slate-400">自建服务端与多端同步</div>
            </div>
          </button>

          <div className="my-1 border-t border-slate-100" />

          <button
            onClick={() => {
              setOpen(false);
              onCheckUpdate();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">🔄</span>
            <span className="font-medium text-slate-800">检查软件更新...</span>
          </button>

          <button
            onClick={() => {
              setOpen(false);
              onOpenAbout();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-slate-100/80 transition"
          >
            <span className="text-sm">ℹ️</span>
            <span className="font-medium text-slate-800">关于 OpenShell</span>
          </button>
        </div>
      )}
    </div>
  );
};

