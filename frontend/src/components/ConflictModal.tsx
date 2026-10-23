import React, { useState } from "react";

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
    if (!ts) return "-";
    const d = new Date(ts > 1e11 ? ts : ts * 1000);
    return d.toLocaleString();
  };

  const isSourceNewer = sourceMtime > targetMtime;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl text-slate-200 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2.5 pb-3 border-b border-surface-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">文件传输冲突</h3>
            <p className="text-xs text-amber-300">目标路径已存在同名文件</p>
          </div>
        </div>

        <div className="mt-3 text-xs text-slate-300 font-mono bg-surface-950 p-2.5 rounded-lg border border-surface-800 break-all">
          {fileName}
        </div>

        {/* 来源 vs 目标文件属性对比 */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-surface-950/60 p-2.5 border border-surface-800/80">
            <span className="font-semibold text-emerald-400 block mb-1">
              待传入文件 (源)
            </span>
            <div className="space-y-0.5 text-slate-400">
              <p>大小: <span className="text-slate-200 font-mono">{formatSize(sourceSize)}</span></p>
              <p>修改: <span className="text-slate-200">{formatTime(sourceMtime)}</span></p>
              {isSourceNewer && <span className="inline-block px-1 py-0.2 bg-emerald-500/20 text-emerald-300 text-[10px] rounded mt-0.5">较新</span>}
            </div>
          </div>

          <div className="rounded-lg bg-surface-950/60 p-2.5 border border-surface-800/80">
            <span className="font-semibold text-slate-400 block mb-1">
              已存在文件 (目标)
            </span>
            <div className="space-y-0.5 text-slate-400">
              <p>大小: <span className="text-slate-200 font-mono">{formatSize(targetSize)}</span></p>
              <p>修改: <span className="text-slate-200">{formatTime(targetMtime)}</span></p>
              {!isSourceNewer && targetMtime > 0 && <span className="inline-block px-1 py-0.2 bg-blue-500/20 text-blue-300 text-[10px] rounded mt-0.5">较新</span>}
            </div>
          </div>
        </div>

        {/* 应用到全部 */}
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            id="apply-all-conflicts"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            className="rounded border-surface-700 bg-surface-800 text-emerald-500 focus:ring-0"
          />
          <label htmlFor="apply-all-conflicts" className="cursor-pointer select-none text-slate-300">
            应用到本次传输的后续所有冲突 (Apply to all)
          </label>
        </div>

        {/* 操作动作网格 */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <button
            onClick={() => onResolve("overwrite", applyToAll)}
            className="flex flex-col items-start p-2 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-200 transition"
          >
            <span className="font-bold">直接覆盖 (Overwrite)</span>
            <span className="text-[10px] text-red-300/80">抹掉原文件并从头重新传输</span>
          </button>

          <button
            onClick={() => onResolve("resume", applyToAll)}
            className="flex flex-col items-start p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 transition"
          >
            <span className="font-bold">断点续传 (Resume)</span>
            <span className="text-[10px] text-emerald-300/80">从已有字节末尾继续传输</span>
          </button>

          <button
            onClick={() => onResolve("skip", applyToAll)}
            className="flex flex-col items-start p-2 rounded-lg border border-surface-700 bg-surface-800 hover:bg-surface-700 text-slate-300 transition"
          >
            <span className="font-bold">跳过此项 (Skip)</span>
            <span className="text-[10px] text-slate-400">保留目标文件不变</span>
          </button>

          <button
            onClick={() => onResolve("rename", applyToAll)}
            className="flex flex-col items-start p-2 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-blue-200 transition"
          >
            <span className="font-bold">保留两者 (Auto-Rename)</span>
            <span className="text-[10px] text-blue-300/80">自动重命名为 file(1).ext</span>
          </button>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-slate-400 hover:text-white transition"
          >
            取消本次操作
          </button>
        </div>
      </div>
    </div>
  );
};
