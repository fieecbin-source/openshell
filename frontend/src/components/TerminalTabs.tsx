import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Protocol } from "../types/ipc";
import { useTerminalStore } from "../stores/terminalStore";
import { Badge } from "./ui/Surface";
import { IconButton } from "./ui/Button";
import { cn } from "./ui/cn";
import { HostIcon } from "./ui/HostIcon";
import {
  ChevronDownIcon,
  HomeIcon,
  PlusIcon,
  XIcon,
  TerminalIcon,
  RowsIcon,
  FolderIcon,
  ZapIcon,
} from "./ui/icons";

interface TerminalTabsProps {
  onNewTabClick?: () => void;
  onHomeClick?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** 打开指定协议的新建连接弹窗（FinalShell 快捷新建菜单） */
  onNewSessionWithProtocol?: (protocol?: Protocol) => void;
  onOpenProxyManager?: () => void;
  onOpenPortForward?: () => void;
  /** 打开当前活动标签的「连接详情与诊断」面板 */
  onOpenConnectionDetails?: (tabId?: string) => void;
  /** 按标签 ID 打开对应会话的配置编辑弹窗 */
  onEditSessionByTab?: (tabId: string) => void;
}

/** 非 SSH 协议的标签角标，便于一眼区分连接类型 */
const PROTOCOL_BADGE: Partial<Record<Protocol, string>> = {
  rdp: "RDP",
  local_shell: "LOCAL",
  telnet: "TELNET",
  serial: "COM",
};

