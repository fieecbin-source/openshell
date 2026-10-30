import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TerminalTab } from "../stores/terminalStore";
import { useTerminalStore } from "../stores/terminalStore";
import { resolveTheme, useSettingsStore } from "../stores/settingsStore";
import { getWallpaperStyle } from "../lib/wallpapers";
import { formatFriendlyError } from "../lib/errors";
import { appendSessionLog, dropSessionLog } from "../lib/terminal-log";
import { TerminalSearch } from "./TerminalSearch";
import { ConnectAuthModal } from "./ConnectAuthModal";
import { Button } from "./ui/Button";
import { RefreshIcon, SearchIcon, TriangleAlertIcon } from "./ui/icons";
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
  /**
   * 当前是否处于可见槽位。
   *
   * 所有已打开的标签终端都常驻挂载（见 TerminalHost），隐藏的终端不会 fit、
   * 不会向后端同步尺寸、串口也不再轮询；恢复可见时会重新 fit 一次并补发一次
   * `terminal_resize`，保证 PTY 列宽与界面一致。
   */
  visible?: boolean;
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

/** 只允许打开 http/https 链接，避免终端内容诱导打开本地文件或自定义协议 */
function isSafeUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

export const XtermView: React.FC<XtermViewProps> = ({ tab, visible = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  // 记录当前已建立终端通道的 connectionId，重连后 connectionId 变化需要重新打开通道
  const openedConnectionRef = useRef<string | null>(null);
  // 最近一次同步给后端的 PTY 尺寸，避免重复 resize 与抖动
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // 供 ResizeObserver 调用的最新「适应尺寸」实现
  const syncSizeRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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

  // 逐字段订阅，避免设置面板开关（settingsModalOpen）等无关变化让所有终端重渲染
  const theme = useSettingsStore((s) => s.theme);
  const customThemes = useSettingsStore((s) => s.customThemes);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const cursorBlink = useSettingsStore((s) => s.cursorBlink);
  const cursorStyle = useSettingsStore((s) => s.cursorStyle);
  const scrollback = useSettingsStore((s) => s.scrollback);
  const renderer = useSettingsStore((s) => s.renderer);
  const logSessionOutput = useSettingsStore((s) => s.logSessionOutput);
  const backgroundId = useSettingsStore((s) => s.backgroundId);
  const backgroundCustom = useSettingsStore((s) => s.backgroundCustom);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const backgroundBlur = useSettingsStore((s) => s.backgroundBlur);

  const currentTheme = resolveTheme(theme, customThemes);

  const wallpaper = useMemo(
    () => getWallpaperStyle(backgroundId, backgroundCustom),
    [backgroundId, backgroundCustom]
  );

  const hasWallpaper = !!wallpaper;

  // 初始化用的最新配置快照：init effect 只依赖标签身份，其余配置在下面单独应用
  const initOptionsRef = useRef({
    cursorBlink,
    cursorStyle,
    fontSize,
    fontFamily,
    scrollback,
    renderer,
    theme: currentTheme,
    hasWallpaper,
  });
  initOptionsRef.current = {
    cursorBlink,
    cursorStyle,
    fontSize,
    fontFamily,
    scrollback,
    renderer,
    theme: currentTheme,
    hasWallpaper,
  };

  // 1. 初始化终端实例与 Addons
  useEffect(() => {
    if (!containerRef.current) return;
    const opts = initOptionsRef.current;

    // 壁纸启用时需要透出背景图层，因此必须开启 allowTransparency；
    // WebGL 渲染器与透明背景不兼容，只在关闭壁纸且用户显式选择时才启用。
    const useWebgl = opts.renderer === "webgl" && !opts.hasWallpaper;

    const term = new Terminal({
      cursorBlink: opts.cursorBlink,
      cursorStyle: opts.cursorStyle,
      fontSize: opts.fontSize,
      fontFamily: opts.fontFamily,
      allowTransparency: opts.hasWallpaper,
      scrollback: opts.scrollback,
      // unicode11 与部分宽度计算 API 需要开启 proposed API
      allowProposedApi: true,
      theme: opts.hasWallpaper
        ? { ...opts.theme, background: withAlpha(opts.theme.background, 0.78) }
        : opts.theme,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    // 宽字符（中日韩、emoji）列宽按 Unicode 11 计算，避免表格/进度条错位
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    // 终端里的 URL 可直接点击，用系统浏览器打开（仅 http/https）
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        if (!isSafeUrl(uri)) return;
        openUrl(uri).catch((err) => console.warn("failed to open url", err));
      })
    );

    term.open(containerRef.current);

    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        // 上下文丢失（驱动重置 / GPU 进程崩溃）时自动回落到 DOM 渲染器
        webgl.onContextLoss(() => {
          console.warn("webgl context lost, falling back to DOM renderer");
          webgl.dispose();
          webglAddonRef.current = null;
        });
        term.loadAddon(webgl);
        webglAddonRef.current = webgl;
      } catch (e) {
        console.warn("webgl renderer unavailable, falling back to DOM renderer", e);
        webglAddonRef.current = null;
      }
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // 统一的「适应容器尺寸 + 同步 PTY 尺寸」入口
    syncSizeRef.current = () => {
      const el = containerRef.current;
      const current = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!el || !current || !fit) return;
      // 隐藏标签或被 display:none 的容器尺寸为 0，此时 fit 会算出错误的极小值
      if (!visibleRef.current || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch (e) {
        console.warn("terminal fit failed", e);
        return;
      }
      const cols = current.cols;
      const rows = current.rows;
      if (cols <= 0 || rows <= 0) return;
      if (lastSizeRef.current?.cols === cols && lastSizeRef.current?.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      if (tab.protocol === "serial") return;
      resizeTerminal(tab.tabId, cols, rows).catch(() => {});
    };

    syncSizeRef.current();

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
        // 长按会连续触发 keydown，这里只在非重复事件时切换，避免搜索框反复开关
        if (!ev.repeat) setSearchOpen((prev) => !prev);
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
      // Ctrl/Cmd + / = 放大字号
      if (mod && (key === "=" || key === "+")) {
        ev.preventDefault();
        const cur = useSettingsStore.getState().fontSize;
        void useSettingsStore.getState().setFontSize(Math.min(32, cur + 1));
        return false;
      }
      // Ctrl/Cmd - 缩小字号
      if (mod && key === "-") {
        ev.preventDefault();
        const cur = useSettingsStore.getState().fontSize;
        void useSettingsStore.getState().setFontSize(Math.max(9, cur - 1));
        return false;
      }
      // Ctrl/Cmd 0 重置字号为 13
      if (mod && key === "0") {
        ev.preventDefault();
        void useSettingsStore.getState().setFontSize(13);
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

    // ResizeObserver：拖拽分屏条时每帧都会触发，必须防抖，
    // 否则一次拖拽会产生几十上百次 fit + IPC resize。
    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        syncSizeRef.current();
      }, 50);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      onDataDispose.dispose();
      resizeObserver.disconnect();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      clipboardRef.current = null;
      openedConnectionRef.current = null;
      lastSizeRef.current = null;
      dropSessionLog(tab.tabId);
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

  // 2. 动态响应主题、字体、滚动缓冲等设置更改
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = hasWallpaper
      ? { ...currentTheme, background: withAlpha(currentTheme.background, 0.78) }
      : currentTheme;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorBlink = cursorBlink;
    term.options.cursorStyle = cursorStyle;
    if (term.options.scrollback !== scrollback) {
      term.options.scrollback = scrollback;
    }
    // 字号/字体变化会改变 cols/rows，必须把新尺寸同步给 PTY，
    // 否则 vim / htop / less 等全屏程序会按旧列宽换行、界面错乱。
    if (visibleRef.current) {
      const id = requestAnimationFrame(() => syncSizeRef.current());
      return () => cancelAnimationFrame(id);
    }
  }, [
    theme,
    fontSize,
    fontFamily,
    cursorBlink,
    cursorStyle,
    scrollback,
    hasWallpaper,
    currentTheme,
  ]);

  // 3. 从隐藏恢复为可见时补一次 fit + resize（切标签、切分屏、返回主页后回来）
  useEffect(() => {
    if (!visible) return;
    // 等浏览器完成布局再过一帧，避免拿到旧的容器尺寸
    const id = requestAnimationFrame(() => syncSizeRef.current());
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // 4. 连接就绪后建立双向流
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
        // 标签不可见时暂停轮询：多开串口标签时这是 20 次 IPC/秒/标签的开销
        if (isCancelled || !visibleRef.current) return;
        try {
          const bytes = await readSerial(targetCardId, 4096);
          if (bytes && bytes.length > 0 && !isCancelled) {
            const payload = new Uint8Array(bytes);
            term.write(payload);
            if (logSessionOutput) {
              appendSessionLog(tab.tabId, payload);
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
    // 打开通道时就会把当前尺寸带给后端，先记录下来避免立刻再发一次 resize
    lastSizeRef.current = { cols: term.cols, rows: term.rows };

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
          appendSessionLog(tab.tabId, payload);
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
      // 打开失败时清空标记，下次 effect 触发时还允许重试
      openedConnectionRef.current = null;
      // 组件可能已经卸载，向已 dispose 的终端写入会抛异常
      if (terminalRef.current !== term) return;
      term.write(`\r\n\x1b[31m[OpenShell] 终端连接失败：${formatFriendlyError(err)}\x1b[0m\r\n`);
    });
  }, [tab.connectionId, tab.status, tab.tabId, tab.protocol, tab.cardId, logSessionOutput]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-surface-muted">
      {/* 自定义壁纸背景层（位于终端画布下方，不拦截任何交互） */}
      {wallpaper && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-300"
          style={{
            backgroundImage: wallpaper.backgroundImage,
            backgroundSize: wallpaper.backgroundSize,
            backgroundPosition: "center",
            backgroundRepeat: "repeat",
            // 纯色预设没有图片，必须用预设色，否则会退回主题底色导致「选了没变化」
            backgroundColor: wallpaper.backgroundColor || currentTheme.background,
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
        aria-label="在终端中搜索"
        className="absolute right-2 top-2 z-20 rounded-os-md border border-line/10 bg-surface/80 p-1.5 text-ink-tertiary shadow-os-sm backdrop-blur-sm transition-colors duration-os ease-os hover:bg-surface hover:text-ink"
      >
        <SearchIcon className="h-3.5 w-3.5" />
      </button>

      {tab.status === "connecting" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface/85 text-ink-secondary backdrop-blur-sm">
          <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-os-sm font-medium text-ink">
            {tab.protocol === "serial" ? "正在打开串口通道..." : "正在建立 SSH 安全连接..."}
          </p>
          <p className="mt-1 text-os-2xs text-ink-tertiary">{tab.sessionName}</p>
        </div>
      )}

      {tab.status === "error" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface/95 p-6 text-center backdrop-blur-sm">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-os-lg border border-state-danger/25 bg-state-danger/5 text-state-danger">
            <TriangleAlertIcon className="h-6 w-6" />
          </div>
          <h4 className="text-os-sm font-semibold text-ink">连接失败</h4>
          <p className="mb-4 mt-1 max-w-md whitespace-pre-line text-os-xs leading-relaxed text-ink-secondary">
            {tab.error || "网络连接失败，请稍后重试。"}
          </p>
          {tab.protocol !== "serial" && (
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => setAuthModalOpen(true)}>
                填写凭据重试
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leading={<RefreshIcon className="h-3.5 w-3.5" />}
                onClick={() => reconnectTab(tab.tabId)}
              >
                重新连接
              </Button>
            </div>
          )}
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />

      {ctxMenu && (
        <div
          className="fixed z-[70] min-w-[132px] rounded-os-md border border-line/10 bg-surface py-1 text-os-xs text-ink shadow-os-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors duration-150 hover:bg-line/5 disabled:opacity-40 disabled:hover:bg-transparent"
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
            className="w-full px-3 py-1.5 text-left transition-colors duration-150 hover:bg-line/5"
            onClick={() => {
              clipboardRef.current?.paste();
              setCtxMenu(null);
            }}
          >
            粘贴
          </button>
          <div className="my-1 border-t border-line/10" />
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors duration-150 hover:bg-line/5"
            onClick={() => {
              terminalRef.current?.clear();
              setCtxMenu(null);
            }}
          >
            清屏
          </button>
        </div>
      )}

      {authModalOpen && (
        <ConnectAuthModal tab={tab} onClose={() => setAuthModalOpen(false)} />
      )}
    </div>
  );
};
