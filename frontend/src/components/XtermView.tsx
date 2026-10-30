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
import { MaximizeIcon, MinimizeIcon, SearchIcon } from "./ui/icons";
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 由终端初始化时注册的复制/粘贴动作，供右键菜单调用
  const clipboardRef = useRef<{ copy: () => void; paste: () => void } | null>(null);
  const isFullscreen = useTerminalStore((s) => s.isFullscreen);
  const toggleFullscreen = useTerminalStore((s) => s.toggleFullscreen);

  // 记录最近一次打印的连接状态，避免重复输出
  const lastLoggedStateRef = useRef<string>("");

  // 逐字段订阅，避免设置面板开关（settingsModalOpen）等无关变化让所有终端重渲染
  const theme = useSettingsStore((s) => s.theme);
  const customThemes = useSettingsStore((s) => s.customThemes);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontWeight = useSettingsStore((s) => s.fontWeight);
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

  // 根据壁纸控制背景：
  // 1. 有壁纸的情况下不能显示纯色，必须切换为壁纸；
  // 2. 取消壁纸恢复默认才改为主题底色。
  const hasWallpaper = !!wallpaper;

  // 初始化用的最新配置快照：init effect 只依赖标签身份，其余配置在下面单独应用
  const initOptionsRef = useRef({
    cursorBlink,
    cursorStyle,
    fontSize,
    fontFamily,
    fontWeight,
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
    fontWeight,
    scrollback,
    renderer,
    theme: currentTheme,
    hasWallpaper,
  };

  // 1. 初始化终端实例与 Addons
  useEffect(() => {
    if (!containerRef.current) return;
    const opts = initOptionsRef.current;

    // 允许透明背景：必须初始即为 true，以便动态切换壁纸/纯色背景时 xterm 画布能够即时透出背景
    const useWebgl = opts.renderer === "webgl" && !opts.hasWallpaper;

    const term = new Terminal({
      cursorBlink: opts.cursorBlink,
      cursorStyle: opts.cursorStyle,
      fontSize: opts.fontSize,
      fontFamily: opts.fontFamily,
      fontWeight: opts.fontWeight,
      fontWeightBold: 700,
      lineHeight: 1.3,
      letterSpacing: 0,
      minimumContrastRatio: 7,
      allowTransparency: true,
      scrollback: opts.scrollback,
      // unicode11 与部分宽度计算 API 需要开启 proposed API
      allowProposedApi: true,
      theme: opts.hasWallpaper
        ? { ...opts.theme, background: `${opts.theme.background.slice(0, 7)}00` }
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
      // Ctrl/Cmd 0 重置字号为 14
      if (mod && key === "0") {
        ev.preventDefault();
        void useSettingsStore.getState().setFontSize(14);
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

  // 2. 动态响应主题、字体、壁纸、透明度与滚动缓冲等设置更改
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    // 根据壁纸控制：有壁纸时必须切换为壁纸（画布设为透明），取消壁纸恢复默认才改为纯色
    // Keep the light background RGB at zero alpha. The keyword "transparent"
    // is transparent black, which makes xterm's contrast correction lighten black text.
    const termBg = hasWallpaper ? `${currentTheme.background.slice(0, 7)}00` : currentTheme.background;

    term.options.theme = { ...currentTheme, background: termBg };
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.fontWeight = fontWeight;
    term.options.minimumContrastRatio = 7;
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
    tab.status,
    theme,
    fontSize,
    fontFamily,
    fontWeight,
    cursorBlink,
    cursorStyle,
    scrollback,
    wallpaper,
    backgroundOpacity,
    hasWallpaper,
    currentTheme,
  ]);

  // 连接过程状态与报错直接在终端内打印，不弹窗，不遮挡
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    const key = `${tab.status}|${tab.reconnectAttempt}|${tab.error ?? ""}`;
    if (lastLoggedStateRef.current === key) return;
    lastLoggedStateRef.current = key;

    if (tab.status === "connecting") {
      term.writeln(`\r\n\x1b[38;5;75m➜ [连接中]\x1b[0m 正在建立安全连接: \x1b[1m${tab.sessionName}\x1b[0m...`);
    } else if (tab.status === "reconnecting") {
      term.writeln(
        `\x1b[38;5;214m⟳ [自动重连]\x1b[0m 连接已断开或失败，正在自动重新连接（第 ${tab.reconnectAttempt} 次），重试直至连接成功...`
      );
    } else if (tab.status === "connected") {
      term.writeln(`\x1b[38;5;82m✔ [已就绪]\x1b[0m 会话连接成功，终端已就绪！\r\n`);
    } else if (tab.status === "error" || tab.status === "disconnected") {
      if (tab.error) {
        term.writeln(`\x1b[38;5;196m✖ [连接失败]\x1b[0m ${tab.error}`);
        term.writeln(`\x1b[38;5;220m⚡ [自动重试]\x1b[0m 连接失败自动重试，直到连接成功...\r\n`);
      }
    }
  }, [tab.status, tab.reconnectAttempt, tab.error, tab.sessionName]);

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
    <div
      className="relative h-full w-full overflow-hidden transition-colors duration-300"
      style={{
        backgroundColor: currentTheme.background,
      }}
    >
      {/* 以终端主题作为壁纸底色，限制图像强度以维持文字对比度。 */}
      {hasWallpaper && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-300"
          style={{
            backgroundImage: wallpaper.backgroundImage,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
            transform: backgroundBlur > 0 ? "scale(1.05)" : undefined,
            opacity: Math.max(0, Math.min(1, backgroundOpacity / 100)),
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

      {/* 终端浮动快捷工具栏 (全屏放大与快捷搜索) */}
      <div className="absolute right-2.5 top-2.5 z-20 flex items-center gap-1.5">
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? "退出终端全屏 (Esc / F11)" : "全屏放大终端 (F11)"}
          aria-label={isFullscreen ? "退出终端全屏" : "全屏放大终端"}
          className="rounded-lg border border-line/15 bg-surface/80 p-1.5 text-ink-secondary shadow-os-sm backdrop-blur-md transition-all hover:bg-surface hover:text-ink active:scale-95"
        >
          {isFullscreen ? (
            <MinimizeIcon className="h-3.5 w-3.5" />
          ) : (
            <MaximizeIcon className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          onClick={() => setSearchOpen((prev) => !prev)}
          title="在终端中搜索 (Ctrl+F)"
          aria-label="在终端中搜索"
          className="rounded-lg border border-line/15 bg-surface/80 p-1.5 text-ink-secondary shadow-os-sm backdrop-blur-md transition-all hover:bg-surface hover:text-ink active:scale-95"
        >
          <SearchIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="relative z-10 h-full w-full" />
    </div>
  );
};
