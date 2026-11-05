import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTerminalStore } from "../stores/terminalStore";
import {
  ChevronDownIcon,
  CommandIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  SendIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from "./ui/icons";
import { cn } from "./ui/cn";

export interface CommandInputBarProps {
  activeTabId: string | null;
  /** 快捷命令栏（SnippetBar）当前是否展开 */
  snippetsOpen: boolean;
  onToggleSnippets: () => void;
}

const TERMINAL_PROTOCOLS = ["ssh", "sftp", "local_shell", "telnet", "serial"];

/**
 * 仿 FinalShell 底部命令输入与历史栏。
 *
 * 对应 FinalShell 的 `command_input` + `cmd_history` 配置：
 * 单行输入、可切换「当前会话 / 全部会话」、发送后清空、自动回车，
 * 支持 ↑/↓ 浏览与弹出层历史命令，并可在右侧切换快捷命令栏与 SFTP 面板。
 */
export const CommandInputBar: React.FC<CommandInputBarProps> = ({
  activeTabId,
  snippetsOpen,
  onToggleSnippets,
}) => {
  const commandHistory = useTerminalStore((s) => s.commandHistory);
  const addCommandHistory = useTerminalStore((s) => s.addCommandHistory);
  const clearCommandHistory = useTerminalStore((s) => s.clearCommandHistory);
  const sendCommandToTabs = useTerminalStore((s) => s.sendCommandToTabs);
  const layoutMode = useTerminalStore((s) => s.layoutMode);
  const setLayoutMode = useTerminalStore((s) => s.setLayoutMode);

  const activeTab = useTerminalStore(
    (s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null
  );
  const connectedCount = useTerminalStore(
    (s) =>
      s.tabs.filter((tab) => tab.status === "connected" && TERMINAL_PROTOCOLS.includes(tab.protocol))
        .length
  );

  const [broadcast, setBroadcast] = useState(false);
  const [cleanAfterSend, setCleanAfterSend] = useState(true);
  const [appendCr, setAppendCr] = useState(true);
  const [value, setValue] = useState("");

  // 历史浏览：null 表示未在浏览，draft 保存进入历史前的草稿
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef("");

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPos, setHistoryPos] = useState<{ left: number; bottom: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);

  const hasTarget = !!activeTabId && connectedCount > 0;
  const sftpAvailable = activeTab?.protocol === "ssh" || activeTab?.protocol === "sftp";
  const sftpVisible = layoutMode !== "terminal";

  const send = useCallback(async () => {
    const command = value;
    if (!command.trim()) {
      inputRef.current?.focus();
      return;
    }
    await sendCommandToTabs(command, { allTabs: broadcast, appendCr });
    addCommandHistory(command);
    if (cleanAfterSend) setValue("");
    setHistoryIndex(null);
    draftRef.current = "";
    inputRef.current?.focus();
  }, [addCommandHistory, appendCr, broadcast, cleanAfterSend, sendCommandToTabs, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === "Escape") {
      setHistoryOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (commandHistory.length === 0) return;

    event.preventDefault();
    if (event.key === "ArrowUp") {
      if (historyIndex === null) {
        draftRef.current = value;
        setHistoryIndex(0);
        setValue(commandHistory[0]);
      } else {
        const next = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(next);
        setValue(commandHistory[next]);
      }
      return;
    }
    // ArrowDown：往回走到最新一条之后恢复草稿
    if (historyIndex === null) return;
    if (historyIndex === 0) {
      setHistoryIndex(null);
      setValue(draftRef.current);
    } else {
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setValue(commandHistory[next]);
    }
  };

  const openHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    const rect = historyBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setHistoryPos({
        left: Math.max(8, rect.right - 320),
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
      });
    }
    setHistoryOpen(true);
  };

  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-cmd-history-popover]")) return;
      if (target?.closest("[data-cmd-history-trigger]")) return;
      setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

  const checkItem = (checked: boolean, label: string, onChange: (next: boolean) => void) => (
    <label
      className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] text-ink-secondary hover:text-ink"
      title={label}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-accent"
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="relative flex h-[34px] shrink-0 items-center gap-1.5 border-t border-line/10 bg-surface-muted px-2 text-xs">
      {/* 发送目标：当前会话 / 全部已连接会话 */}
      <button
        type="button"
        onClick={() => setBroadcast((prev) => !prev)}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition",
          broadcast
            ? "border-state-warning/40 bg-state-warning/15 text-state-warning"
            : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
        )}
        title={broadcast ? "当前为广播模式：命令将发送到全部已连接会话，点击切回当前会话" : "点击切换为全部会话（广播）"}
      >
        {broadcast ? <GlobeIcon className="h-3.5 w-3.5" /> : <TerminalIcon className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">
          {broadcast ? `全部会话 (${connectedCount})` : "当前会话"}
        </span>
      </button>

      {/* 命令输入框 */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value);
          setHistoryIndex(null);
        }}
        onKeyDown={handleKeyDown}
        placeholder={
          hasTarget
            ? "输入命令发送到当前会话（Enter 发送，↑/↓ 浏览历史）..."
            : "当前没有可用的已连接终端会话"
        }
        disabled={!hasTarget}
        className="min-w-0 flex-1 rounded-lg border border-line/15 bg-surface px-2.5 py-1 font-mono text-[11px] text-ink placeholder-ink-tertiary transition focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/20 disabled:opacity-60"
      />

      {/* 发送 */}
      <button
        type="button"
        onClick={() => void send()}
        disabled={!hasTarget || !value.trim()}
        className="flex shrink-0 items-center gap-1 rounded-lg bg-action px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-action/90 disabled:opacity-40"
        title={appendCr ? "发送并在末尾追加回车" : "仅发送命令文本"}
      >
        <SendIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">发送</span>
      </button>

      {checkItem(cleanAfterSend, "清空", setCleanAfterSend)}
      {checkItem(appendCr, "回车", setAppendCr)}

      {/* 历史命令 */}
      <button
        ref={historyBtnRef}
        type="button"
        data-cmd-history-trigger
        onClick={openHistory}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition",
          historyOpen
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
        )}
        title="历史命令（可一键重发）"
      >
        <HistoryIcon className="h-3.5 w-3.5" />
        <span className="hidden md:inline">历史</span>
        <ChevronDownIcon className="h-3 w-3" />
      </button>

      {/* 快捷命令栏开关 */}
      <button
        type="button"
        onClick={onToggleSnippets}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition",
          snippetsOpen
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
        )}
        title={snippetsOpen ? "收起快捷命令栏" : "展开快捷命令栏"}
        aria-pressed={snippetsOpen}
      >
        <CommandIcon className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">快捷命令</span>
      </button>

      {/* SFTP 面板显隐（仅 SSH 会话） */}
      {sftpAvailable && (
        <button
          type="button"
          onClick={() => setLayoutMode(sftpVisible ? "terminal" : "split")}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition",
            sftpVisible
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
          )}
          title={sftpVisible ? "隐藏底部 SFTP 面板" : "显示底部 SFTP 面板"}
          aria-pressed={sftpVisible}
        >
          <FolderIcon className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">SFTP</span>
        </button>
      )}

      {/* 历史命令浮层 */}
      {historyOpen &&
        createPortal(
          <div
            data-cmd-history-popover
            role="dialog"
            aria-label="历史命令"
            className="fixed z-[120] w-80 overflow-hidden rounded-xl border border-line/15 bg-surface text-xs text-ink shadow-os-lg"
            style={{ left: historyPos?.left ?? 8, bottom: historyPos?.bottom ?? 48 }}
          >
            <div className="flex items-center justify-between border-b border-line/10 px-3 py-2">
              <span className="text-[11px] font-semibold text-ink-secondary">
                历史命令 ({commandHistory.length}/{50})
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={clearCommandHistory}
                  disabled={commandHistory.length === 0}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-ink-tertiary transition hover:bg-state-danger/10 hover:text-state-danger disabled:opacity-40"
                  title="清空历史命令"
                >
                  <TrashIcon className="h-3 w-3" />
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(false)}
                  className="rounded-md p-1 text-ink-tertiary transition hover:bg-line/10 hover:text-ink"
                  title="关闭"
                  aria-label="关闭历史命令"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto py-1">
              {commandHistory.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-ink-tertiary">
                  暂无历史命令，发送一次命令后会自动记录
                </p>
              ) : (
                commandHistory.map((item, index) => (
                  <div
                    key={`${index}-${item}`}
                    className="group flex items-center gap-1 px-2 py-1 hover:bg-line/5"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setValue(item);
                        setHistoryIndex(index);
                        setHistoryOpen(false);
                        inputRef.current?.focus();
                      }}
                      className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-secondary group-hover:text-ink"
                      title={item}
                    >
                      {item}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void sendCommandToTabs(item, { allTabs: broadcast, appendCr: true });
                        addCommandHistory(item);
                        setHistoryOpen(false);
                      }}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-accent opacity-0 transition hover:bg-accent/10 group-hover:opacity-100"
                      title="立即发送该命令"
                    >
                      发送
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