export const TerminalTabs: React.FC<TerminalTabsProps> = ({
  onNewTabClick,
  onHomeClick,
  isFullscreen,
  onToggleFullscreen,
  onNewSessionWithProtocol,
  onOpenProxyManager,
  onOpenPortForward,
  onOpenConnectionDetails,
  onEditSessionByTab,
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

  // 「+」右侧的下拉快捷菜单（FinalShell 风格）
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusMenuPos, setPlusMenuPos] = useState<{ left: number; top: number } | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  const togglePlusMenu = () => {
    if (!plusMenuOpen) {
      const rect = plusBtnRef.current?.getBoundingClientRect();
      if (rect) {
        setPlusMenuPos({
          left: Math.max(8, Math.min(rect.left - 40, window.innerWidth - 264)),
          top: rect.bottom + 4,
        });
      }
    }
    setPlusMenuOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!plusMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-plus-menu]")) return;
      setPlusMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusMenuOpen]);

  const runMenuAction = (action: () => void) => {
    setPlusMenuOpen(false);
    action();
  };

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

  const tabClass = (active: boolean, status?: string) =>
    cn(
      "group relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-os-md px-2 text-os-xs transition-colors duration-os ease-os select-none",
      active
        ? "border border-line/10 bg-surface text-ink shadow-os-sm"
        : "border border-transparent text-ink-secondary hover:bg-line/5 hover:text-ink",
      // 连接成功：活动标签叠加翠绿底边高亮（复刻 FinalShell 绿色状态标签）
      status === "connected" && active && "border-b-2 border-b-emerald-500 bg-emerald-500/[0.06]",
      // 连接失败 / 已断开：醒目的红色警示边框与底色
      (status === "error" || status === "disconnected") &&
        cn(
          "border border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/15",
          active && "border-b-2 border-b-red-500"
        )
    );

  // 右侧「当前连接状态 · 详情」胶囊的状态配色（复刻 FinalShell 绿/红/黄状态标签）
  const activeRdpClientLaunched =
    !!activeTab &&
    activeTab.rdpPhase === "launched" &&
    activeTab.status !== "connected" &&
    activeTab.status !== "error" &&
    activeTab.status !== "disconnected";
  const activeStatusPill = !activeTab || isHomeActive
    ? null
    : activeRdpClientLaunched
      ? {
          dot: "bg-amber-400",
          cls: "border-amber-400/30 bg-amber-400/10 text-amber-500 hover:bg-amber-400/15",
          label: "客户端已启动 · 详情",
        }
      : activeTab.status === "connected"
      ? {
          dot: "bg-emerald-500",
          cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/15",
          label: "已连接 · 详情",
        }
      : activeTab.status === "error" || activeTab.status === "disconnected"
        ? {
            dot: "bg-red-500",
            cls: "border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/15",
            label: "连接失败 · 详情",
          }
        : {
            dot: "bg-amber-400 animate-pulse",
            cls: "border-amber-400/30 bg-amber-400/10 text-amber-500 hover:bg-amber-400/15",
            label: "连接中 · 详情",
          };

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
          const protocolBadge = PROTOCOL_BADGE[tab.protocol];
          const isConnected = tab.status === "connected";

          const statusHint =
            tab.rdpPhase === "launched" && !isConnected && tab.status !== "error" && tab.status !== "disconnected"
              ? "远程桌面客户端已启动；等待后端确认远端登录结果"
              : tab.status === "connected"
                ? "已连接"
                : tab.status === "connecting"
                  ? "正在连接"
                  : tab.status === "reconnecting"
                    ? "正在连接"
                    : tab.error
                      ? `已断开：${tab.error}`
                      : "已断开，按 Enter 重新连接";

          const isEstablished = tab.status === "connected" && (!!tab.connectionId || tab.protocol === "serial");

          // Mac 风格状态指示灯 / 全速闪电徽标
          let statusIndicator = (
            <span
              className="inline-flex items-center justify-center rounded bg-emerald-500/15 p-0.5 text-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)] transition-all"
              title="已建立安全高速连接 · 全速无限制 (512KiB 流水线)"
            >
              <ZapIcon className="h-3 w-3 fill-emerald-500 text-emerald-500 stroke-[2.5]" />
            </span>
          );

          if (tab.rdpPhase === "launched" && !isConnected && tab.status !== "error" && tab.status !== "disconnected") {
            // 启动 mstsc 不等于远端已连接，使用中性黄色而非成功绿
            statusIndicator = (
              <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                <span className="h-2 w-2 rounded-full bg-amber-400 ring-1 ring-amber-300" />
              </span>
            );
          } else if (!isEstablished) {
            if (tab.status === "connected") {
              // 刚连接成功、正在挂载系统
              statusIndicator = (
                <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 ring-1 ring-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
                </span>
              );
            } else if (tab.status === "connecting" || tab.status === "reconnecting") {
              statusIndicator = (
                <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                  <span className="h-2 w-2 rounded-full bg-amber-400 ring-1 ring-amber-300 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.6)]" />
                </span>
              );
            } else {
              // 未连接上 / 连接失败 / 断开：清晰漂亮的 Mac 风格红点
              statusIndicator = (
                <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                  <span className="h-2 w-2 rounded-full bg-rose-500 ring-1 ring-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.7)]" />
                </span>
              );
            }
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
              className={cn(tabClass(isActive, tab.status), "cursor-pointer")}
              title={`${tab.sessionName} (双击重命名，右键更多)`}
            >
              {/* 1. logo 放在左侧 */}
              <HostIcon protocol={tab.protocol} className="h-3.5 w-3.5 shrink-0 opacity-80" />

              {/* 2. 会话名称 */}
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

              {/* 3. 右侧放清晰的 Mac 风格状态指示灯 / 闪电标识 */}
              <span className="shrink-0 flex items-center" title={statusHint}>{statusIndicator}</span>

              {protocolBadge && (
                <Badge
                  tone={tab.protocol === "rdp" ? "accent" : "neutral"}
                  className="px-1 font-mono text-[9px]"
                >
                  {protocolBadge}
                </Badge>
              )}

              {tab.status === "reconnecting" && !!tab.reconnectAttempt && (
                <span
                  className="shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-1 font-mono text-[9px] font-semibold text-amber-500"
                  title={`自动重连第 ${tab.reconnectAttempt} 次`}
                >
                  重连 {tab.reconnectAttempt}
                </span>
              )}

              {(tab.status === "error" || tab.status === "disconnected") && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void useTerminalStore.getState().reconnectTab(tab.tabId);
                  }}
                  className="ml-0.5 shrink-0 rounded-[4px] px-1 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/20"
                  title="重新连接"
                  aria-label={`重新连接 ${tab.sessionName}`}
                >
                  ↻
                </button>
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
          <span className="ml-0.5 flex shrink-0 items-center">
            <IconButton
              label="新建连接"
              size="sm"
              className="h-[22px] w-[22px]"
              onClick={onNewTabClick}
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </IconButton>
            <button
              ref={plusBtnRef}
              type="button"
              onClick={togglePlusMenu}
              className={cn(
                "h-[22px] rounded-os-md px-0.5 transition-colors",
                plusMenuOpen
                  ? "bg-line/10 text-ink"
                  : "text-ink-tertiary hover:bg-line/10 hover:text-ink"
              )}
              title="快速新建 / 管理"
              aria-label="快速新建菜单"
              aria-haspopup="menu"
              aria-expanded={plusMenuOpen}
            >
              <ChevronDownIcon className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>

      {/* 右侧：当前连接状态胶囊、视图切换入口（终端 / 分屏 / SFTP）与全屏按钮 */}
      <div className="flex shrink-0 items-center gap-1.5">
        {activeStatusPill && (
          <button
            type="button"
            onClick={() => onOpenConnectionDetails?.(activeTab?.tabId)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors",
              activeStatusPill.cls
            )}
            title="查看当前连接的详情与诊断信息"
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", activeStatusPill.dot)} />
            {activeStatusPill.label}
          </button>
        )}

        {activeTab &&
          !isHomeActive &&
          (activeTab.protocol === "ssh" || activeTab.protocol === "sftp") && (
          <div className="flex items-center rounded-lg border border-line/10 bg-surface p-0.5 shadow-apple-sm text-xs">
            <button
              onClick={() => setLayoutMode("terminal")}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md transition text-[11px] font-medium ${
                layoutMode === "terminal"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="全终端模式"
            >
              <TerminalIcon className="h-3.5 w-3.5" />终端
            </button>
            <button
              onClick={() => setLayoutMode("split")}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md transition text-[11px] font-medium ${
                layoutMode === "split"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="分屏模式 (上终端 + 下 SFTP)"
            >
              <RowsIcon className="h-3.5 w-3.5" />分屏
            </button>
            <button
              onClick={() => setLayoutMode("sftp")}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md transition text-[11px] font-medium ${
                layoutMode === "sftp"
                  ? "bg-action/10 text-accent font-bold"
                  : "text-ink-secondary hover:text-ink"
              }`}
              title="全屏 SFTP 视图"
            >
              <FolderIcon className="h-3.5 w-3.5" />SFTP
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

      {/* 「+」快速新建 / 管理菜单 */}
      {plusMenuOpen &&
        createPortal(
          <div
            data-plus-menu
            role="menu"
            aria-label="快速新建菜单"
            className="fixed z-[120] w-64 rounded-xl border border-line/15 bg-surface py-1 text-xs text-ink shadow-os-lg"
            style={{ left: plusMenuPos?.left ?? 8, top: plusMenuPos?.top ?? 44 }}
          >
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
              主流连接
            </div>
            {(
              [
                ["🖥️", "SSH 主机连接", "ssh"],
                ["🪟", "Windows 远程桌面 (RDP)", "rdp"],
                ["🔌", "串口 (Serial) 通信", "serial"],
              ] as Array<[string, string, Protocol]>
            ).map(([icon, label, protocol]) => (
              <button
                key={protocol}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-line/5"
                onClick={() =>
                  runMenuAction(() =>
                    onNewSessionWithProtocol
                      ? onNewSessionWithProtocol(protocol)
                      : onNewTabClick?.()
                  )
                }
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
              </button>
            ))}

            <div className="my-1 border-t border-line/10" />
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
              其他连接
            </div>
            {(
              [
                ["🌐", "Telnet 连接", "telnet"],
                ["💻", "本地终端 (Local Shell)", "local_shell"],
              ] as Array<[string, string, Protocol]>
            ).map(([icon, label, protocol]) => (
              <button
                key={protocol}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-line/5"
                onClick={() =>
                  runMenuAction(() =>
                    onNewSessionWithProtocol
                      ? onNewSessionWithProtocol(protocol)
                      : onNewTabClick?.()
                  )
                }
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
              </button>
            ))}

            {(onOpenProxyManager || onOpenPortForward) && (
              <>
                <div className="my-1 border-t border-line/10" />
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-tertiary">
                  管理
                </div>
              </>
            )}
            {onOpenProxyManager && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-line/5"
                onClick={() => runMenuAction(onOpenProxyManager)}
              >
                <span aria-hidden="true">🛡️</span>
                <span>代理服务器管理...</span>
              </button>
            )}
            {onOpenPortForward && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-line/5"
                onClick={() => runMenuAction(onOpenPortForward)}
              >
                <span aria-hidden="true">⇄</span>
                <span>隧道 / 端口转发管理...</span>
              </button>
            )}
          </div>,
          document.body
        )}

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
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors hover:bg-line/5"
            onClick={() => {
              const tabId = contextMenu.tabId;
              setContextMenu(null);
              onOpenConnectionDetails?.(tabId);
            }}
          >
            查看连接详情
          </button>
          {(() => {
            const tab = tabs.find((t) => t.tabId === contextMenu.tabId);
            if (!tab || tab.status === "connected" || tab.status === "connecting") return null;
            return (
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left transition-colors hover:bg-line/5"
                onClick={() => {
                  const tabId = contextMenu.tabId;
                  setContextMenu(null);
                  void useTerminalStore.getState().reconnectTab(tabId);
                }}
              >
                立即重新连接
              </button>
            );
          })()}
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left transition-colors hover:bg-line/5"
            onClick={() => {
              const tabId = contextMenu.tabId;
              setContextMenu(null);
              onEditSessionByTab?.(tabId);
            }}
          >
            编辑连接配置
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
