import React, { useEffect } from "react";
import { useSftpStore } from "../stores/sftpStore";
import type { TransferTask } from "../types/ipc";

export const TransferQueueDrawer: React.FC = () => {
  const {
    transfers,
    transferQueueOpen,
    setTransferQueueOpen,
    pauseTransfer,
    cancelTransfer,
    pollTransfers,
  } = useSftpStore();

  // 抽屉打开时轮询任务进度，否则进度条与状态不会更新
  useEffect(() => {
    if (!transferQueueOpen) return;
    void pollTransfers();
    const timer = window.setInterval(() => {
      void pollTransfers();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [transferQueueOpen, pollTransfers]);

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
        return <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-md font-semibold">传输中</span>;
      case "queued":
        return <span className="text-[10px] bg-blue-50 text-[#0071e3] border border-blue-200 px-2 py-0.5 rounded-md font-semibold">排队中</span>;
      case "paused":
        return <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-md font-semibold">已暂停</span>;
      case "completed":
        return <span className="text-[10px] bg-gray-100 text-[#86868b] border border-black/[0.06] px-2 py-0.5 rounded-md font-medium">已完成</span>;
      case "failed":
        return <span className="text-[10px] bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-md font-semibold">失败</span>;
      case "cancelled":
        return <span className="text-[10px] bg-gray-100 text-[#86868b] border border-black/[0.06] px-2 py-0.5 rounded-md font-medium">已取消</span>;
      default:
        return null;
    }
  };

  return (
    <div className="absolute right-0 bottom-0 top-0 w-96 bg-white/95 border-l border-black/[0.08] shadow-apple-lg z-40 flex flex-col backdrop-blur-2xl text-[#1d1d1f] animate-in slide-in-from-right duration-200">
      <div className="h-11 px-4 border-b border-black/[0.06] flex items-center justify-between bg-white/70">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[#0071e3]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
          </svg>
          <span className="text-xs font-semibold text-[#1d1d1f] tracking-tight">传输队列</span>
          <span className="text-[10px] bg-black/[0.06] text-[#86868b] px-2 py-0.5 rounded-full font-mono font-medium">
            {transfers.length}
          </span>
        </div>
        <button
          onClick={() => setTransferQueueOpen(false)}
          className="text-[#86868b] hover:text-[#1d1d1f] p-1 rounded-lg hover:bg-black/[0.05] active:scale-95 transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
        {transfers.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[#86868b]">
            <svg className="w-10 h-10 mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-xs font-medium">暂无传输任务</p>
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
                className="bg-[#f5f5f7] border border-black/[0.06] rounded-xl p-3 text-xs hover:border-black/[0.12] transition shadow-apple-sm"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                    <span className={t.direction === "upload" ? "text-[#0071e3] font-bold" : "text-emerald-600 font-bold"}>
                      {t.direction === "upload" ? "↑" : "↓"}
                    </span>
                    <span className="font-semibold text-[#1d1d1f] truncate" title={filename}>
                      {filename}
                    </span>
                  </div>
                  {getStatusBadge(t)}
                </div>

                {/* 进度条 */}
                <div className="w-full bg-black/[0.08] rounded-full h-1.5 overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      t.state === "completed"
                        ? "bg-emerald-500"
                        : t.state === "failed"
                        ? "bg-red-500"
                        : "bg-[#0071e3]"
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[11px] text-[#86868b] font-mono">
                  <span>
                    {formatBytes(t.transferred_bytes)} / {formatBytes(t.total_bytes)} ({percent}%)
                  </span>
                  <span>{t.state === "transferring" ? formatSpeed(t.speed_bps) : ""}</span>
                </div>

                {t.error_message && (
                  <p className="text-[10px] text-red-600 mt-1 truncate" title={t.error_message}>
                    {t.error_message}
                  </p>
                )}

                {(t.state === "transferring" || t.state === "queued") && (
                  <div className="mt-2.5 flex items-center gap-1.5 justify-end">
                    <button
                      onClick={() => pauseTransfer(t.id)}
                      className="px-2.5 py-1 rounded-lg bg-white border border-black/[0.08] text-[10px] font-semibold text-[#1d1d1f] hover:bg-black/[0.04] active:scale-[0.98] shadow-apple-sm transition"
                    >
                      暂停
                    </button>
                    <button
                      onClick={() => cancelTransfer(t.id)}
                      className="px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-[10px] font-semibold text-red-600 hover:bg-red-100 active:scale-[0.98] transition"
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
