import React from "react";
import { useSftpStore } from "../stores/sftpStore";
import type { TransferTask } from "../types/ipc";

export const TransferQueueDrawer: React.FC = () => {
  const {
    transfers,
    transferQueueOpen,
    setTransferQueueOpen,
    pauseTransfer,
    cancelTransfer,
  } = useSftpStore();

  if (!transferQueueOpen) return null;

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatSpeed = (bps: number) => {
    return formatBytes(bps) + "/s";
  };

  const getStatusBadge = (t: TransferTask) => {
    switch (t.state) {
      case "transferring":
        return <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-medium">传输中</span>;
      case "queued":
        return <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded font-medium">排队中</span>;
      case "paused":
        return <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-medium">已暂停</span>;
      case "completed":
        return <span className="text-[10px] bg-slate-500/10 text-slate-400 border border-slate-500/20 px-1.5 py-0.5 rounded font-medium">已完成</span>;
      case "failed":
        return <span className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded font-medium">失败</span>;
      case "cancelled":
        return <span className="text-[10px] bg-slate-700/30 text-slate-500 border border-slate-700/40 px-1.5 py-0.5 rounded font-medium">已取消</span>;
      default:
        return null;
    }
  };

  return (
    <div className="absolute right-0 bottom-0 top-0 w-96 bg-surface-900 border-l border-surface-800 shadow-2xl z-40 flex flex-col backdrop-blur-md">
      <div className="h-10 px-4 border-b border-surface-800 flex items-center justify-between bg-surface-950/60">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
          </svg>
          <span className="text-xs font-semibold text-slate-200">传输队列</span>
          <span className="text-[10px] bg-surface-800 text-slate-400 px-1.5 py-0.2 rounded-full font-mono">
            {transfers.length}
          </span>
        </div>
        <button
          onClick={() => setTransferQueueOpen(false)}
          className="text-slate-400 hover:text-white p-1 rounded hover:bg-surface-800 transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {transfers.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500">
            <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-xs">暂无传输任务</p>
          </div>
        ) : (
          transfers.map((t) => {
            const percent = t.total_bytes > 0
              ? Math.min(100, Math.floor((t.transferred_bytes / t.total_bytes) * 100))
              : 0;

            const filename = (t.direction === "upload" ? t.local_path : t.remote_path)
              .replace(/\\/g, "/")
              .split("/")
              .pop();

            return (
              <div
                key={t.id}
                className="bg-surface-950/70 border border-surface-800/80 rounded-lg p-2.5 text-xs hover:border-surface-700 transition"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                    <span className={t.direction === "upload" ? "text-blue-400 font-bold" : "text-emerald-400 font-bold"}>
                      {t.direction === "upload" ? "↑" : "↓"}
                    </span>
                    <span className="font-medium text-slate-200 truncate" title={filename}>
                      {filename}
                    </span>
                  </div>
                  {getStatusBadge(t)}
                </div>

                {/* 进度条 */}
                <div className="w-full bg-surface-800 rounded-full h-1.5 overflow-hidden mb-1.5">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      t.state === "completed"
                        ? "bg-emerald-500"
                        : t.state === "failed"
                        ? "bg-red-500"
                        : "bg-blue-500"
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>
                    {formatBytes(t.transferred_bytes)} / {formatBytes(t.total_bytes)} ({percent}%)
                  </span>
                  <span>{t.state === "transferring" ? formatSpeed(t.speed_bps) : ""}</span>
                </div>

                {t.error_message && (
                  <p className="text-[10px] text-red-400 mt-1 truncate" title={t.error_message}>
                    {t.error_message}
                  </p>
                )}

                {(t.state === "transferring" || t.state === "queued") && (
                  <div className="mt-2 flex items-center gap-1 justify-end">
                    <button
                      onClick={() => pauseTransfer(t.id)}
                      className="px-2 py-0.5 rounded bg-surface-800 text-[10px] text-slate-300 hover:bg-surface-700"
                    >
                      暂停
                    </button>
                    <button
                      onClick={() => cancelTransfer(t.id)}
                      className="px-2 py-0.5 rounded bg-surface-800 text-[10px] text-red-400 hover:bg-red-500/20"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
