import React, { useState, useEffect, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSftpStore } from "../stores/sftpStore";
import type { SftpFileEntry } from "../types/ipc";
import { ChmodModal } from "./ChmodModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { RemoteEditorModal } from "./RemoteEditorModal";
import { localFsHome, sftpWriteFile } from "../lib/ipc";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface SftpViewProps {
  connId: string;
  sessionId: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: SftpFileEntry | null;
}

export const SftpView: React.FC<SftpViewProps> = ({ connId, sessionId }) => {
  const {
    remotePath,
    remoteFiles,
    remoteLoading,
    history,
    historyIndex,
    showHidden,
    filterQuery,
    sortBy,
    sortAsc,
    selectedPaths,
    localPath,
    initLocal,
    loadRemoteFiles,
    refreshRemote,
    goBack,
    goForward,
    setShowHidden,
    setFilterQuery,
    setSort,
    setSelectedPaths,
    toggleSelectPath,
    uploadFile,
    downloadFile,
    createRemoteDir,
    createRemoteFile,
    deleteRemoteEntry,
    renameRemoteEntry,
    chmodRemoteEntry,
    openEditor,
    setTransferQueueOpen,
    transfers,
  } = useSftpStore();

  // 路径栏可编辑状态（Ctrl+L / 点击切换）
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInputValue, setPathInputValue] = useState(remotePath);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // 模态框与上下文菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
  });

  const [chmodModalOpen, setChmodModalOpen] = useState(false);
  const [chmodTarget, setChmodTarget] = useState<SftpFileEntry | null>(null);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<SftpFileEntry[]>([]);

  const [newDirModalOpen, setNewDirModalOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");

  const [newFileModalOpen, setNewFileModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");

  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SftpFileEntry | null>(null);
  const [newTargetName, setNewTargetName] = useState("");

  const [propertiesModalOpen, setPropertiesModalOpen] = useState(false);
  const [propertiesTarget, setPropertiesTarget] = useState<SftpFileEntry | null>(null);

  // 拖拽上传覆盖态
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 虚拟滚动容器
  const parentRef = useRef<HTMLDivElement>(null);

  // 初始化加载当前目录
  useEffect(() => {
    initLocal();
    loadRemoteFiles(connId, undefined, sessionId);
  }, [connId, sessionId]);

  useEffect(() => {
    setPathInputValue(remotePath);
  }, [remotePath]);

  // 监听全局与本视图快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+L / Cmd+L 聚焦地址栏
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setIsEditingPath(true);
        setTimeout(() => {
          pathInputRef.current?.focus();
          pathInputRef.current?.select();
        }, 50);
      }
      // Ctrl+H 切换隐藏文件
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setShowHidden(!showHidden);
      }
      // F5 刷新
      if (e.key === "F5") {
        e.preventDefault();
        refreshRemote(connId);
      }
      // Delete 键触发删除选中项
      if (e.key === "Delete" && selectedPaths.length > 0 && !isEditingPath) {
        e.preventDefault();
        const targets = remoteFiles.filter((f) => selectedPaths.includes(f.path));
        if (targets.length > 0) {
          setDeleteTargets(targets);
          setDeleteModalOpen(true);
        }
      }
      // Esc 关闭上下文菜单或地址编辑
      if (e.key === "Escape") {
        setContextMenu((prev) => ({ ...prev, visible: false }));
        setIsEditingPath(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showHidden, selectedPaths, remoteFiles, connId, isEditingPath]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.visible) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [contextMenu.visible]);

  // 过滤与排序文件列表
  const visibleFiles = useMemo(() => {
    let list = [...remoteFiles];

    // 1. 过滤隐藏点文件
    if (!showHidden) {
      list = list.filter((f) => !f.name.startsWith("."));
    }

    // 2. 关键词模糊匹配
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase();
      list = list.filter((f) => f.name.toLowerCase().includes(q));
    }

    // 3. 排序（文件夹始终默认置顶）
    list.sort((a, b) => {
      const aIsDir = a.file_type === "directory";
      const bIsDir = b.file_type === "directory";
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;

      let cmp = 0;
      switch (sortBy) {
        case "size":
          cmp = a.size - b.size;
          break;
        case "mtime":
          cmp = a.modified_at - b.modified_at;
          break;
        case "permissions":
          cmp = a.permissions - b.permissions;
          break;
        case "name":
        default:
          cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
          break;
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [remoteFiles, showHidden, filterQuery, sortBy, sortAsc]);

  // 虚拟滚动配置 (每行固定高度 36px)
  const virtualizer = useVirtualizer({
    count: visibleFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // 面包屑分段
  const breadcrumbs = useMemo(() => {
    if (!remotePath || remotePath === "/") return [{ label: "/", path: "/" }];
    const parts = remotePath.split("/").filter(Boolean);
    const crumbs = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [remotePath]);

  // 提交地址栏输入
  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsEditingPath(false);
    let target = pathInputValue.trim();
    if (!target) target = "/";
    loadRemoteFiles(connId, target, sessionId);
  };

  // 双击项目
  const handleItemDoubleClick = (entry: SftpFileEntry) => {
    if (entry.file_type === "directory") {
      loadRemoteFiles(connId, entry.path, sessionId);
    } else {
      openEditor(connId, entry.path);
    }
  };

  // 右键上下文菜单
  const handleContextMenu = (e: React.MouseEvent, entry: SftpFileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();

    if (entry && !selectedPaths.includes(entry.path)) {
      setSelectedPaths([entry.path]);
    }

    setContextMenu({
      visible: true,
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - 300),
      entry,
    });
  };

  // 文件选择与多选
  const handleRowClick = (e: React.MouseEvent, entry: SftpFileEntry) => {
    const allPaths = visibleFiles.map((f) => f.path);
    if (e.shiftKey) {
      toggleSelectPath(entry.path, true, allPaths);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelectPath(entry.path, false);
    } else {
      setSelectedPaths([entry.path]);
    }
  };

  // 批量/单项下载
  const handleDownload = async (entry?: SftpFileEntry) => {
    let destDir = localPath;
    if (!destDir) {
      destDir = await localFsHome();
    }
    const targets = entry ? [entry] : visibleFiles.filter((f) => selectedPaths.includes(f.path));
    for (const t of targets) {
      await downloadFile(connId, sessionId, t.path, destDir, true);
    }
  };

  // 拖拽与上传文件
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  // 浏览器 File 可能没有系统路径（Tauri 拖拽事件以外的场景），退化为直接读取内容上传
  const uploadFileObject = async (file: File) => {
    const systemPath = (file as any).path as string | undefined;
    if (systemPath) {
      await uploadFile(connId, sessionId, systemPath, remotePath, true);
      return;
    }
    const buffer = await file.arrayBuffer();
    const dest = remotePath.endsWith("/")
      ? `${remotePath}${file.name}`
      : `${remotePath}/${file.name}`;
    await sftpWriteFile(connId, dest, Array.from(new Uint8Array(buffer)));
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    // 处理原生操作系统拖入的文件
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      try {
        for (let i = 0; i < files.length; i++) {
          await uploadFileObject(files[i]);
        }
        await refreshRemote(connId);
      } catch (err) {
        console.warn("拖拽上传失败", err);
      }
    }
  };

  // Tauri 窗口级拖拽事件：WebView 默认接管拖拽，HTML5 drop 不会触发
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths || [];
        if (paths.length === 0) return;
        try {
          for (const path of paths) {
            await uploadFile(connId, sessionId, path, remotePath, true);
          }
          await refreshRemote(connId);
        } catch (err) {
          console.warn("拖拽上传失败", err);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [connId, sessionId, remotePath, uploadFile, refreshRemote]);

  // 触发本地文件上传选择器
  const triggerUploadPicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      try {
        for (let i = 0; i < files.length; i++) {
          await uploadFileObject(files[i]);
        }
        await refreshRemote(connId);
      } catch (err) {
        console.warn("上传失败", err);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 工具方法
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    const k = 1024;
    const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatPermissions = (mode: number) => {
    const isDir = (mode & 0o40000) !== 0;
    const rwx = [
      mode & 0o400 ? "r" : "-",
      mode & 0o200 ? "w" : "-",
      mode & 0o100 ? "x" : "-",
      mode & 0o040 ? "r" : "-",
      mode & 0o020 ? "w" : "-",
      mode & 0o010 ? "x" : "-",
      mode & 0o004 ? "r" : "-",
      mode & 0o002 ? "w" : "-",
      mode & 0o001 ? "x" : "-",
    ].join("");
    return `${isDir ? "d" : "-"}${rwx} (0${(mode & 0o777).toString(8).padStart(3, "0")})`;
  };

  const formatDate = (ts: number) => {
    if (!ts) return "-";
    const d = new Date(ts > 1e11 ? ts : ts * 1000);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  const getFileIcon = (entry: SftpFileEntry) => {
    if (entry.file_type === "directory") {
      return <span className="text-state-warning text-sm">📁</span>;
    }
    if (entry.file_type === "symlink") {
      return <span className="text-cyan-400 text-sm">🔗</span>;
    }
    const name = entry.name.toLowerCase();
    if (name.endsWith(".tar") || name.endsWith(".gz") || name.endsWith(".zip") || name.endsWith(".7z")) {
      return <span className="text-rose-400 text-sm">📦</span>;
    }
    if (name.endsWith(".sh") || name.endsWith(".py") || name.endsWith(".rs") || name.endsWith(".js") || name.endsWith(".json")) {
      return <span className="text-state-success text-sm">📄</span>;
    }
    return <span className="text-ink-secondary text-sm">📄</span>;
  };

  return (
    <div
      className="relative flex h-full w-full flex-col bg-surface-muted font-sans text-ink-secondary select-none overflow-hidden"
      onContextMenu={(e) => handleContextMenu(e, null)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 隐藏的本地文件上传选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* 顶部工具栏与双态地址栏 */}
      <div className="flex flex-col border-b border-line/15 bg-surface-muted/90 backdrop-blur-md px-3 py-2 space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-3">
          {/* 左侧导航动作：后退、前进、上级、刷新、主目录 */}
          <div className="flex items-center space-x-1">
            <button
              onClick={() => goBack(connId, sessionId)}
              disabled={historyIndex <= 0}
              className="p-1.5 rounded-lg border border-line/15 bg-surface text-ink-secondary hover:text-ink disabled:opacity-40 disabled:pointer-events-none transition"
              title="后退 (Alt+Left)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => goForward(connId, sessionId)}
              disabled={historyIndex >= history.length - 1}
              className="p-1.5 rounded-lg border border-line/15 bg-surface text-ink-secondary hover:text-ink disabled:opacity-40 disabled:pointer-events-none transition"
              title="前进 (Alt+Right)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => {
                if (remotePath === "/" || !remotePath) return;
                const parts = remotePath.split("/").filter(Boolean);
                parts.pop();
                const up = "/" + parts.join("/");
                loadRemoteFiles(connId, up, sessionId);
              }}
              disabled={remotePath === "/" || !remotePath}
              className="p-1.5 rounded-lg border border-line/15 bg-surface text-ink-secondary hover:text-ink disabled:opacity-40 disabled:pointer-events-none transition"
              title="返回上级 (Alt+Up)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </button>
            <button
              onClick={() => refreshRemote(connId)}
              className="p-1.5 rounded-lg border border-line/15 bg-surface text-ink-secondary hover:text-ink transition"
              title="刷新目录 (F5)"
            >
              <svg className={`w-3.5 h-3.5 ${remoteLoading ? "animate-spin text-state-success" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => loadRemoteFiles(connId, "~", sessionId)}
              className="p-1.5 rounded-lg border border-line/15 bg-surface text-ink-secondary hover:text-ink transition"
              title="用户主目录 (~)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </button>
          </div>

          {/* 双态地址栏 (面包屑 / 文本框) */}
          <div className="flex-1 min-w-0">
            {isEditingPath ? (
              <form onSubmit={handlePathSubmit} className="relative w-full">
                <input
                  ref={pathInputRef}
                  type="text"
                  value={pathInputValue}
                  onChange={(e) => setPathInputValue(e.target.value)}
                  onBlur={() => setIsEditingPath(false)}
                  className="w-full rounded-lg border border-accent/30 bg-surface-muted px-3 py-1 text-xs text-ink outline-none font-mono"
                  placeholder="输入绝对路径 (回车跳转, Esc 取消)"
                />
              </form>
            ) : (
              <div
                onClick={() => setIsEditingPath(true)}
                className="flex items-center space-x-1 overflow-x-auto rounded-lg border border-line/15 bg-surface-muted/80 px-2.5 py-1 text-xs text-ink-secondary font-mono cursor-text hover:border-line/15 transition h-[30px]"
                title="点击编辑路径 (Ctrl+L)"
              >
                <span className="text-state-success font-bold shrink-0">🌐</span>
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={crumb.path}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        loadRemoteFiles(connId, crumb.path, sessionId);
                      }}
                      className="rounded px-1 py-0.5 hover:bg-surface hover:text-ink transition shrink-0"
                    >
                      {crumb.label}
                    </button>
                    {idx < breadcrumbs.length - 1 && (
                      <span className="text-ink-tertiary shrink-0">/</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>

          {/* 右侧快捷操作：新建文件夹、新建文件、上传、队列 */}
          <div className="flex items-center space-x-1.5 shrink-0">
            <button
              onClick={() => {
                setNewDirName("");
                setNewDirModalOpen(true);
              }}
              className="flex items-center space-x-1 rounded-lg border border-line/15 bg-surface px-2.5 py-1 text-xs text-ink-secondary hover:text-ink hover:border-line/15 transition"
              title="新建文件夹"
            >
              <span>+📁</span>
              <span className="hidden sm:inline">新建目录</span>
            </button>

            <button
              onClick={() => {
                setNewFileName("");
                setNewFileModalOpen(true);
              }}
              className="flex items-center space-x-1 rounded-lg border border-line/15 bg-surface px-2.5 py-1 text-xs text-ink-secondary hover:text-ink hover:border-line/15 transition"
              title="新建文件"
            >
              <span>+📄</span>
              <span className="hidden sm:inline">新建文件</span>
            </button>

            <button
              onClick={triggerUploadPicker}
              className="flex items-center space-x-1 rounded-lg border border-state-success/30 bg-emerald-600/20 px-2.5 py-1 text-xs text-state-success hover:bg-emerald-600/30 hover:border-state-success/30 transition font-medium"
              title="从本地选择文件上传至当前目录"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <span>上传</span>
            </button>

            <button
              onClick={() => setTransferQueueOpen(true)}
              className="flex items-center space-x-1 rounded-lg border border-line/15 bg-surface px-2.5 py-1 text-xs text-ink-secondary hover:text-ink hover:border-line/15 transition"
              title="查看传输队列"
            >
              <span>传输</span>
              {transfers.length > 0 && (
                <span className="rounded-full bg-state-success/100/20 text-state-success border border-state-success/30 px-1.5 text-[10px] font-mono">
                  {transfers.filter((t) => t.state === "transferring" || t.state === "queued").length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* 次工具条：搜索过滤框、显示隐藏文件、选中项统计 */}
        <div className="flex items-center justify-between text-xs text-ink-secondary">
          <div className="flex items-center space-x-2 w-72">
            <div className="relative flex-1">
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="过滤当前目录文件名..."
                className="w-full rounded-md border border-line/15 bg-surface-muted px-2.5 py-1 text-xs text-ink placeholder-ink-tertiary outline-none focus:border-accent/30"
              />
              {filterQuery && (
                <button
                  onClick={() => setFilterQuery("")}
                  className="absolute right-2 top-1.5 text-ink-secondary hover:text-ink-secondary"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              onClick={() => setShowHidden(!showHidden)}
              className={`p-1.5 rounded-md border transition ${
                showHidden
                  ? "bg-indigo-600/20 border-accent/30 text-accent"
                  : "bg-surface border-line/15 text-ink-secondary hover:text-ink"
              }`}
              title="显示/隐藏以点开头的隐藏文件 (Ctrl+H)"
            >
              {showHidden ? "👁️" : "🙈"}
            </button>
          </div>

          <div className="flex items-center space-x-3 text-[11px] text-ink-secondary font-mono">
            {selectedPaths.length > 0 && (
              <span className="text-state-success font-semibold">
                已选中 {selectedPaths.length} 项
              </span>
            )}
            <span>共 {visibleFiles.length} 项</span>
          </div>
        </div>
      </div>

      {/* 文件表格表头 */}
      <div className="grid grid-cols-12 gap-2 border-b border-line/15 bg-surface-muted/60 px-4 py-2 text-xs font-semibold text-ink-secondary shrink-0">
        <div
          onClick={() => setSort("name")}
          className="col-span-5 flex items-center gap-1 cursor-pointer hover:text-ink transition"
        >
          <span>名称</span>
          {sortBy === "name" && <span>{sortAsc ? "▲" : "▼"}</span>}
        </div>
        <div
          onClick={() => setSort("size")}
          className="col-span-2 flex items-center justify-end gap-1 cursor-pointer hover:text-ink transition"
        >
          <span>大小</span>
          {sortBy === "size" && <span>{sortAsc ? "▲" : "▼"}</span>}
        </div>
        <div
          onClick={() => setSort("mtime")}
          className="col-span-3 flex items-center justify-center gap-1 cursor-pointer hover:text-ink transition"
        >
          <span>修改时间</span>
          {sortBy === "mtime" && <span>{sortAsc ? "▲" : "▼"}</span>}
        </div>
        <div
          onClick={() => setSort("permissions")}
          className="col-span-2 flex items-center justify-end gap-1 cursor-pointer hover:text-ink transition"
        >
          <span>权限</span>
          {sortBy === "permissions" && <span>{sortAsc ? "▲" : "▼"}</span>}
        </div>
      </div>

      {/* 虚拟滚动文件列表主体 */}
      <div ref={parentRef} className="flex-1 overflow-y-auto relative">
        {remoteLoading && visibleFiles.length === 0 ? (
          <div className="flex h-full items-center justify-center space-x-2 text-ink-secondary">
            <svg className="w-5 h-5 animate-spin text-state-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="text-xs">正在读取远程目录...</span>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-ink-secondary">
            <span className="text-3xl mb-2">📁</span>
            <span className="text-xs">此目录为空，或无匹配项</span>
            <span className="text-[11px] text-ink-tertiary mt-1">
              可直接将本地文件拖拽至此上传
            </span>
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = visibleFiles[virtualRow.index];
              const isSelected = selectedPaths.includes(entry.path);
              const isDir = entry.file_type === "directory";

              return (
                <div
                  key={entry.path}
                  onClick={(e) => handleRowClick(e, entry)}
                  onDoubleClick={() => handleItemDoubleClick(entry)}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={`grid grid-cols-12 gap-2 items-center px-4 text-xs font-mono transition cursor-pointer border-b border-line/15 ${
                    isSelected
                      ? "bg-indigo-600/25 text-ink border-accent/30"
                      : "text-ink-secondary hover:bg-surface-muted/60"
                  }`}
                >
                  {/* 名称 */}
                  <div className="col-span-5 flex items-center gap-2 truncate">
                    {getFileIcon(entry)}
                    <span className="truncate" title={entry.name}>
                      {entry.name}
                    </span>
                  </div>

                  {/* 大小 */}
                  <div className="col-span-2 text-right text-ink-secondary">
                    {isDir ? "-" : formatSize(entry.size)}
                  </div>

                  {/* 修改时间 */}
                  <div className="col-span-3 text-center text-ink-secondary">
                    {formatDate(entry.modified_at)}
                  </div>

                  {/* 权限 */}
                  <div className="col-span-2 text-right text-ink-secondary">
                    {formatPermissions(entry.permissions)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 原生拖拽上传全屏遮罩 */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-indigo-950/70 backdrop-blur-sm border-2 border-dashed border-accent/30">
          <div className="rounded-2xl bg-surface-muted/90 border border-accent/30 p-6 shadow-2xl flex flex-col items-center">
            <svg className="w-12 h-12 text-accent mb-2 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
            <h3 className="text-sm font-bold text-ink mb-1">释放以开始上传</h3>
            <p className="text-xs text-accent font-mono">
              上传目标路径: {remotePath}
            </p>
          </div>
        </div>
      )}

      {/* 右键上下文菜单 */}
      {contextMenu.visible && (
        <div
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          className="fixed z-50 w-52 rounded-xl border border-line/15 bg-surface-muted/95 backdrop-blur-md p-1.5 shadow-2xl text-xs text-ink-secondary"
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry ? (
            <>
              {contextMenu.entry.file_type !== "directory" && (
                <button
                  onClick={() => {
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                    if (contextMenu.entry) openEditor(connId, contextMenu.entry.path);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
                >
                  <span>✏️</span>
                  <span>在线编辑</span>
                </button>
              )}

              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  handleDownload(contextMenu.entry || undefined);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>⬇️</span>
                <span>下载到本地</span>
              </button>

              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.entry) {
                    setRenameTarget(contextMenu.entry);
                    setNewTargetName(contextMenu.entry.name);
                    setRenameModalOpen(true);
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>🏷️</span>
                <span>重命名</span>
              </button>

              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.entry) {
                    setChmodTarget(contextMenu.entry);
                    setChmodModalOpen(true);
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>🔒</span>
                <span>修改权限 (Chmod)</span>
              </button>

              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  if (contextMenu.entry) {
                    setPropertiesTarget(contextMenu.entry);
                    setPropertiesModalOpen(true);
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>ℹ️</span>
                <span>属性详情</span>
              </button>

              <div className="my-1 border-t border-line/15" />

              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  const targets = contextMenu.entry
                    ? [contextMenu.entry]
                    : visibleFiles.filter((f) => selectedPaths.includes(f.path));
                  setDeleteTargets(targets);
                  setDeleteModalOpen(true);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-state-danger/100/20 text-state-danger text-left transition"
              >
                <span>🗑️</span>
                <span>删除</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  setNewDirName("");
                  setNewDirModalOpen(true);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>📁</span>
                <span>新建文件夹</span>
              </button>
              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  setNewFileName("");
                  setNewFileModalOpen(true);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>📄</span>
                <span>新建文件</span>
              </button>
              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  triggerUploadPicker();
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>⬆️</span>
                <span>上传文件至此</span>
              </button>
              <div className="my-1 border-t border-line/15" />
              <button
                onClick={() => {
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                  refreshRemote(connId);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface text-left transition"
              >
                <span>🔄</span>
                <span>刷新</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* 权限修改模态框 */}
      {chmodTarget && (
        <ChmodModal
          isOpen={chmodModalOpen}
          entryName={chmodTarget.name}
          initialMode={chmodTarget.permissions}
          isDirectory={chmodTarget.file_type === "directory"}
          onConfirm={async (mode, recursive) => {
            await chmodRemoteEntry(connId, chmodTarget.path, mode, recursive);
            setChmodModalOpen(false);
            setChmodTarget(null);
          }}
          onClose={() => {
            setChmodModalOpen(false);
            setChmodTarget(null);
          }}
        />
      )}

      {/* 删除安全确认模态框 */}
      <DeleteConfirmModal
        isOpen={deleteModalOpen}
        entries={deleteTargets}
        onConfirm={async () => {
          for (const target of deleteTargets) {
            await deleteRemoteEntry(connId, target);
          }
          setDeleteModalOpen(false);
          setDeleteTargets([]);
        }}
        onClose={() => {
          setDeleteModalOpen(false);
          setDeleteTargets([]);
        }}
      />

      {/* 新建文件夹模态框 */}
      {newDirModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4">
          <div className="w-80 rounded-xl border border-line/15 bg-surface-muted p-4 shadow-2xl">
            <h4 className="text-xs font-bold text-ink mb-2">新建远程文件夹</h4>
            <input
              type="text"
              autoFocus
              placeholder="文件夹名称"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newDirName.trim()) {
                  createRemoteDir(connId, newDirName.trim());
                  setNewDirModalOpen(false);
                }
                if (e.key === "Escape") setNewDirModalOpen(false);
              }}
              className="w-full px-2.5 py-1.5 bg-surface-muted border border-line/15 rounded text-xs text-ink mb-3 outline-none focus:border-accent/30 font-mono"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewDirModalOpen(false)}
                className="px-3 py-1 rounded bg-surface text-xs text-ink-secondary hover:text-ink"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (newDirName.trim()) {
                    createRemoteDir(connId, newDirName.trim());
                    setNewDirModalOpen(false);
                  }
                }}
                disabled={!newDirName.trim()}
                className="px-3 py-1 rounded bg-action text-xs font-semibold text-white hover:bg-action/90 disabled:opacity-40"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建文件模态框 */}
      {newFileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4">
          <div className="w-80 rounded-xl border border-line/15 bg-surface-muted p-4 shadow-2xl">
            <h4 className="text-xs font-bold text-ink mb-2">新建空白文件</h4>
            <input
              type="text"
              autoFocus
              placeholder="文件名称 (如 script.sh)"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFileName.trim()) {
                  createRemoteFile(connId, newFileName.trim());
                  setNewFileModalOpen(false);
                }
                if (e.key === "Escape") setNewFileModalOpen(false);
              }}
              className="w-full px-2.5 py-1.5 bg-surface-muted border border-line/15 rounded text-xs text-ink mb-3 outline-none focus:border-accent/30 font-mono"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewFileModalOpen(false)}
                className="px-3 py-1 rounded bg-surface text-xs text-ink-secondary hover:text-ink"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (newFileName.trim()) {
                    createRemoteFile(connId, newFileName.trim());
                    setNewFileModalOpen(false);
                  }
                }}
                disabled={!newFileName.trim()}
                className="px-3 py-1 rounded bg-action text-xs font-semibold text-white hover:bg-action/90 disabled:opacity-40"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名模态框 */}
      {renameModalOpen && renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4">
          <div className="w-80 rounded-xl border border-line/15 bg-surface-muted p-4 shadow-2xl">
            <h4 className="text-xs font-bold text-ink mb-2">重命名</h4>
            <input
              type="text"
              autoFocus
              value={newTargetName}
              onChange={(e) => setNewTargetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTargetName.trim()) {
                  renameRemoteEntry(connId, renameTarget.path, newTargetName.trim());
                  setRenameModalOpen(false);
                }
                if (e.key === "Escape") setRenameModalOpen(false);
              }}
              className="w-full px-2.5 py-1.5 bg-surface-muted border border-line/15 rounded text-xs text-ink mb-3 outline-none focus:border-accent/30 font-mono"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRenameModalOpen(false)}
                className="px-3 py-1 rounded bg-surface text-xs text-ink-secondary hover:text-ink"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (newTargetName.trim()) {
                    renameRemoteEntry(connId, renameTarget.path, newTargetName.trim());
                    setRenameModalOpen(false);
                  }
                }}
                disabled={!newTargetName.trim()}
                className="px-3 py-1 rounded bg-action text-xs font-semibold text-white hover:bg-action/90 disabled:opacity-40"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 属性详情模态框 */}
      {propertiesModalOpen && propertiesTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4">
          <div className="w-96 rounded-xl border border-line/15 bg-surface-muted p-5 shadow-2xl text-xs space-y-3 font-mono">
            <h4 className="text-sm font-bold text-ink font-sans border-b border-line/15 pb-2">
              文件/文件夹属性详情
            </h4>
            <div className="space-y-1.5 text-ink-secondary">
              <div>
                <span className="text-ink-secondary">名称: </span>
                <span className="text-ink font-bold">{propertiesTarget.name}</span>
              </div>
              <div className="break-all">
                <span className="text-ink-secondary">绝对路径: </span>
                <span>{propertiesTarget.path}</span>
              </div>
              <div>
                <span className="text-ink-secondary">类型: </span>
                <span>{propertiesTarget.file_type}</span>
              </div>
              <div>
                <span className="text-ink-secondary">尺寸: </span>
                <span>{propertiesTarget.size} 字节 ({formatSize(propertiesTarget.size)})</span>
              </div>
              <div>
                <span className="text-ink-secondary">权限: </span>
                <span>{formatPermissions(propertiesTarget.permissions)}</span>
              </div>
              <div>
                <span className="text-ink-secondary">所有者 (UID:GID): </span>
                <span>{propertiesTarget.uid ?? "-"} : {propertiesTarget.gid ?? "-"}</span>
              </div>
              <div>
                <span className="text-ink-secondary">最后修改时间: </span>
                <span>{formatDate(propertiesTarget.modified_at)}</span>
              </div>
              <div>
                <span className="text-ink-secondary">最后访问时间: </span>
                <span>{formatDate(propertiesTarget.accessed_at)}</span>
              </div>
            </div>
            <div className="flex justify-end pt-2 border-t border-line/15 font-sans">
              <button
                onClick={() => setPropertiesModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-surface text-xs text-ink-secondary hover:bg-surface hover:text-ink transition"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 远程文本编辑器模态框 */}
      <RemoteEditorModal />
    </div>
  );
};
