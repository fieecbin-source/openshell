import React, { useEffect } from "react";
import { useSftpStore } from "../stores/sftpStore";
import type { TransferTask } from "../types/ipc";
import { Button } from "./ui/Button";
import { Badge, EmptyState } from "./ui/Surface";
import { Drawer } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
import { cn } from "./ui/cn";
import { DownloadIcon, PauseIcon, StopIcon, UploadIcon } from "./ui/icons";

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
        return <Badge tone="accent">传输中</Badge>;
      case "queued":
        return <Badge tone="neutral">排队中</Badge>;
      case "paused":
        return <Badge tone="warning">已暂停</Badge>;
      case "completed":
        return <Badge tone="success">已完成</Badge>;
      case "failed":
        return <Badge tone="danger">失败</Badge>;
      case "cancelled":
        return <Badge tone="neutral">已取消</Badge>;
      default:
        return null;
    }
  };

  const activeCount = transfers.filter(
    (t) => t.state === "transferring" || t.state === "queued",
  ).length;

  return (
    <Drawer
      open={transferQueueOpen}
      onClose={() => setTransferQueueOpen(false)}
      title="传输队列"
      description={transfers.length > 0 ? `共 ${transfers.length} 个任务` : "尚无任务"}
      widthClassName="w-[380px]"
      footer={
        <Button variant="secondary" size="sm" onClick={() => setTransferQueueOpen(false)}>
          关闭
        </Button>
      }
    >
      <div className="p-3">
        {transfers.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={<UploadIcon className="h-8 w-8" />}
            title="暂无传输任务"
            description="上传或下载文件后，任务进度会显示在这里。"
          />
        ) : (
          <div className="space-y-2">
            {transfers.map((t) => {
              const percent =
                t.total_bytes > 0
                  ? Math.min(100, Math.floor((t.transferred_bytes / t.total_bytes) * 100))
                  : 0;

              const filename = (t.direction === "upload" ? t.local_path : t.remote_path)
                .replace(/\\/g, "/")
                .split("/")
                .pop();

              return (
                <div
                  key={t.id}
                  className="rounded-os-md border border-line/10 bg-surface p-2.5 transition-colors duration-os hover:border-line/20"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {t.direction === "upload" ? (
                        <UploadIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : (
                        <DownloadIcon className="h-3.5 w-3.5 shrink-0 text-state-success" />
                      )}
                      <span className="truncate text-os-xs font-medium text-ink" title={filename}>
                        {filename}
                      </span>
                    </div>
                    {getStatusBadge(t)}
                  </div>

                  {/* 进度条 */}
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line/10">
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-os ease-os",
                        t.state === "completed"
                          ? "bg-state-success"
                          : t.state === "failed"
                            ? "bg-state-danger"
                            : t.state === "paused"
                              ? "bg-state-warning"
                              : "bg-accent",
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-os-2xs text-ink-tertiary">
                    <span className="tabular-nums">
                      {formatBytes(t.transferred_bytes)} / {formatBytes(t.total_bytes)}（{percent}%）
                    </span>
                    <span className="tabular-nums">
                      {t.state === "transferring" ? formatSpeed(t.speed_bps) : ""}
                    </span>
                  </div>

                  {t.error_message && (
                    <InlineNotice tone="danger" className="mt-2 px-2 py-1.5">
                      <span className="line-clamp-2 break-all">{t.error_message}</span>
                    </InlineNotice>
                  )}

                  {(t.state === "transferring" || t.state === "queued" || t.state === "paused") && (
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      {(t.state === "transferring" || t.state === "queued") && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-[24px] px-2 text-os-2xs"
                          leading={<PauseIcon className="h-3 w-3" />}
                          onClick={() => pauseTransfer(t.id)}
                        >
                          暂停
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-[24px] px-2 text-os-2xs text-state-danger hover:bg-state-danger/5"
                        leading={<StopIcon className="h-3 w-3" />}
                        onClick={() => cancelTransfer(t.id)}
                      >
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}

            {activeCount > 0 && (
              <p className="pt-1 text-center font-mono text-os-2xs text-ink-tertiary">
                正在处理 {activeCount} 个任务…
              </p>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
};
