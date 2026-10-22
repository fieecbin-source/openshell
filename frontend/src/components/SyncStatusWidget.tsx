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

  // Header 模式
  if (variant === "header") {
    return (
      <div className="relative inline-flex items-center">
        <button
          onClick={() => setModalOpen(true)}
          onMouseEnter={() => setTooltipOpen(true)}
          onMouseLeave={() => setTooltipOpen(false)}
          className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border text-xs transition select-none ${
            hasConflict
              ? "bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
              : isLoggedIn
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
              : "bg-surface-900 border-surface-800 text-slate-400 hover:text-white hover:border-surface-700"
          }`}
          title="E2EE 云端同步与更新状态"
        >
          {syncing ? (
            <svg
              className="w-3.5 h-3.5 text-sky-400 animate-spin"
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
                  ? "text-rose-400"
                  : isLoggedIn
                  ? "text-emerald-400"
                  : "text-slate-500"
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

          <span className="font-medium">
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
                hasConflict ? "bg-rose-400 animate-pulse" : "bg-emerald-400"
              }`}
            />
          )}
        </button>

        {/* 悬浮气泡 */}
        {tooltipOpen && (
          <div className="absolute top-full mt-1.5 left-0 z-50 w-64 rounded-xl border border-surface-800 bg-surface-900/95 p-3 text-xs shadow-2xl backdrop-blur-md">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-surface-800">
              <span className="font-bold text-white flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${isLoggedIn ? "bg-emerald-400" : "bg-slate-500"}`} />
                {isLoggedIn ? "E2EE 同步已连接" : "云端同步未连接"}
              </span>
              <button
                onClick={handleManualSync}
                disabled={syncing || !isLoggedIn}
                className="text-[10px] text-sky-400 hover:text-sky-300 font-mono disabled:opacity-40"
              >
                {syncing ? "同步中" : "⚡ 立即同步"}
              </button>
            </div>

            <div className="space-y-1 text-slate-400 text-[11px]">
              <div>账号: <span className="text-slate-200">{config?.account_id || "(未登录)"}</span></div>
              <div>服务器: <span className="text-slate-200 truncate">{config?.server_url || "(默认自建端点)"}</span></div>
              <div>上次同步: <span className="text-emerald-400">{formatLastSync(config?.last_sync_at || null)}</span></div>
              {hasConflict && (
                <div className="text-rose-400 font-semibold">
                  ⚠️ 检测到 {config?.conflict_count} 项版本冲突，需手动合并
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
            className="w-3.5 h-3.5 text-sky-400 animate-spin"
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
                ? "bg-rose-400 animate-pulse"
                : justSynced
                ? "bg-sky-400"
                : isLoggedIn
                ? "bg-emerald-400 shadow-sm shadow-emerald-500/50"
                : "bg-slate-600"
            }`}
          />
        )}

        <span className="text-slate-400 group-hover:text-slate-200 transition">
          {syncing
            ? "同步中..."
            : hasConflict
            ? `同步冲突 (${config?.conflict_count})`
            : justSynced
            ? "刚刚同步成功"
            : isLoggedIn
            ? `同步正常 · ${formatLastSync(config?.last_sync_at || null)}`
            : "同步: 离线"}
        </span>
      </div>

      {isLoggedIn && !syncing && (
        <button
          onClick={handleManualSync}
          className="opacity-0 group-hover:opacity-100 px-1 py-0.2 rounded bg-surface-850 hover:bg-surface-800 text-[10px] text-sky-400 hover:text-sky-300 transition"
          title="强制拉取与推送同步增量"
        >
          立即同步
        </button>
      )}
    </div>
  );
};
