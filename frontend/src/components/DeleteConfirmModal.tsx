import React, { useState } from "react";
import type { SftpFileEntry } from "../types/ipc";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  entries: SftpFileEntry[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  entries,
  onConfirm,
  onClose,
}) => {
  const [deleting, setDeleting] = useState(false);

  if (!isOpen || entries.length === 0) return null;

  const folderCount = entries.filter((e) => e.file_type === "directory").length;
  const isHighRisk = folderCount > 0;
  const isCriticalSystemPath = entries.some((e) =>
    ["/", "/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/lib"].includes(e.path)
  );

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.08] bg-white/95 p-6 shadow-apple-lg backdrop-blur-2xl text-[#1d1d1f] animate-in zoom-in-95 duration-150">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-500 border border-red-200/60 shadow-sm">
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-[#1d1d1f] tracking-tight">确认永久删除远程文件</h3>
            <p className="mt-1 text-xs text-[#86868b]">
              确定要删除选中的 <span className="font-semibold text-[#1d1d1f]">{entries.length}</span> 个项目吗？
            </p>

            {/* 包含目录的高危警示 */}
            {isHighRisk && (
              <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-900">
                <div className="flex items-center gap-1.5 font-semibold mb-1 text-amber-800">
                  <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>高危操作警告 (目录删除)</span>
                </div>
                <p className="text-[11px] text-amber-800/90 leading-relaxed">
                  选中的项目中包含 <span className="underline font-semibold">{folderCount} 个文件夹</span>。此操作将<strong className="text-amber-900 font-bold">递归永久删除</strong>远程服务器上的所有子文件与子目录，数据不可撤销！
                </p>
              </div>
            )}

            {/* 根路径/系统路径极端警告 */}
            {isCriticalSystemPath && (
              <div className="mt-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-900">
                <span className="font-bold block mb-1 text-red-800">⚠️ 严重风险：检测到系统关键路径！</span>
                <p className="text-[11px] text-red-700 leading-relaxed">
                  您正在尝试删除操作系统核心路径，可能导致远程主机瘫痪崩溃！
                </p>
              </div>
            )}

            {/* 删除清单预览 */}
            <div className="mt-3.5 max-h-28 overflow-y-auto rounded-xl bg-[#f5f5f7] p-2.5 border border-black/[0.06] text-[11px] font-mono text-[#424245] space-y-1">
              {entries.slice(0, 5).map((e) => (
                <div key={e.path} className="truncate flex items-center gap-1.5">
                  <span>{e.file_type === "directory" ? "📁" : "📄"}</span>
                  <span className="font-medium text-[#1d1d1f]">{e.name}</span>
                </div>
              ))}
              {entries.length > 5 && (
                <div className="text-[#86868b] italic pl-5">
                  ... 以及另外 {entries.length - 5} 个项目
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2.5">
          <button
            onClick={onClose}
            disabled={deleting}
            className="rounded-xl border border-black/[0.08] bg-black/[0.04] px-4 py-2 text-xs font-medium text-[#1d1d1f] hover:bg-black/[0.08] active:scale-[0.98] transition"
          >
            取消
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-red-600 active:scale-[0.98] transition disabled:opacity-50"
          >
            {deleting ? "正在删除..." : "确认永久删除"}
          </button>
        </div>
      </div>
    </div>
  );
};
