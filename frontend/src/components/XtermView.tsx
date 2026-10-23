import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { TerminalTab } from "../stores/terminalStore";
import { useTerminalStore } from "../stores/terminalStore";
import { THEMES, useSettingsStore } from "../stores/settingsStore";
import { getWallpaper, WALLPAPER_SIZES } from "../lib/wallpapers";
import { formatFriendlyError } from "../lib/errors";
import { TerminalSearch } from "./TerminalSearch";
import { ConnectAuthModal } from "./ConnectAuthModal";
import {
  ackTerminal,
  openTerminal,
  resizeTerminal,
  writeTerminal,
  sendSerial,
  readSerial,
} from "../lib/ipc";

interface XtermViewProps {
  tab: TerminalTab;
}

/** 将主题背景色的十六进制值转换为带透明度的 rgba，用于透出壁纸 */
function withAlpha(hexColor: string, alpha: number): string {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6 && hex.length !== 3) return hexColor;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const XtermView: React.FC<XtermViewProps> = ({ tab }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // 记录当前已建立终端通道的 connectionId，重连后 connectionId 变化需要重新打开通道
  const openedConnectionRef = useRef<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 由终端初始化时注册的复制/粘贴动作，供右键菜单调用
  const clipboardRef = useRef<{ copy: () => void; paste: () => void } | null>(null);
  const reconnectTab = useTerminalStore((s) => s.reconnectTab);

  // 认证/凭据类错误自动弹出补录窗口，用户可直接填写密码或私钥口令重连
  useEffect(() => {
    if (
      tab.status === "error" &&
      tab.error &&
      !/保险库/.test(tab.error) &&
      /口令|私钥|认证|登录密码/.test(tab.error)
    ) {
      setAuthModalOpen(true);
    }
  }, [tab.status, tab.error]);
  const {
    theme,
    fontSize,
    fontFamily,
    cursorBlink,
    logSessionOutput,
    backgroundId,
    backgroundCustom,
    backgroundOpacity,
    backgroundBlur,
  } = useSettingsStore();

  const currentTheme = THEMES[theme] || THEMES.dark;

  const wallpaper = useMemo(() => {
    if (!backgroundId) return null;
    if (backgroundId === "custom") {
      return backgroundCustom
        ? { image: `url(${backgroundCustom})`, size: "cover" }
        : null;
    }
    const preset = getWallpaper(backgroundId);
    return preset ? { image: preset.image, size: WALLPAPER_SIZES[preset.id] || "cover" } : null;
  }, [backgroundId, backgroundCustom]);

  const hasWallpaper = !!wallpaper;

  // 1. 初始化终端实例与 Addons
  useEffect(() => {
    if (!containerRef.current) return;

    // 壁纸启用时需要透出背景图层，因此必须开启 allowTransparency；
    // WebGL 渲染器不支持透明，这里统一使用 DOM 渲染器保证背景可见。
    const term = new Terminal({
      cursorBlink,
      cursorStyle: "bar",
      fontSize,
      fontFamily,
      allowTransparency: true,
      theme: hasWallpaper
        ? { ...currentTheme, background: withAlpha(currentTheme.background, 0.78) }
        : currentTheme,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // 复制 / 粘贴：终端默认把按键当作输入发送，这里显式拦截常见快捷键
    const copySelection = () => {
      const selection = term.getSelection();
      if (!selection) return;
      navigator.clipboard.writeText(selection).catch(() => {
        // 旧版 WebView 回退方案
        const ta = document.createElement("textarea");
        ta.value = selection;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      });
    };
    const pasteClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
      } catch {
        // 剪贴板不可用时静默忽略
      }
    };
    clipboardRef.current = { copy: copySelection, paste: () => void pasteClipboard() };

    term.attachCustomKeyEventHandler((ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      if (mod && !ev.shiftKey && key === "f") {
        ev.preventDefault();
        setSearchOpen((prev) => !prev);
        return false;
      }
      if (mod && ev.shiftKey && key === "c") {
        copySelection();
        return false;
      }
      // Ctrl+C 仅在存在选区时复制，否则保留中断当前命令的语义
      if (mod && !ev.shiftKey && key === "c" && term.hasSelection()) {
        copySelection();
        return false;
      }
      if (mod && key === "v") {
        void pasteClipboard();
        return false;
      }
      if (ev.shiftKey && ev.key === "Insert") {
        void pasteClipboard();
        return false;
      }
      return true;
    });

    // 键盘输入监听
    const onDataDispose = term.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      if (tab.protocol === "serial") {
        sendSerial(tab.cardId || tab.tabId, Array.from(bytes)).catch((e) =>
          console.warn("failed to write to serial", e)
        );
      } else {
        writeTerminal(tab.tabId, bytes).catch((e) =>
          console.warn("failed to write to terminal", e)
        );
      }
    });

    // ResizeObserver 监听容器尺寸调整
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        const cols = terminalRef.current.cols;
        const rows = terminalRef.current.rows;
        if (tab.protocol !== "serial") {
          resizeTerminal(tab.tabId, cols, rows).catch(() => {});
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      onDataDispose.dispose();
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      clipboardRef.current = null;
      openedConnectionRef.current = null;
    };
  }, [tab.tabId, tab.protocol, tab.cardId]);

  // 右键菜单：复制 / 粘贴
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener("contextmenu", onContextMenu);
    return () => el.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu]);

  // 2. 动态响应主题、字体与壁纸设置更改
  useEffect(() => {
    if (!terminalRef.current) return;
    const term = terminalRef.current;
    term.options.theme = hasWallpaper
      ? { ...currentTheme, background: withAlpha(currentTheme.background, 0.78) }
      : currentTheme;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorBlink = cursorBlink;
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [theme, fontSize, fontFamily, cursorBlink, hasWallpaper]);

  // 3. 连接就绪后建立双向流
  useEffect(() => {
    if (tab.status !== "connected" || !terminalRef.current) {
      return;
    }

    const term = terminalRef.current;

    // 串口连接轮询消费缓冲
    if (tab.protocol === "serial") {
      let isCancelled = false;
      const targetCardId = tab.cardId || tab.tabId;

      const pollInterval = setInterval(async () => {
        if (isCancelled) return;
        try {
          const bytes = await readSerial(targetCardId, 4096);
          if (bytes && bytes.length > 0 && !isCancelled) {
            term.write(new Uint8Array(bytes));
            if (logSessionOutput) {
              const text = new TextDecoder().decode(new Uint8Array(bytes));
              window.__openshell_session_log = (window.__openshell_session_log || "") + text;
            }
          }
        } catch {
          // ignore read error
        }
      }, 50);

      return () => {
        isCancelled = true;
        clearInterval(pollInterval);
      };
    }

    // SSH 连接通道（重连后 connectionId 变化时必须重新打开）
    if (!tab.connectionId || openedConnectionRef.current === tab.connectionId) {
      return;
    }

    openedConnectionRef.current = tab.connectionId;

    const onIncomingData = (frameBytes: number[]) => {
      if (frameBytes.length < 5) return;

      const tag = frameBytes[0];
      // 二进制帧格式：0x01 为 PTY 数据
      if (tag === 0x01) {
        const payload = new Uint8Array(frameBytes.slice(5));
        term.write(payload, () => {
          // 消费完成后反馈确认（流控信用）
          ackTerminal(tab.tabId, payload.length).catch(() => {});
        });

        if (logSessionOutput) {
          // 若启用会话日志记录，可实时保留
          const text = new TextDecoder().decode(payload);
          window.__openshell_session_log = (window.__openshell_session_log || "") + text;
        }
      }
    };

    openTerminal(
      tab.tabId,
      tab.connectionId,
      term.cols,
      term.rows,
      onIncomingData
    ).catch((err) => {
      term.write(`\r\n\x1b[31m[OpenShell] 终端连接失败：${formatFriendlyError(err)}\x1b[0m\r\n`);
    });
  }, [tab.connectionId, tab.status, tab.tabId, tab.protocol, tab.cardId, logSessionOutput]);

  return (
    <div className="relative h-full w-full bg-surface-950 overflow-hidden">
      {/* 自定义壁纸背景层（位于终端画布下方，不拦截任何交互） */}
      {wallpaper && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-300"
          style={{
            backgroundImage: wallpaper.image,
            backgroundSize: wallpaper.size,
            backgroundPosition: "center",
            backgroundRepeat: "repeat",
            backgroundColor: currentTheme.background,
            filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
            transform: backgroundBlur > 0 ? "scale(1.06)" : undefined,
            opacity: Math.max(0, Math.min(100, backgroundOpacity)) / 100,
          }}
        />
      )}

      {/* 搜索工具栏 */}
      {searchOpen && (
        <TerminalSearch
          searchAddon={searchAddonRef.current}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* 快捷搜索入口小按钮 */}
      <button
        onClick={() => setSearchOpen((prev) => !prev)}
        title="在终端中搜索 (Ctrl+F)"
        className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-surface-900/60 hover:bg-surface-800 text-slate-500 hover:text-slate-200 border border-surface-800/80 backdrop-blur-sm transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>

      {tab.status === "connecting" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-950/80 backdrop-blur-sm text-slate-300">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent mb-3" />
          <p className="text-xs font-medium">
            {tab.protocol === "serial" ? "正在打开串口通道..." : "正在建立 SSH 安全连接..."}
          </p>
          <p className="text-[10px] text-slate-500 mt-1">{tab.sessionName}</p>
        </div>
      )}

      {tab.status === "error" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-950/90 text-red-400 p-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 border border-red-500/20 mb-3 text-red-400">
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h4 className="text-sm font-bold text-white mb-1">连接失败</h4>
          <p className="text-xs max-w-md text-red-300 mb-4 whitespace-pre-line">
            {tab.error || "网络连接失败，请稍后重试。"}
          </p>
          {tab.protocol !== "serial" && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setAuthModalOpen(true)}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition"
              >
                填写凭据重试
              </button>
              <button
                onClick={() => reconnectTab(tab.tabId)}
                className="px-3.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-xs font-semibold transition"
              >
                重新连接
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />

      {ctxMenu && (
        <div
          className="fixed z-[70] min-w-[132px] rounded-lg border border-black/10 bg-white py-1 shadow-xl text-xs text-[#1d1d1f]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left hover:bg-black/[0.06] disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!terminalRef.current?.hasSelection()}
            onClick={() => {
              clipboardRef.current?.copy();
              setCtxMenu(null);
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left hover:bg-black/[0.06]"
            onClick={() => {
              clipboardRef.current?.paste();
              setCtxMenu(null);
            }}
          >
            粘贴
          </button>
        </div>
      )}

      {authModalOpen && (
        <ConnectAuthModal tab={tab} onClose={() => setAuthModalOpen(false)} />
      )}
    </div>
  );
};

declare global {
  interface Window {
    __openshell_session_log?: string;
  }
}
