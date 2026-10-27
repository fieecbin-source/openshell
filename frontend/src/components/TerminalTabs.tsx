import React from "react";
import { useTerminalStore } from "../stores/terminalStore";

interface TerminalTabsProps {
  onNewTabClick?: () => void;
  onHomeClick?: () => void;
}

export const TerminalTabs: React.FC<TerminalTabsProps> = ({ onNewTabClick, onHomeClick }) => {
  const { tabs, activeTabId, setActiveTab, closeTab } = useTerminalStore();

  const isHomeActive = activeTabId === null || activeTabId === "home" || tabs.length === 0;
  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  // 注意：这里不再注册任何视图切换快捷键。
  // Ctrl+Shift+Tab 在 AppLayout 里用于切换整体布局（终端 / 分屏 / SFTP），
  // 标签栏也不再提供第二套模式切换按钮，避免同一份状态出现两个入口。

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

          // 状态指示：已连接(绿) / 连接中(橙) / 自动重连中(琥珀闪烁) / 断开或失败(红)
          const statusHint =
            tab.status === "connected"
              ? "已连接"
              : tab.status === "connecting"
                ? "正在连接"
                : tab.status === "reconnecting"
                  ? `已断开，正在自动重连（第 ${tab.reconnectAttempt} 次）`
                  : tab.error
                    ? `已断开：${tab.error}`
                    : "已断开";

          let statusDot = (
            <span className="h-2 w-2 shrink-0 rounded-full bg-apple-green shadow-apple-sm" />
          );
          if (tab.status === "connecting") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-apple-orange animate-pulse" />
            );
          } else if (tab.status === "reconnecting") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse" />
            );
          } else if (tab.status === "error" || tab.status === "disconnected") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-apple-red" />
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
              <span title={statusHint}>{statusDot}</span>
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

      {/*
        这里原本还有一组「终端命令行 / SFTP 视图」模式切换器，与顶栏的
        【终端 / 分屏 / SFTP】三分段布局切换重复，而且它只改 currentMode 却
        不切换实际视图，是「点了没反应 + 两套状态互相打架」的根因。
        现已统一收敛到顶栏的唯一布局切换器（terminalStore.layoutMode）。
      */}
      {activeTab && !isHomeActive && activeTab.protocol === "serial" && (
        <span
          className="shrink-0 text-[11px] text-slate-500 bg-white px-2.5 py-0.5 rounded-lg border border-slate-200 font-mono shadow-apple-sm"
          title="串口通信会话仅提供终端视图"
        >
          串口会话
        </span>
      )}
    </div>
  );
};
