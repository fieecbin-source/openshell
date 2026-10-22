import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import type { TerminalTab } from "../stores/terminalStore";
import { THEMES, useSettingsStore } from "../stores/settingsStore";
import { TerminalSearch } from "./TerminalSearch";
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

export const XtermView: React.FC<XtermViewProps> = ({ tab }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isOpenedRef = useRef<boolean>(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const { theme, fontSize, fontFamily, cursorBlink, logSessionOutput } = useSettingsStore();

  // 1. 初始化终端实例与 Addons
  useEffect(() => {
    if (!containerRef.current) return;

    const currentTheme = THEMES[theme] || THEMES.dark;

    const term = new Terminal({
      cursorBlink,
      cursorStyle: "bar",
      fontSize,
      fontFamily,
      theme: currentTheme,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    // 尝试启用 WebGL 加速，失败优雅降级
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
    } catch {
      // 降级使用 Canvas 渲染器
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

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

    // 快捷键 Ctrl+F / Cmd+F 唤起终端内搜索
    const onKeyDispose = term.onKey((e) => {
      const ev = e.domEvent;
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "f" || ev.key === "F")) {
        ev.preventDefault();
        setSearchOpen((prev) => !prev);
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
      onKeyDispose.dispose();
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [tab.tabId, tab.protocol, tab.cardId]);

  // 2. 动态响应主题、字体设置更改
  useEffect(() => {
    if (!terminalRef.current) return;
    const term = terminalRef.current;
    const currentTheme = THEMES[theme] || THEMES.dark;
    term.options.theme = currentTheme;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorBlink = cursorBlink;
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [theme, fontSize, fontFamily, cursorBlink]);

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

    // SSH 连接通道
    if (!tab.connectionId || isOpenedRef.current) {
      return;
    }

    isOpenedRef.current = true;

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
      term.write(`\r\n\x1b[31m[OpenShell] 打开终端通道失败: ${err?.message || err}\x1b[0m\r\n`);
    });
  }, [tab.connectionId, tab.status, tab.tabId, tab.protocol, tab.cardId, logSessionOutput]);

  return (
    <div className="relative h-full w-full bg-surface-950 overflow-hidden">
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
          <p className="text-xs max-w-md text-red-300 mb-4">{tab.error || "未知网络错误"}</p>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};

declare global {
  interface Window {
    __openshell_session_log?: string;
  }
}
