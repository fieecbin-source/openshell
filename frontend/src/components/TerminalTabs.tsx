import React, { useEffect } from "react";
import { useTerminalStore } from "../stores/terminalStore";

interface TerminalTabsProps {
  onNewTabClick?: () => void;
}

export const TerminalTabs: React.FC<TerminalTabsProps> = ({ onNewTabClick }) => {
  const { tabs, activeTabId, setActiveTab, closeTab, switchMode, toggleMode } = useTerminalStore();

  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  // 监听全局快捷键 Ctrl+Shift+Tab / Cmd+Shift+Tab 切换命令/视图模式
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        if (activeTabId) {
          toggleMode(activeTabId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, toggleMode]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-10 items-center justify-between border-b border-slate-800 bg-surface-950 px-3 text-xs text-slate-500">
        <span>无打开的会话卡片 (双击左侧会话立即连接)</span>
        {onNewTabClick && (
          <button
            onClick={onNewTabClick}
            className="flex items-center space-x-1 rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white transition"
          >
            <span>+ 新建连接</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-10 items-center justify-between border-b border-slate-800 bg-surface-950 px-2 overflow-x-auto select-none">
      {/* 标签列表 */}
      <div className="flex items-center space-x-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.tabId === activeTabId;
          const isSerial = tab.protocol === "serial";

          let statusDot = (
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
          );
          if (tab.status === "connecting") {
            statusDot = (
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            );
          } else if (tab.status === "error" || tab.status === "disconnected") {
            statusDot = (
              <span className="h-2 w-2 rounded-full bg-red-400" />
            );
          }

          return (
            <div
              key={tab.tabId}
              onClick={() => setActiveTab(tab.tabId)}
              className={`group flex items-center space-x-2 rounded-t-lg px-3 py-1.5 text-xs font-medium cursor-pointer transition border-b-2 ${
                isActive
                  ? "bg-surface-900 text-white border-indigo-500 shadow-sm"
                  : "bg-surface-950/60 text-slate-400 border-transparent hover:bg-surface-900/60 hover:text-slate-200"
              }`}
            >
              {statusDot}
              <span className="max-w-[130px] truncate">{tab.sessionName}</span>

              {/* 串口专属标签徽章 */}
              {isSerial && (
                <span className="rounded bg-indigo-950/90 text-indigo-400 border border-indigo-700/60 px-1 py-0.2 text-[9px] font-mono font-bold uppercase">
                  COM
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.tabId);
                }}
                className="rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-white transition opacity-60 group-hover:opacity-100"
                title="关闭卡片"
              >
                ✕
              </button>
            </div>
          );
        })}

        {onNewTabClick && (
          <button
            onClick={onNewTabClick}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-white transition ml-1"
            title="新建会话"
          >
            +
          </button>
        )}
      </div>

      {/* 视图卡顶栏模式切换器（Segmented Switcher） */}
      {activeTab && (
        <div className="flex items-center gap-2 pl-2 shrink-0">
          {activeTab.protocol === "serial" ? (
            <span
              className="text-[11px] text-slate-500 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800 font-mono"
              title="串口通信会话仅启用命令模式"
            >
              串口专有卡 (仅命令模式)
            </span>
          ) : (
            <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => switchMode(activeTab.tabId, "command")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition font-medium ${
                  activeTab.currentMode === "command"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title="终端命令行模式 (快捷键: Ctrl+Shift+Tab)"
              >
                <span className="font-mono text-xs">&gt;_</span>
                <span>命令</span>
              </button>
              <button
                type="button"
                onClick={() => switchMode(activeTab.tabId, "view")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition font-medium ${
                  activeTab.currentMode === "view"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                title="SFTP 文件资源管理器视图模式 (快捷键: Ctrl+Shift+Tab)"
              >
                <span>📁</span>
                <span>视图</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
