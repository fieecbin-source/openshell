import React, { useState } from "react";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Surface";
import { Checkbox } from "./ui/Controls";
import { Modal } from "./ui/Overlay";
import { cn } from "./ui/cn";

export type ConflictAction = "overwrite" | "resume" | "skip" | "rename";

interface ConflictModalProps {
  isOpen: boolean;
  fileName: string;
  sourceSize?: number;
  sourceMtime?: number;
  targetSize?: number;
  targetMtime?: number;
  onResolve: (action: ConflictAction, applyToAll: boolean) => void;
  onClose: () => void;
}

export const ConflictModal: React.FC<ConflictModalProps> = ({
  isOpen,
  fileName,
  sourceSize = 0,
  sourceMtime = 0,
  targetSize = 0,
  targetMtime = 0,
  onResolve,
  onClose,
}) => {
  const [applyToAll, setApplyToAll] = useState(false);

  if (!isOpen) return null;

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatTime = (ts: number) => {
    if (!ts) return "—";
    const d = new Date(ts > 1e11 ? ts : ts * 1000);
    return d.toLocaleString();
  };

  const isSourceNewer = sourceMtime > targetMtime;

  const actionClass =
    "flex flex-col items-start gap-0.5 rounded-os-md border p-2 text-left transition-colors duration-os ease-os";

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="文件传输冲突"
      description="目标路径已存在同名文件，请选择处理方式。"
      widthClassName="w-full max-w-[480px]"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          取消本次操作
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="break-all rounded-os-md border border-line/10 bg-surface-muted px-3 py-2 font-mono text-os-xs text-ink">
          {fileName}
        </div>

        {/* 来源 vs 目标文件属性对比 */}
        <div className="grid grid-cols-2 gap-2">
          <div
            className={cn(
              "rounded-os-md border p-2.5",
              isSourceNewer
                ? "border-state-success/30 bg-state-success/5"
                : "border-line/10 bg-surface-muted",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-os-xs font-medium text-ink">待传入（源）</span>
              {isSourceNewer && <Badge tone="success">较新</Badge>}
            </div>
            <div className="mt-1.5 space-y-0.5 font-mono text-os-2xs text-ink-tertiary">
              <p className="flex justify-between gap-2">
                <span>大小</span>
                <span className="truncate tabular-nums text-ink-secondary">{formatSize(sourceSize)}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span>修改</span>
                <span className="truncate text-ink-secondary">{formatTime(sourceMtime)}</span>
              </p>
            </div>
          </div>

          <div
            className={cn(
              "rounded-os-md border p-2.5",
              !isSourceNewer && targetMtime > 0
                ? "border-accent/25 bg-accent/5"
                : "border-line/10 bg-surface-muted",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-os-xs font-medium text-ink">已存在（目标）</span>
              {!isSourceNewer && targetMtime > 0 && <Badge tone="accent">较新</Badge>}
            </div>
            <div className="mt-1.5 space-y-0.5 font-mono text-os-2xs text-ink-tertiary">
              <p className="flex justify-between gap-2">
                <span>大小</span>
                <span className="truncate tabular-nums text-ink-secondary">{formatSize(targetSize)}</span>
              </p>
              <p className="flex justify-between gap-2">
                <span>修改</span>
                <span className="truncate text-ink-secondary">{formatTime(targetMtime)}</span>
              </p>
            </div>
          </div>
        </div>

        <Checkbox
          checked={applyToAll}
          onChange={setApplyToAll}
          label="应用到本次传输的后续所有冲突"
        />

        {/* 操作动作网格 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onResolve("overwrite", applyToAll)}
            className={cn(
              actionClass,
              "border-state-danger/30 bg-state-danger/5 text-state-danger hover:bg-state-danger/10",
            )}
          >
            <span className="text-os-xs font-semibold">直接覆盖</span>
            <span className="text-os-2xs opacity-80">抹掉原文件并从头重新传输</span>
          </button>

          <button
            type="button"
            onClick={() => onResolve("resume", applyToAll)}
            className={cn(
              actionClass,
              "border-state-success/30 bg-state-success/5 text-state-success hover:bg-state-success/10",
            )}
          >
            <span className="text-os-xs font-semibold">断点续传</span>
            <span className="text-os-2xs opacity-80">从已有字节末尾继续传输</span>
          </button>

          <button
            type="button"
            onClick={() => onResolve("skip", applyToAll)}
            className={cn(
              actionClass,
              "border-line/10 bg-surface-muted text-ink-secondary hover:bg-line/5",
            )}
          >
            <span className="text-os-xs font-semibold text-ink">跳过此项</span>
            <span className="text-os-2xs text-ink-tertiary">保留目标文件不变</span>
          </button>

          <button
            type="button"
            onClick={() => onResolve("rename", applyToAll)}
            className={cn(
              actionClass,
              "border-accent/25 bg-accent/5 text-accent hover:bg-accent/10",
            )}
          >
            <span className="text-os-xs font-semibold">保留两者</span>
            <span className="text-os-2xs opacity-80">自动重命名为 file(1).ext</span>
          </button>
        </div>
      </div>
    </Modal>
  );
};
