import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TerminalTab } from "../stores/terminalStore";
import { useTerminalStore } from "../stores/terminalStore";
import { isLightBackground, resolveTheme, useSettingsStore } from "../stores/settingsStore";
import {
  cacheScenicWallpaper,
  getCachedScenicWallpaper,
  getWallpaperStyle,
  SCENIC_WALLPAPERS,
} from "../lib/wallpapers";
import { formatFriendlyError } from "../lib/errors";
import { appendSessionLog, dropSessionLog } from "../lib/terminal-log";
import { TerminalSearch } from "./TerminalSearch";
import { MaximizeIcon, MinimizeIcon, SearchIcon, CopyIcon, DownloadIcon, CommandIcon, TrashIcon, ChevronDownIcon, PlayIcon, RowsIcon, StopIcon, RefreshIcon, SaveIcon, SlidersIcon, PlusIcon } from "./ui/icons";
import { ConfirmDialog } from "./ui/Overlay";
import { ConnectAuthModal } from "./ConnectAuthModal";
import { toast, useToastStore } from "../stores/toastStore";
import {
  SAVE_SNIPPET_EVENT,
  createStreamingDecoder,
} from "../lib/terminal-actions";
import { subscribeSerial } from "../stores/serialStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  ackTerminal,
  openTerminal,
  openLocalShell,
  openTelnet,
  resizeTerminal,
  writeTerminal,
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  // 由终端初始化时注册的复制/粘贴动作，供右键菜单调用
  const clipboardRef = useRef<{ copy: () => void; paste: () => void } | null>(null);
  const isFullscreen = useTerminalStore((s) => s.isFullscreen);
  const toggleFullscreen = useTerminalStore((s) => s.toggleFullscreen);
  // 会话编码：临时本地终端没有落库会话，按 UTF-8 处理
  const encoding = useSessionStore((s) =>
    s.sessions.find((item) => item.id === tab.sessionId)?.encoding
  );

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
  const [cachedScenicWallpaper, setCachedScenicWallpaper] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    if (!SCENIC_WALLPAPERS.some((item) => item.id === backgroundId)) return;
    let active = true;
    void getCachedScenicWallpaper(backgroundId).then((cachedUrl) => {
      if (!active) return;
      if (cachedUrl) setCachedScenicWallpaper({ id: backgroundId, url: cachedUrl });
      else cacheScenicWallpaper(backgroundId);
    });
    return () => { active = false; };
  }, [backgroundId]);

  const wallpaper = useMemo(
    () => {
      const style = getWallpaperStyle(backgroundId, backgroundCustom);
      if (style && cachedScenicWallpaper?.id === backgroundId) {
        return { ...style, backgroundImage: `url("${cachedScenicWallpaper.url}")` };
      }
      return style;
    },
    [backgroundId, backgroundCustom, cachedScenicWallpaper]
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
      lineHeight: 1.4,
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
    const copySelection = async () => {
      const selection = term.getSelection();
      if (!selection) return;
      try {
        try {
          await navigator.clipboard.writeText(selection);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = selection;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          try {
            ta.select();
            if (!document.execCommand("copy")) throw new Error("Clipboard denied");
          } finally { ta.remove(); }
        }
        useToastStore.getState().push({ level: "success", title: "已复制到剪贴板", position: "top-center" });
      } catch {
        toast.error("复制失败，请检查剪贴板权限");
      } finally { if (visibleRef.current) term.focus(); }
    };
    const pasteClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!visibleRef.current) return;
        if (/[\r\n]/.test(text)) setPendingPaste(text);
        else if (text) {
          term.paste(text);
          term.focus();
          useToastStore.getState().push({ level: "success", title: "已粘贴到终端", position: "top-center" });
        }
      } catch {
        toast.error("无法读取剪贴板，请检查权限后重试");
      }
    };
    clipboardRef.current = { copy: () => void copySelection(), paste: () => void pasteClipboard() };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || ev.isComposing) return true;
      const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
      if (ev.key === "Enter" && live && (live.status === "disconnected" || live.status === "error")) {
        ev.preventDefault();
        if (!ev.repeat && visibleRef.current) void useTerminalStore.getState().reconnectTab(tab.tabId);
        return false;
      }
      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      if (mod && !ev.shiftKey && key === "f") {
        ev.preventDefault();
        // 长按会连续触发 keydown，这里只在非重复事件时切换，避免搜索框反复开关
        if (!ev.repeat) setSearchOpen((prev) => !prev);
        return false;
      }
      if (mod && ev.shiftKey && key === "c") {
        ev.preventDefault();
        void copySelection();
        return false;
      }
      // Ctrl+C 仅在存在选区时复制，否则保留中断当前命令的语义
      if (mod && !ev.shiftKey && key === "c" && term.hasSelection()) {
        ev.preventDefault();
        void copySelection();
        return false;
      }
      if (mod && key === "v") {
        ev.preventDefault();
        void pasteClipboard();
        return false;
      }
      if (ev.shiftKey && ev.key === "Insert") {
        ev.preventDefault();
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

    // 键盘输入监听：统一走 store 的发送入口，编码 await 之后由 store 复核连接代次，
    // 关闭/重连期间的旧按键不会写进新连接。
    const onDataDispose = term.onData((data) => {
      const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
      if (live?.status !== "connected") return;
      void (async () => {
        try {
          await useTerminalStore.getState().sendTextToTab(tab.tabId, data);
        } catch (err) {
          // 目标连接已变化时的主动取消（store 的 StaleTargetError）不能把新连接标记成断开
          if (err instanceof Error && err.name === "StaleTargetError") return;
          // 编码失败或写入失败都必须进入断开状态，不能只停留在 console.warn
          const current = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
          if (current?.status === "connected") {
            useTerminalStore.getState().markDisconnected(tab.tabId, formatFriendlyError(err));
          }
        }
      })();
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

  useLayoutEffect(() => {
    if (!ctxMenu || !menuRef.current) return;
    const bounds = menuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(ctxMenu.x, window.innerWidth - bounds.width - 8));
    const y = Math.max(8, Math.min(ctxMenu.y, window.innerHeight - bounds.height - 8));
    if (x !== ctxMenu.x || y !== ctxMenu.y) setCtxMenu({ x, y });
    menuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [ctxMenu]);

  useEffect(() => {
    if (!visible) { setCtxMenu(null); setPendingPaste(null); setAuthOpen(false); }
  }, [visible]);

  const exportContent = () => {
    const term = terminalRef.current;
    if (!term) return;
    const lines = [];
    for (let index = 0; index < term.buffer.active.length; index++) {
      lines.push(term.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${tab.sessionName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}-terminal.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

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

    const key = `${tab.status}|${tab.error ?? ""}`;
    if (lastLoggedStateRef.current === key) return;
    lastLoggedStateRef.current = key;

    if (tab.status === "connecting") {
      term.writeln(`\r\n\x1b[38;5;75m➜ [连接中]\x1b[0m 正在建立安全连接: \x1b[1m${tab.sessionName}\x1b[0m...`);
    } else if (tab.status === "reconnecting") {
      term.writeln("\x1b[38;5;75m[连接中]\x1b[0m 正在重新建立连接，请稍候…");
    } else if (tab.status === "connected") {
      term.writeln(`\x1b[38;5;82m✔ [已就绪]\x1b[0m 认证成功，终端连接已建立！\r\n`);
    } else if (tab.status === "error" || tab.status === "disconnected") {
      if (tab.error) {
        term.writeln(`\x1b[38;5;196m[连接已断开]\x1b[0m ${tab.error}`);
      }
      term.writeln("\r\n\x1b[38;5;75m按 Enter 重新连接。\x1b[0m 可通过右键菜单修改登录凭据。\r\n");
    }
  }, [tab.status, tab.error, tab.sessionName]);

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

    // 串口连接：单轮询分发（ASCII/HEX 共用同一份原始字节），此处只订阅
    if (tab.protocol === "serial") {
      if (!visible) return;
      let decoder: ReturnType<typeof createStreamingDecoder> = null;
      try {
        decoder = createStreamingDecoder(encoding);
      } catch (err) {
        term.write(`\r\n\x1b[31m[OpenShell] ${formatFriendlyError(err)}\x1b[0m\r\n`);
        return;
      }

      const targetCardId = tab.cardId || tab.tabId;
      const unsubscribe = subscribeSerial(targetCardId, {
        onData: (bytes) => {
          if (terminalRef.current !== term) return;
          const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
          if (!live || live.status !== "connected") return;
          const payload = new Uint8Array(bytes);
          if (decoder) term.write(decoder.decode(payload));
          else term.write(payload);
          if (useSettingsStore.getState().logSessionOutput) {
            appendSessionLog(tab.tabId, payload);
          }
        },
        onError: (error) => {
          // 读取失败必须暴露为断开，交给 markDisconnected 处理退避与上限
          const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
          if (live && live.status === "connected") {
            useTerminalStore.getState().markDisconnected(tab.tabId, formatFriendlyError(error));
          }
        },
      });

      return () => {
        decoder?.reset();
        unsubscribe();
      };
    }

    // RDP 标签不使用 xterm 渲染（由 RdpSessionView 接管），无需建立字符流
    if (tab.protocol === "rdp") return;

    // 字符流通道（SSH / 本地终端 / Telnet）：重连后 connectionId 变化时必须重新打开
    if (!tab.connectionId || openedConnectionRef.current === tab.connectionId) {
      return;
    }

    let decoder: ReturnType<typeof createStreamingDecoder> = null;
    try {
      decoder = createStreamingDecoder(encoding);
    } catch (err) {
      term.write(`\r\n\x1b[31m[OpenShell] ${formatFriendlyError(err)}\x1b[0m\r\n`);
      return;
    }

    openedConnectionRef.current = tab.connectionId;
    // 打开通道时就会把当前尺寸带给后端，先记录下来避免立刻再发一次 resize
    lastSizeRef.current = { cols: term.cols, rows: term.rows };

    const onIncomingData = (frameBytes: number[]) => {
      if (terminalRef.current !== term) return;
      const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
      if (live?.connectionId !== tab.connectionId || live.status !== "connected") return;
      if (frameBytes.length < 5) return;

      const tag = frameBytes[0];
      // 二进制帧格式：0x01 为 PTY 数据
      if (tag === 0x01) {
        const payload = new Uint8Array(frameBytes.slice(5));
        const acknowledge = () => {
          // 消费完成后反馈确认（流控信用）
          ackTerminal(tab.tabId, payload.length).catch(() => {});
        };
        if (decoder) term.write(decoder.decode(payload), acknowledge);
        else term.write(payload, acknowledge);

        if (useSettingsStore.getState().logSessionOutput) {
          appendSessionLog(tab.tabId, payload);
        }
      }
    };

    const openStream =
      tab.protocol === "local_shell"
        ? openLocalShell(tab.tabId, term.cols, term.rows, onIncomingData, {
            // 临时终端（quick-local-*）没有落库，不允许把伪 sessionId 传给后端
            sessionId: tab.sessionId.startsWith("quick-local-") ? null : tab.sessionId,
            shellKind: tab.shellKind ?? null,
          })
        : tab.protocol === "telnet"
          ? openTelnet(tab.tabId, tab.sessionId, term.cols, term.rows, onIncomingData)
          : openTerminal(tab.tabId, tab.connectionId, term.cols, term.rows, onIncomingData);

    openStream.catch((err) => {
      // 打开失败时清空标记，下次 effect 触发时还允许重试
      openedConnectionRef.current = null;
      // 组件可能已经卸载，向已 dispose 的终端写入会抛异常
      if (terminalRef.current !== term) return;
      term.write(`\r\n\x1b[31m[OpenShell] 终端连接失败：${formatFriendlyError(err)}\x1b[0m\r\n`);
      const live = useTerminalStore.getState().tabs.find((item) => item.tabId === tab.tabId);
      if (live?.connectionId === tab.connectionId) {
        useTerminalStore.getState().markDisconnected(tab.tabId, formatFriendlyError(err));
      }
    });

    return () => {
      decoder?.reset();
    };
  }, [
    tab.connectionId,
    tab.status,
    tab.tabId,
    tab.protocol,
    tab.cardId,
    tab.sessionId,
    tab.shellKind,
    visible,
    encoding,
  ]);

  const isLight = isLightBackground(currentTheme.background);

  return (
    <div
      className="relative h-full w-full overflow-hidden transition-colors duration-300 border-t border-line/10 shadow-[inset_0_1px_3px_rgba(0,0,0,0.15)]"
      style={{
        backgroundColor: currentTheme.background,
      }}
    >
      {/* 以终端主题作为壁纸底色，限制图像强度以维持文字对比度。 */}
      {hasWallpaper && (
        <>
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
          {/* 对比度保护遮罩：根据明暗自适应半透遮罩，防止壁纸高光影响终端文字识别 */}
          <div
            className="absolute inset-0 pointer-events-none transition-colors duration-300"
            style={{
              backgroundColor: isLight ? "rgba(255, 255, 255, 0.45)" : "rgba(12, 16, 23, 0.60)",
            }}
          />
        </>
      )}

      {/* 搜索工具栏 */}
      {searchOpen && (
        <TerminalSearch
          searchAddon={searchAddonRef.current}
          onClose={() => { setSearchOpen(false); terminalRef.current?.focus(); }}
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

      <div ref={containerRef} className="relative z-10 h-full w-full p-1.5 focus:outline-none" />
      {ctxMenu && visible && createPortal(
        <div ref={menuRef} role="menu" aria-label="终端操作" className="fixed z-[70] max-h-[calc(100vh-16px)] w-60 overflow-y-auto rounded-xl border border-line/10 bg-surface/95 p-1.5 text-os-xs text-ink shadow-os-lg backdrop-blur-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape" || event.key === "Tab") { event.stopPropagation(); setCtxMenu(null); terminalRef.current?.focus(); if (event.key === "Escape") event.preventDefault(); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.stopPropagation(); event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
          }}>
          {[
            { label: "复制选中内容", icon: CopyIcon, shortcut: "Ctrl/Cmd+C", disabled: !terminalRef.current?.hasSelection(), action: () => clipboardRef.current?.copy() },
            { label: "粘贴", icon: PlayIcon, shortcut: "Ctrl/Cmd+V", disabled: tab.status !== "connected", action: () => clipboardRef.current?.paste() },
            { label: "全选", icon: RowsIcon, action: () => terminalRef.current?.selectAll() },
            { label: "搜索终端内容", icon: SearchIcon, shortcut: "Ctrl/Cmd+F", action: () => setSearchOpen(true) },
            { label: "发送 Ctrl+C（SIGINT）", icon: StopIcon, shortcut: "Ctrl+C", disabled: tab.protocol === "serial" || tab.status !== "connected", action: () => { void writeTerminal(tab.tabId, new Uint8Array([3])); } },
            { label: "重新连接", icon: RefreshIcon, disabled: tab.status === "connected" || tab.status === "connecting", action: () => { void useTerminalStore.getState().reconnectTab(tab.tabId); } },
            { label: "在新标签打开同一会话", icon: PlusIcon, disabled: tab.protocol === "serial", action: () => { void useTerminalStore.getState().duplicateTab(tab.tabId); } },
            { label: "重新填写登录凭据", icon: CommandIcon, disabled: tab.protocol === "serial" || tab.status === "connected" || tab.status === "connecting", action: () => setAuthOpen(true) },
            { label: `增大字号（当前 ${fontSize}px）`, icon: SlidersIcon, shortcut: "Ctrl/Cmd +", action: () => { void useSettingsStore.getState().setFontSize(Math.min(32, fontSize + 1)); } },
            { label: "减小字号", icon: SlidersIcon, shortcut: "Ctrl/Cmd -", action: () => { void useSettingsStore.getState().setFontSize(Math.max(9, fontSize - 1)); } },
            { label: logSessionOutput ? "停止记录会话日志" : "开始记录会话日志", icon: SaveIcon, action: () => { void useSettingsStore.getState().setLogSessionOutput(!logSessionOutput); } },
            { label: "选区保存为快捷命令", icon: CommandIcon, disabled: tab.protocol === "serial" || !terminalRef.current?.hasSelection(), action: () => window.dispatchEvent(new CustomEvent(SAVE_SNIPPET_EVENT, { detail: terminalRef.current?.getSelection() })) },
            { label: "滚动到底部", icon: ChevronDownIcon, action: () => terminalRef.current?.scrollToBottom() },
            { label: "清空终端显示", icon: TrashIcon, action: () => terminalRef.current?.clear() },
            { label: "导出终端文本", icon: DownloadIcon, action: exportContent },
            { label: isFullscreen ? "退出终端全屏" : "全屏放大终端", icon: MaximizeIcon, shortcut: "F11", action: toggleFullscreen },
          ].map(({ label, icon: Icon, shortcut, disabled, action }) => <button key={label} role="menuitem" type="button" disabled={disabled}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent/10 focus:bg-accent/10 disabled:opacity-35"
            onClick={() => { setCtxMenu(null); terminalRef.current?.focus(); action(); }}>
            <Icon className="h-3.5 w-3.5 shrink-0 text-ink-secondary" /><span className="flex-1">{label}</span>{shortcut && <kbd className="text-[9px] text-ink-tertiary">{shortcut}</kbd>}
          </button>)}
        </div>, document.body
      )}
      <ConfirmDialog open={pendingPaste !== null} title="粘贴多行内容" confirmText="确认粘贴"
        message={<div className="space-y-3"><p>换行可能直接执行终端命令，请确认内容和目标主机。</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-muted p-3 font-mono text-os-xs">{pendingPaste}</pre></div>}
        onCancel={() => { setPendingPaste(null); terminalRef.current?.focus(); }}
        onConfirm={() => {
          if (pendingPaste && tab.status === "connected") {
            terminalRef.current?.paste(pendingPaste);
            useToastStore.getState().push({ level: "success", title: "已粘贴到终端", position: "top-center" });
          }
          setPendingPaste(null);
          terminalRef.current?.focus();
        }} />
      {authOpen && <ConnectAuthModal tab={tab} onClose={() => { setAuthOpen(false); terminalRef.current?.focus(); }} />}
    </div>
  );
};
