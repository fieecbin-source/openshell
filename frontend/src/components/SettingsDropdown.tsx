import { GlassMaterial } from "./ui/GlassMaterial";
import React, { useEffect, useRef, useState } from "react";
import { useUpdaterStore } from "../updater/store";
import { shouldShowBadge } from "../updater/state";
import { GlobeIcon, InfoIcon, LockIcon, RefreshIcon, SettingsIcon, TerminalIcon, LayersIcon, PaletteIcon } from "./ui/icons";

interface SettingsDropdownProps {
  onOpenSettings: (tab?: "wallpaper" | "terminal" | "colors" | "security") => void;
  onOpenSync: () => void;
  onOpenAbout: () => void;
  onCheckUpdate: () => void;
}

export const SettingsDropdown: React.FC<SettingsDropdownProps> = ({
  onOpenSettings, onOpenSync, onOpenAbout, onCheckUpdate,
}) => {
  const [open, setOpen] = useState(false);
  const updateState = useUpdaterStore((s) => s.state);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handleOutsideClick);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const items = [
    { icon: LayersIcon, label: "终端背景与壁纸", hint: "背景图片、透明度与模糊", action: () => onOpenSettings("wallpaper") },
    { icon: TerminalIcon, label: "终端显示偏好", hint: "字体、光标与渲染引擎", action: () => onOpenSettings("terminal") },
    { icon: PaletteIcon, label: "终端颜色调整", hint: "浅色主题、文字与 ANSI 配色", action: () => onOpenSettings("colors") },
    { icon: LockIcon, label: "安全与主密码", hint: "管理主保险库密码", action: () => onOpenSettings("security") },
    { icon: GlobeIcon, label: "账号与云同步", hint: "自建服务端与多端同步", action: onOpenSync },
    ...(shouldShowBadge(updateState) ? [{ icon: RefreshIcon, label: "发现新版本", action: onCheckUpdate }] : []),
    { icon: InfoIcon, label: "关于 OpenShell", action: onOpenAbout },
  ];

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-os-md border transition-colors ${open
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-line/15 bg-line/5 text-ink-secondary hover:bg-line/10 hover:text-ink"}`}
        title="系统偏好设置"
        aria-label="设置菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "settings-menu" : undefined}
      >
        <SettingsIcon className="h-4 w-4" />
      </button>
      {open && (
        <div
          id="settings-menu"
          ref={menuRef}
          role="menu"
          aria-label="系统偏好设置"
          className="glass-host absolute right-0 z-50 mt-2 w-64 origin-top-right rounded-os-xl liquid-glass-panel p-1.5 animate-zoom-in"
          onKeyDown={(event) => {
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); triggerRef.current?.focus(); }
              setOpen(false);
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          <GlassMaterial />
          <div className="px-3 pb-2 pt-1.5 text-os-2xs font-medium text-ink-tertiary">系统偏好设置</div>
          {items.map(({ icon: Icon, label, hint, action }, index) => (
            <React.Fragment key={label}>
              {index === 5 && <div role="separator" className="my-1.5 border-t border-line/10" />}
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded-os-md px-3 py-2 text-left text-ink-secondary transition-colors hover:bg-line/5 focus-visible:bg-line/5 focus-visible:text-ink"
                onClick={() => { triggerRef.current?.focus(); setOpen(false); action(); }}
              >
                <Icon className="h-4 w-4 shrink-0 text-ink-tertiary" />
                <span>
                  <span className="block text-os-xs font-medium text-ink">{label}</span>
                  {hint && <span className="mt-0.5 block text-os-2xs text-ink-tertiary">{hint}</span>}
                </span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
