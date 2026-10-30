import React from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { Badge } from "./ui/Surface";
import { IconButton } from "./ui/Button";
import { cn } from "./ui/cn";
import {
  HomeIcon,
  PlusIcon,
  XIcon,
} from "./ui/icons";

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

  const tabClass = (active: boolean) =>
    cn(
      "group flex h-[26px] shrink-0 items-center gap-1.5 rounded-os-md px-2 text-os-xs transition-colors duration-os ease-os",
      active
        ? "border border-line/10 bg-surface text-ink shadow-os-sm"
        : "border border-transparent text-ink-secondary hover:bg-line/5 hover:text-ink",
    );

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line/10 bg-surface-muted px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          type="button"
          onClick={() => {
            if (onHomeClick) onHomeClick();
            setActiveTab("home");
          }}
          className={tabClass(isHomeActive)}
          title="返回主机总览"
        >
          <HomeIcon className="h-3.5 w-3.5" />
          <span>主页</span>
        </button>

        <span className="mx-0.5 h-4 w-px shrink-0 bg-line/10" />

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
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => setActiveTab(tab.tabId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveTab(tab.tabId);
                }
              }}
              className={cn(tabClass(isActive), "cursor-pointer")}
              title={tab.sessionName}
            >
              <span title={statusHint}>{statusDot}</span>
              <span className="max-w-[130px] truncate">{tab.sessionName}</span>

              {isSerial && (
                <Badge tone="accent" className="px-1 font-mono text-[9px]">
                  COM
                </Badge>
              )}

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.tabId);
                }}
                className="ml-0.5 rounded-[4px] p-0.5 text-ink-tertiary opacity-0 transition-[opacity,background-color] duration-os hover:bg-line/10 hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
                title="关闭标签"
                aria-label={`关闭 ${tab.sessionName}`}
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {onNewTabClick && (
          <IconButton
            label="新建连接"
            size="sm"
            className="ml-0.5 h-[22px] w-[22px] shrink-0"
            onClick={onNewTabClick}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </IconButton>
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
