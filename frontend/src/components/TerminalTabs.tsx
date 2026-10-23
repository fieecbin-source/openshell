import React, { useEffect } from "react";
import { useTerminalStore } from "../stores/terminalStore";

interface TerminalTabsProps {
  onNewTabClick?: () => void;
  onHomeClick?: () => void;
}

export const TerminalTabs: React.FC<TerminalTabsProps> = ({ onNewTabClick, onHomeClick }) => {
  const { tabs, activeTabId, setActiveTab, closeTab, switchMode, toggleMode } = useTerminalStore();

  const isHomeActive = activeTabId === null || activeTabId === "home" || tabs.length === 0;
  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  // 监听全局快捷键 Ctrl+Shift+Tab / Cmd+Shift+Tab 切换命令/视图模式
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        if (activeTabId && activeTabId !== "home") {
          toggleMode(activeTabId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, toggleMode]);

  return (
    <div className="flex h-10 items-center justify-between border-b border-slate-200/80 bg-[#f5f5f7] px-2 overflow-x-auto select-none shrink-0">
      {/* 标签列表 (Apple Card Tabs) */}
      <div className="flex items-center space-x-1 overflow-x-auto">
        {/* 常驻固定的 🏠 主页 标签 */}
        <div
          onClick={() => {
            if (onHomeClick) onHomeClick();
            setActiveTab("home");
          }}
          className={`group flex items-center space-x-1.5 rounded-t-xl px-3 py-2 text-xs font-medium cursor-pointer transition ${
            isHomeActive
              ? "bg-white text-slate-900 font-semibold shadow-apple-sm border-t border-x border-slate-200/80"
              : "bg-transparent text-slate-500 hover:bg-slate-200/50 hover:text-slate-800"
          }`}
          title="返回主页与机器管理大盘"
        >
          <span>🏠</span>
          <span>主页</span>
        </div>

        {/* 各会话标签 */}
        {tabs.map((tab) => {
          const isActive = tab.tabId === activeTabId && !isHomeActive;
          const isSerial = tab.protocol === "serial";

          let statusDot = (
            <span className="h-2 w-2 rounded-full bg-apple-green shadow-apple-sm" />
          );
          if (tab.status === "connecting") {
            statusDot = (
              <span className="h-2 w-2 rounded-full bg-apple-orange animate-pulse" />
            );
          } else if (tab.status === "error" || tab.status === "disconnected") {
            statusDot = (
              <span className="h-2 w-2 rounded-full bg-apple-red" />
            );
          }

          return (
            <div
              key={tab.tabId}
              onClick={() => setActiveTab(tab.tabId)}
              className={`group flex items-center space-x-2 rounded-t-xl px-3 py-2 text-xs font-medium cursor-pointer transition ${
                isActive
                  ? "bg-white text-slate-900 font-semibold shadow-apple-sm border-t border-x border-slate-200/80"
                  : "bg-transparent text-slate-500 hover:bg-slate-200/50 hover:text-slate-800"
              }`}
            >
              {statusDot}
              <span className="max-w-[130px] truncate">{tab.sessionName}</span>

              {/* 串口专属标签徽章 */}
              {isSerial && (
                <span className="rounded bg-purple-50 text-apple-purple border border-purple-200 px-1 py-0.2 text-[9px] font-mono font-bold uppercase">
                  COM
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.tabId);
                }}
                className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition opacity-60 group-hover:opacity-100"
                title="关闭标签"
              >
                ✕
              </button>
            </div>
          );
        })}

        {onNewTabClick && (
          <button
            onClick={onNewTabClick}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 transition ml-1"
            title="新建连接"
          >
            +
          </button>
        )}
      </div>

      {/* 视图卡顶栏模式切换器（仅在激活服务器会话 Tab 时呈现） */}
      {activeTab && !isHomeActive && (
        <div className="flex items-center gap-2 pl-2 shrink-0">
          {activeTab.protocol === "serial" ? (
            <span
              className="text-[11px] text-slate-500 bg-white px-2.5 py-0.5 rounded-lg border border-slate-200 font-mono shadow-apple-sm"
              title="串口通信会话仅启用命令模式"
            >
              串口专有卡 (仅命令模式)
            </span>
          ) : (
            <div className="flex items-center bg-slate-200/70 p-0.5 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => switchMode(activeTab.tabId, "command")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition font-medium ${
                  activeTab.currentMode === "command"
                    ? "bg-white text-apple-blue font-semibold shadow-apple-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                title="终端命令行模式 (快捷键: Ctrl+Shift+Tab)"
              >
                <span className="font-mono text-xs">&gt;_</span>
                <span>终端命令行</span>
              </button>
              <button
                type="button"
                onClick={() => switchMode(activeTab.tabId, "view")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition font-medium ${
                  activeTab.currentMode === "view"
                    ? "bg-white text-apple-blue font-semibold shadow-apple-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                title="SFTP 文件管理器 (快捷键: Ctrl+Shift+Tab)"
              >
                <span>📁</span>
                <span>SFTP 视图</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
