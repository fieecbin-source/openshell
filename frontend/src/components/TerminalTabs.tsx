import React, { useState } from "react";
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
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export const TerminalTabs: React.FC<TerminalTabsProps> = ({
  onNewTabClick,
  onHomeClick,
  isFullscreen,
  onToggleFullscreen,
}) => {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    renameTab,
    duplicateTab,
    layoutMode,
    setLayoutMode,
  } = useTerminalStore();

  const isHomeActive = activeTabId === null || activeTabId === "home" || tabs.length === 0;
  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  // 标签编辑/重命名状态
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  // 拖拽排序状态
  const [draggedTabIndex, setDraggedTabIndex] = useState<number | null>(null);

  const handleStartRename = (tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditingName(currentName);
    setContextMenu(null);
  };

  const handleCommitRename = () => {
    if (editingTabId && editingName.trim()) {
      renameTab(editingTabId, editingName.trim());
    }
    setEditingTabId(null);
  };

  const handleSafeCloseTab = (tabId: string, sessionName: string, isConnected: boolean) => {
    if (isConnected) {
      const confirmClose = window.confirm(`会话 "${sessionName}" 仍在连接中，确认关闭此标签吗？`);
      if (!confirmClose) return;
    }
    closeTab(tabId);
  };

  const tabClass = (active: boolean) =>
    cn(
      "group relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-os-md px-2 text-os-xs transition-colors duration-os ease-os select-none",
      active
        ? "border border-line/10 bg-surface text-ink shadow-os-sm"
        : "border border-transparent text-ink-secondary hover:bg-line/5 hover:text-ink",
    );

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line/10 bg-surface-muted px-2">
      {/* 左侧：主页与标签列表 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
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

        {tabs.map((tab, index) => {
          const isActive = tab.tabId === activeTabId && !isHomeActive;
          const isSerial = tab.protocol === "serial";
          const isConnected = tab.status === "connected";

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
            <span className="h-2 w-2 shrink-0 rounded-full bg-state-success shadow-apple-sm" />
          );
          if (tab.status === "connecting") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-state-warning animate-pulse" />
            );
          } else if (tab.status === "reconnecting") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse" />
            );
          } else if (tab.status === "error" || tab.status === "disconnected") {
            statusDot = (
              <span className="h-2 w-2 shrink-0 rounded-full bg-state-danger" />
            );
          }

          return (
            <div
              key={tab.tabId}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                setDraggedTabIndex(index);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedTabIndex !== null && draggedTabIndex !== index) {
                  useTerminalStore.getState().reorderTabs(draggedTabIndex, index);
                }
                setDraggedTabIndex(null);
              }}
              onClick={() => setActiveTab(tab.tabId)}
              onDoubleClick={() => handleStartRename(tab.tabId, tab.sessionName)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ tabId: tab.tabId, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveTab(tab.tabId);
                }
              }}
              className={cn(tabClass(isActive), "cursor-pointer")}
              title={`${tab.sessionName} (双击重命名，右键更多)`}
            >
              <span title={statusHint}>{statusDot}</span>

              {editingTabId === tab.tabId ? (
                <input
                  type="text"
                  autoFocus
                  className="w-24 rounded border border-accent bg-surface px-1 text-[11px] outline-none"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={handleCommitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCommitRename();
                    if (e.key === "Escape") setEditingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="max-w-[130px] truncate">{tab.sessionName}</span>
              )}

              {isSerial && (
                <Badge tone="accent" className="px-1 font-mono text-[9px]">
                  COM
                </Badge>
              )}

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleSafeCloseTab(tab.tabId, tab.sessionName, isConnected);
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

      {/* 右侧：视图切换入口（终端 / 分屏 / SFTP）与全屏按钮 */}
      <div className="flex shrink-0 items-center gap-1.5">
        {activeTab && !isHomeActive && activeTab.protocol !== "serial" && (
          <div className="flex items-center rounded-lg border border-line/10 bg-surface p-0.5 shadow-apple-sm text-xs">
            <button
              onClick={() => setLayoutMode("terminal")}
              className={`px-2 py-0.5 rounded-md transition text-[11px] font-medium ${
                layoutMode === "terminal"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="全终端模式"
            >
              📟 终端
            </button>
            <button
              onClick={() => setLayoutMode("split")}
              className={`px-2 py-0.5 rounded-md transition text-[11px] font-medium ${
                layoutMode === "split"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="分屏模式 (上终端 + 下 SFTP)"
            >
              ◫ 分屏
            </button>
            <button
              onClick={() => setLayoutMode("sftp")}
              className={`px-2 py-0.5 rounded-md transition text-[11px] font-medium ${
                layoutMode === "sftp"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="全屏 SFTP 视图"
            >
              📁 SFTP
            </button>
          </div>
        )}

        {/* 全屏切换按钮 */}
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className={`p-1.5 rounded-lg border transition shadow-apple-sm ${
              isFullscreen
                ? "border-accent bg-accent/10 text-accent"
                : "border-line/10 bg-surface text-ink-secondary hover:text-ink hover:bg-line/5"
            }`}
            title={isFullscreen ? "退出全屏 (Esc / F11)" : "终端全屏 (F11)"}
            aria-label="终端全屏切换"
          >
            {isFullscreen ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M10 4v6m0 0H4m6 0L3 3m10 7h6m0 0V4m0 6l7-7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* 标签右键菜单 */}
      {contextMenu && (
        <div
          className="fixed z-[100] min-w-[140px] rounded-os-md border border-line/10 bg-surface py-1 text-os-xs text-ink shadow-os-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors hover:bg-line/5"
            onClick={() => {
              const tab = tabs.find((t) => t.tabId === contextMenu.tabId);
              if (tab) handleStartRename(tab.tabId, tab.sessionName);
            }}
          >
            重命名标签
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors hover:bg-line/5"
            onClick={async () => {
              const tabId = contextMenu.tabId;
              setContextMenu(null);
              await duplicateTab(tabId);
            }}
          >
            复制会话 (新开标签)
          </button>
          <div className="my-1 border-t border-line/10" />
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left text-state-danger transition-colors hover:bg-state-danger/10"
            onClick={() => {
              const tab = tabs.find((t) => t.tabId === contextMenu.tabId);
              setContextMenu(null);
              if (tab) {
                handleSafeCloseTab(tab.tabId, tab.sessionName, tab.status === "connected");
              }
            }}
          >
            关闭标签
          </button>
        </div>
      )}

      {/* 关闭菜单浮层遮罩 */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-[99]"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
};
