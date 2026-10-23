import React, { useState } from "react";
import { useSyncStore } from "../stores/syncStore";

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

  // Header 模式 (顶部导航栏胶囊组件)
  if (variant === "header") {
    return (
      <div className="relative inline-flex items-center">
        <button
          onClick={() => setModalOpen(true)}
          onMouseEnter={() => setTooltipOpen(true)}
          onMouseLeave={() => setTooltipOpen(false)}
          className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-xl border text-xs transition select-none shadow-apple-sm ${
            hasConflict
              ? "bg-red-50 border-red-200 text-apple-red hover:bg-red-100"
              : isLoggedIn
              ? "bg-emerald-50/80 border-emerald-200 text-emerald-700 hover:bg-emerald-100/80"
              : "bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
          }`}
          title="E2EE 云端同步与状态"
        >
          {syncing ? (
            <svg
              className="w-3.5 h-3.5 text-apple-blue animate-spin"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          ) : (
            <svg
              className={`w-3.5 h-3.5 ${
                hasConflict
                  ? "text-apple-red"
                  : isLoggedIn
                  ? "text-emerald-600"
                  : "text-slate-400"
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 00-9.78 2.096A4.001 4.001 0 003 15z"
              />
            </svg>
          )}

          <span className="font-semibold text-[11px]">
            {syncing
              ? "同步中..."
              : hasConflict
              ? `冲突 (${config?.conflict_count})`
              : isLoggedIn
              ? "E2EE 同步"
              : "未同步"}
          </span>

          {isLoggedIn && !syncing && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                hasConflict ? "bg-apple-red animate-pulse" : "bg-apple-green"
              }`}
            />
          )}
        </button>

        {/* 悬浮气泡 (Apple Glass Popover) */}
        {tooltipOpen && (
          <div className="absolute top-full mt-2 left-0 z-50 w-72 rounded-2xl border border-black/10 bg-white/95 p-3.5 text-xs shadow-apple-xl backdrop-blur-xl animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100">
              <span className="font-semibold text-slate-900 flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${isLoggedIn ? "bg-apple-green" : "bg-slate-400"}`} />
                {isLoggedIn ? "E2EE 端到端同步已连接" : "云端同步未连接"}
              </span>
              <button
                onClick={handleManualSync}
                disabled={syncing || !isLoggedIn}
                className="text-[11px] text-apple-blue hover:underline font-semibold disabled:opacity-40"
              >
                {syncing ? "同步中..." : "⚡ 立即同步"}
              </button>
            </div>

            <div className="space-y-1.5 text-slate-600 text-[11px]">
              <div className="flex justify-between">
                <span>账号:</span>
                <span className="font-mono text-slate-900 font-medium">{config?.account_id || "(未登录)"}</span>
              </div>
              <div className="flex justify-between">
                <span>同步端点:</span>
                <span className="font-mono text-slate-900 truncate max-w-[150px]">{config?.server_url || "(自建服务端)"}</span>
              </div>
              <div className="flex justify-between">
                <span>最近同步:</span>
                <span className="text-emerald-600 font-medium">{formatLastSync(config?.last_sync_at || null)}</span>
              </div>
              {hasConflict && (
                <div className="mt-2 text-apple-red font-semibold bg-red-50 p-2 rounded-xl border border-red-200">
                  ⚠️ 检测到 {config?.conflict_count} 项版本冲突，需前往设置合并
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Footer 模式 (底部状态栏小组件)
  return (
    <div
      className="flex items-center space-x-2 text-[11px] select-none group relative cursor-pointer"
      onClick={() => setModalOpen(true)}
      title="点击配置端到端加密同步"
    >
      <div className="flex items-center space-x-1.5">
        {syncing ? (
          <svg
            className="w-3.5 h-3.5 text-apple-blue animate-spin"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        ) : (
          <span
            className={`h-2 w-2 rounded-full ${
              hasConflict
                ? "bg-apple-red animate-pulse"
                : justSynced
                ? "bg-apple-blue"
                : isLoggedIn
                ? "bg-apple-green shadow-apple-sm"
                : "bg-slate-400"
            }`}
          />
        )}

        <span className="text-slate-600 group-hover:text-slate-900 transition font-medium">
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
          onClick={handleManualSync}
          className="opacity-0 group-hover:opacity-100 px-1.5 py-0.2 rounded-md bg-slate-200/80 hover:bg-slate-300 text-[10px] text-apple-blue font-semibold transition"
          title="强制拉取与推送同步增量"
        >
          立即同步
        </button>
      )}
    </div>
  );
};
