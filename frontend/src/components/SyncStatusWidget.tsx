import React, { useState } from "react";
import { useSyncStore } from "../stores/syncStore";
import { Button } from "./ui/Button";
import { InlineNotice } from "./ui/Notice";
import { cn } from "./ui/cn";
import { CloudIcon, RefreshIcon } from "./ui/icons";

interface SyncStatusWidgetProps {
  variant?: "footer" | "header" | "button";
}

export const SyncStatusWidget: React.FC<SyncStatusWidgetProps> = ({ variant = "footer" }) => {
  const {
    config,
    syncing,
    syncNow,
    setModalOpen,
  } = useSyncStore();

  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  const handleManualSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncing) return;
    try {
      await syncNow();
      setJustSynced(true);
      setTimeout(() => setJustSynced(false), 2500);
    } catch {
      // error is handled in store
    }
  };

  const formatLastSync = (ts: number | null) => {
    if (!ts) return "从未同步";
    const date = new Date(ts);
    const now = new Date();
    const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  const isLoggedIn = !!config?.is_logged_in;
  const hasConflict = (config?.conflict_count || 0) > 0;

  const statusLabel = syncing
    ? "同步中..."
    : hasConflict
    ? `冲突 (${config?.conflict_count})`
    : isLoggedIn
    ? "加密同步"
    : "未同步";

  const pillTone = hasConflict
    ? "border-state-danger/30 bg-state-danger/5 text-state-danger hover:bg-state-danger/10"
    : isLoggedIn
    ? "border-state-success/25 bg-state-success/5 text-state-success hover:bg-state-success/10"
    : "border-line/10 bg-surface text-ink-tertiary hover:text-ink-secondary";

  // Header 模式（顶部导航栏胶囊）
  if (variant === "header") {
    return (
      <div className="relative inline-flex items-center">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          onMouseEnter={() => setTooltipOpen(true)}
          onMouseLeave={() => setTooltipOpen(false)}
          className={cn(
            "flex h-[26px] select-none items-center gap-1.5 rounded-full border px-2.5 text-os-2xs font-medium",
            "transition-[background-color,border-color,color] duration-os ease-os",
            pillTone,
          )}
          title="加密同步与状态"
        >
          {syncing ? (
            <RefreshIcon className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <CloudIcon className="h-3.5 w-3.5" />
          )}
          <span>{statusLabel}</span>
          {isLoggedIn && !syncing && (
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                hasConflict ? "bg-state-danger" : "bg-state-success",
              )}
            />
          )}
        </button>

        {tooltipOpen && (
          <div className="absolute right-0 top-full z-50 mt-2 w-[280px] rounded-os-lg border border-line/10 bg-surface p-3 text-os-xs shadow-os-lg">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-line/10 pb-2">
              <span className="flex min-w-0 items-center gap-1.5 font-semibold text-ink">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    isLoggedIn ? "bg-state-success" : "bg-line/30",
                  )}
                />
                <span className="truncate">
                  {isLoggedIn ? "加密同步已连接" : "云端同步未连接"}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-[22px] shrink-0 px-1.5 text-accent"
                disabled={syncing || !isLoggedIn}
                onClick={handleManualSync}
              >
                {syncing ? "同步中" : "立即同步"}
              </Button>
            </div>

            <div className="space-y-1.5 text-os-2xs text-ink-secondary">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-tertiary">账号</span>
                <span className="max-w-[170px] truncate font-mono text-ink">
                  {config?.account_id || "(未登录)"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-tertiary">同步端点</span>
                <span className="max-w-[170px] truncate font-mono text-ink">
                  {config?.server_url || "(自建服务端)"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-tertiary">最近同步</span>
                <span className="font-mono text-state-success">
                  {formatLastSync(config?.last_sync_at || null)}
                </span>
              </div>
            </div>

            {hasConflict && (
              <InlineNotice tone="danger" className="mt-2 py-1.5">
                <span className="text-os-2xs">
                  检测到 {config?.conflict_count} 项版本冲突，需前往设置合并
                </span>
              </InlineNotice>
            )}
          </div>
        )}
      </div>
    );
  }

  // 紧凑按钮模式
  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className={cn(
          "flex h-[26px] select-none items-center gap-1.5 rounded-full border px-2.5 text-os-2xs font-medium",
          "transition-[background-color,border-color,color] duration-os ease-os",
          pillTone,
        )}
        title="点击配置端到端加密同步"
      >
        {syncing ? (
          <RefreshIcon className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <CloudIcon className="h-3.5 w-3.5" />
        )}
        <span>{statusLabel}</span>
      </button>
    );
  }

  // Footer 模式（底部状态栏）
  return (
    <div
      className="group relative flex cursor-pointer select-none items-center gap-2 text-os-2xs"
      onClick={() => setModalOpen(true)}
      title="点击配置端到端加密同步"
    >
      <div className="flex items-center gap-1.5">
        {syncing ? (
          <RefreshIcon className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              hasConflict
                ? "bg-state-danger"
                : justSynced
                ? "bg-accent"
                : isLoggedIn
                ? "bg-state-success"
                : "bg-line/30",
            )}
          />
        )}

        <span className="font-medium text-ink-tertiary transition-colors duration-os group-hover:text-ink-secondary">
          {syncing
            ? "同步中..."
            : hasConflict
            ? `同步冲突 (${config?.conflict_count})`
            : justSynced
            ? "刚刚同步成功"
            : isLoggedIn
            ? `同步就绪 · ${formatLastSync(config?.last_sync_at || null)}`
            : "同步: 离线"}
        </span>
      </div>

      {isLoggedIn && !syncing && (
        <button
          type="button"
          onClick={handleManualSync}
          className="rounded-os-sm border border-line/10 bg-surface px-1.5 py-0.5 text-os-2xs font-medium text-accent opacity-0 transition-opacity duration-os group-hover:opacity-100"
          title="强制拉取与推送同步增量"
        >
          立即同步
        </button>
      )}
    </div>
  );
};
