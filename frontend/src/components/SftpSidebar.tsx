import React, { useEffect, useState } from "react";
import { useSftpStore } from "../stores/sftpStore";
import type { SftpFileEntry } from "../types/ipc";

interface SftpSidebarProps {
  connId: string;
  sessionId: string;
}

export const SftpSidebar: React.FC<SftpSidebarProps> = ({ connId, sessionId }) => {
  const {
    remotePath,
    remoteFiles,
    remoteLoading,
    localPath,
    initLocal,
    loadRemoteFiles,
    refreshRemote,
    downloadFile,
    createRemoteDir,
    deleteRemoteEntry,
    renameRemoteEntry,
    openEditor,
    setTransferQueueOpen,
    transfers,
  } = useSftpStore();

  const [inputPath, setInputPath] = useState(remotePath);
  const [selectedEntry, setSelectedEntry] = useState<SftpFileEntry | null>(null);
  const [newDirModal, setNewDirModal] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renameModal, setRenameModal] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    initLocal();
    loadRemoteFiles(connId, undefined, sessionId);
  }, [connId, sessionId]);

  useEffect(() => {
    setInputPath(remotePath);
  }, [remotePath]);

  const handleNavigate = (path: string) => {
    loadRemoteFiles(connId, path, sessionId);
  };

  const handleGoUp = () => {
    if (remotePath === "/" || !remotePath) return;
    const parts = remotePath.split("/").filter(Boolean);
    parts.pop();
    const up = "/" + parts.join("/");
    handleNavigate(up);
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatPermissions = (mode: number) => {
    return (mode & 0o777).toString(8).padStart(3, "0");
  };

  return (
    <div className="h-full flex flex-col bg-surface-900 border-l border-surface-800 w-80 select-none">
      {/* 顶部路径与工具栏 */}
      <div className="p-2 border-b border-surface-800 bg-surface-950/60 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="text-xs font-semibold text-slate-200">SFTP 远程文件</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setNewDirModal(true)}
              title="新建文件夹"
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
            </button>
            <button
              onClick={() => refreshRemote(connId)}
              title="刷新目录"
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setTransferQueueOpen(true)}
              title="传输队列"
              className="relative p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {transfers.length > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
              )}
            </button>
          </div>
        </div>

        {/* 地址栏与向上按钮 */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleGoUp}
            disabled={remotePath === "/"}
            title="上一级"
            className="p-1 rounded bg-surface-800 text-slate-300 hover:bg-surface-700 disabled:opacity-30 disabled:hover:bg-surface-800"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNavigate(inputPath);
            }}
            className="flex-1 px-2 py-0.5 bg-surface-950 border border-surface-800 rounded font-mono text-[11px] text-slate-200 outline-none focus:border-emerald-500/50"
          />
        </div>
      </div>

      {/* 文件列表 */}
      <div className="flex-1 overflow-y-auto p-1 text-xs">
        {remoteLoading ? (
          <div className="h-32 flex items-center justify-center text-slate-500 text-xs">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mr-2" />
            <span>读取目录中...</span>
          </div>
        ) : remoteFiles.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-slate-500 text-xs">
            空目录
          </div>
        ) : (
          <div className="space-y-0.5">
            {remoteFiles.map((entry) => {
              const isSelected = selectedEntry?.path === entry.path;
              const isDir = entry.file_type === "directory";

              return (
                <div
                  key={entry.path}
                  onClick={() => setSelectedEntry(entry)}
                  onDoubleClick={() => {
                    if (isDir) {
                      handleNavigate(entry.path);
                    } else {
                      openEditor(connId, entry.path);
                    }
                  }}
                  className={`group px-2 py-1.5 rounded-md flex items-center justify-between cursor-pointer transition ${
                    isSelected
                      ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                      : "text-slate-300 hover:bg-surface-800/60 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-1.5 truncate flex-1 min-w-0 mr-2">
                    {isDir ? (
                      <svg className="w-4 h-4 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                    <span className="truncate text-xs font-mono">{entry.name}</span>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-slate-500 shrink-0">
                    <span>{isDir ? "" : formatSize(entry.size)}</span>
                    <span className="font-mono text-[9px] opacity-60">{formatPermissions(entry.permissions)}</span>

                    {/* 快捷操作悬浮按钮 */}
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
                      {!isDir && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (localPath) {
                              downloadFile(connId, sessionId, entry.path, localPath);
                            }
                          }}
                          title="下载到本地"
                          className="p-0.5 hover:text-emerald-400"
                        >
                          ↓
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEntry(entry);
                          setNewName(entry.name);
                          setRenameModal(true);
                        }}
                        title="重命名"
                        className="p-0.5 hover:text-blue-400"
                      >
                        ✎
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定删除 ${entry.name} 吗？`)) {
                            deleteRemoteEntry(connId, entry);
                          }
                        }}
                        title="删除"
                        className="p-0.5 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新建目录弹窗 */}
      {newDirModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-80 bg-surface-900 border border-surface-700 rounded-xl p-4 shadow-xl">
            <h4 className="text-xs font-bold text-white mb-2">新建远程文件夹</h4>
            <input
              type="text"
              autoFocus
              placeholder="文件夹名称"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-surface-950 border border-surface-700 rounded text-xs text-white mb-3 outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewDirModal(false)}
                className="px-3 py-1 bg-surface-800 text-slate-300 rounded text-xs hover:bg-surface-700"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (newDirName.trim()) {
                    await createRemoteDir(connId, newDirName.trim());
                    setNewDirName("");
                    setNewDirModal(false);
                  }
                }}
                className="px-3 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-500"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名弹窗 */}
      {renameModal && selectedEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-80 bg-surface-900 border border-surface-700 rounded-xl p-4 shadow-xl">
            <h4 className="text-xs font-bold text-white mb-2">重命名</h4>
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-surface-950 border border-surface-700 rounded text-xs text-white mb-3 outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRenameModal(false)}
                className="px-3 py-1 bg-surface-800 text-slate-300 rounded text-xs hover:bg-surface-700"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (newName.trim()) {
                    await renameRemoteEntry(connId, selectedEntry.path, newName.trim());
                    setRenameModal(false);
                  }
                }}
                className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-500"
              >
                重命名
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
