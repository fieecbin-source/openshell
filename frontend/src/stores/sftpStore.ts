import { create } from "zustand";
import type { SftpFileEntry, TransferTask } from "../types/ipc";
import {
  localFsHome,
  localFsList,
  sftpCancelTransfer,
  sftpGetCwd,
  sftpListDir,
  sftpListTransfers,
  sftpMkdir,
  sftpPauseTransfer,
  sftpReadFile,
  sftpRemoveDir,
  sftpRemoveFile,
  sftpRename,
  sftpSetPermissions,
  sftpStartTransfer,
  sftpWriteFile,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

export interface RemoteEditorState {
  open: boolean;
  connId: string;
  path: string;
  content: string;
  saving: boolean;
  error?: string;
}

export type SftpSortField = "name" | "size" | "mtime" | "permissions";

interface SftpState {
  remotePath: string;
  remoteFiles: SftpFileEntry[];
  remoteLoading: boolean;

  // 导航历史栈与展示过滤
  history: string[];
  historyIndex: number;
  showHidden: boolean;
  filterQuery: string;
  sortBy: SftpSortField;
  sortAsc: boolean;
  selectedPaths: string[];

  localPath: string;
  localFiles: SftpFileEntry[];
  localLoading: boolean;

  transfers: TransferTask[];
  transferQueueOpen: boolean;

  editor: RemoteEditorState;

  initLocal: () => Promise<void>;
  loadLocalFiles: (path?: string) => Promise<void>;
  loadRemoteFiles: (connId: string, path?: string, sessionId?: string, pushHistory?: boolean) => Promise<void>;
  refreshRemote: (connId: string) => Promise<void>;
  goBack: (connId: string, sessionId?: string) => Promise<void>;
  goForward: (connId: string, sessionId?: string) => Promise<void>;

  setShowHidden: (show: boolean) => void;
  setFilterQuery: (query: string) => void;
  setSort: (field: SftpSortField) => void;
  setSelectedPaths: (paths: string[]) => void;
  toggleSelectPath: (path: string, isRange?: boolean, allVisiblePaths?: string[]) => void;

  uploadFile: (connId: string, sessionId: string, localFilePath: string, remoteDir: string, resume?: boolean) => Promise<void>;
  downloadFile: (connId: string, sessionId: string, remoteFilePath: string, localDir: string, resume?: boolean) => Promise<void>;

  pollTransfers: () => Promise<void>;
  pauseTransfer: (id: string) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  setTransferQueueOpen: (open: boolean) => void;

  createRemoteDir: (connId: string, dirName: string) => Promise<void>;
  createRemoteFile: (connId: string, fileName: string) => Promise<void>;
  deleteRemoteEntry: (connId: string, entry: SftpFileEntry) => Promise<void>;
  renameRemoteEntry: (connId: string, oldPath: string, newName: string) => Promise<void>;
  chmodRemoteEntry: (
    connId: string,
    path: string,
    permissions: number,
    recursive?: boolean
  ) => Promise<void>;

  openEditor: (connId: string, path: string) => Promise<void>;
  updateEditorContent: (content: string) => void;
  saveEditor: () => Promise<void>;
  closeEditor: () => void;
}

export const useSftpStore = create<SftpState>((set, get) => ({
  remotePath: "/",
  remoteFiles: [],
  remoteLoading: false,

  history: ["/"],
  historyIndex: 0,
  showHidden: false,
  filterQuery: "",
  sortBy: "name",
  sortAsc: true,
  selectedPaths: [],

  localPath: "",
  localFiles: [],
  localLoading: false,

  transfers: [],
  transferQueueOpen: false,

  editor: {
    open: false,
    connId: "",
    path: "",
    content: "",
    saving: false,
  },

  initLocal: async () => {
    try {
      const home = await localFsHome();
      set({ localPath: home });
      await get().loadLocalFiles(home);
    } catch (e) {
      console.warn("failed to get local home", e);
    }
  },

  loadLocalFiles: async (targetPath?: string) => {
    const p = targetPath || get().localPath;
    if (!p) return;
    set({ localLoading: true });
    try {
      const files = await localFsList(p);
      set({ localPath: p, localFiles: files, localLoading: false });
    } catch (e) {
      console.warn("load local files error", e);
      set({ localLoading: false });
    }
  },

  loadRemoteFiles: async (connId: string, targetPath?: string, sessionId?: string, pushHistory = true) => {
    set({ remoteLoading: true });
    try {
      let path = targetPath || get().remotePath;
      if (!targetPath && sessionId) {
        const cwd = await sftpGetCwd(sessionId);
        if (cwd) path = cwd;
      }
      const files = await sftpListDir(connId, path);

      // 维护导航历史
      if (pushHistory) {
        const currentHist = get().history;
        const currentIndex = get().historyIndex;
        // 截断向前历史
        const newHist = currentHist.slice(0, currentIndex + 1);
        if (newHist[newHist.length - 1] !== path) {
          newHist.push(path);
          if (newHist.length > 50) newHist.shift();
        }
        set({
          history: newHist,
          historyIndex: newHist.length - 1,
        });
      }

      set({
        remotePath: path,
        remoteFiles: files,
        remoteLoading: false,
        selectedPaths: [], // 清空选区
      });
    } catch (e) {
      console.warn("load remote files error", e);
      set({ remoteLoading: false });
    }
  },

  refreshRemote: async (connId: string) => {
    await get().loadRemoteFiles(connId, get().remotePath, undefined, false);
  },

  goBack: async (connId: string, sessionId?: string) => {
    const { history, historyIndex } = get();
    if (historyIndex > 0) {
      const prevPath = history[historyIndex - 1];
      set({ historyIndex: historyIndex - 1 });
      await get().loadRemoteFiles(connId, prevPath, sessionId, false);
    }
  },

  goForward: async (connId: string, sessionId?: string) => {
    const { history, historyIndex } = get();
    if (historyIndex < history.length - 1) {
      const nextPath = history[historyIndex + 1];
      set({ historyIndex: historyIndex + 1 });
      await get().loadRemoteFiles(connId, nextPath, sessionId, false);
    }
  },

  setShowHidden: (show: boolean) => set({ showHidden: show }),
  setFilterQuery: (query: string) => set({ filterQuery: query }),
  setSort: (field: SftpSortField) => {
    const { sortBy, sortAsc } = get();
    if (sortBy === field) {
      set({ sortAsc: !sortAsc });
    } else {
      set({ sortBy: field, sortAsc: true });
    }
  },

  setSelectedPaths: (paths: string[]) => set({ selectedPaths: paths }),

  toggleSelectPath: (path: string, isRange = false, allVisiblePaths: string[] = []) => {
    const { selectedPaths } = get();
    if (isRange && selectedPaths.length > 0 && allVisiblePaths.length > 0) {
      const lastSelected = selectedPaths[selectedPaths.length - 1];
      const startIdx = allVisiblePaths.indexOf(lastSelected);
      const endIdx = allVisiblePaths.indexOf(path);
      if (startIdx !== -1 && endIdx !== -1) {
        const [low, high] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const range = allVisiblePaths.slice(low, high + 1);
        set({ selectedPaths: Array.from(new Set([...selectedPaths, ...range])) });
        return;
      }
    }

    if (selectedPaths.includes(path)) {
      set({ selectedPaths: selectedPaths.filter((p) => p !== path) });
    } else {
      set({ selectedPaths: [...selectedPaths, path] });
    }
  },

  uploadFile: async (connId: string, sessionId: string, localFilePath: string, remoteDir: string, resume = true) => {
    const filename = localFilePath.replace(/\\/g, "/").split("/").pop() || "uploaded_file";
    const remoteDest = remoteDir.endsWith("/") ? remoteDir + filename : `${remoteDir}/${filename}`;
    await sftpStartTransfer(connId, sessionId, "upload", localFilePath, remoteDest, resume);
    set({ transferQueueOpen: true });
    await get().pollTransfers();
  },

  downloadFile: async (connId: string, sessionId: string, remoteFilePath: string, localDir: string, resume = true) => {
    const filename = remoteFilePath.split("/").pop() || "downloaded_file";
    const localDest = localDir.endsWith("\\") || localDir.endsWith("/")
      ? `${localDir}${filename}`
      : `${localDir}/${filename}`;
    await sftpStartTransfer(connId, sessionId, "download", localDest, remoteFilePath, resume);
    set({ transferQueueOpen: true });
    await get().pollTransfers();
  },

  pollTransfers: async () => {
    try {
      const list = await sftpListTransfers();
      set({ transfers: list });
    } catch (e) {
      console.warn("poll transfers error", e);
    }
  },

  pauseTransfer: async (id: string) => {
    await sftpPauseTransfer(id);
    await get().pollTransfers();
  },

  cancelTransfer: async (id: string) => {
    await sftpCancelTransfer(id);
    await get().pollTransfers();
  },

  setTransferQueueOpen: (open: boolean) => set({ transferQueueOpen: open }),

  createRemoteDir: async (connId: string, dirName: string) => {
    const current = get().remotePath;
    const fullPath = current.endsWith("/") ? `${current}${dirName}` : `${current}/${dirName}`;
    await sftpMkdir(connId, fullPath);
    await get().refreshRemote(connId);
  },

  createRemoteFile: async (connId: string, fileName: string) => {
    const current = get().remotePath;
    const fullPath = current.endsWith("/") ? `${current}${fileName}` : `${current}/${fileName}`;
    await sftpWriteFile(connId, fullPath, []);
    await get().refreshRemote(connId);
  },

  chmodRemoteEntry: async (connId, path, permissions, recursive = false) => {
    await sftpSetPermissions(connId, path, permissions);
    if (!recursive) {
      await get().refreshRemote(connId);
      return;
    }

    const applyRecursive = async (target: string, depth = 0) => {
      // 防御异常深的目录树，避免无限递归
      if (depth >= 32) return;
      const entries = await sftpListDir(connId, target);
      for (const entry of entries) {
        if (entry.file_type === "symlink") continue;
        await sftpSetPermissions(connId, entry.path, permissions);
        if (entry.file_type === "directory") {
          await applyRecursive(entry.path, depth + 1);
        }
      }
    };

    await applyRecursive(path);
    await get().refreshRemote(connId);
  },

  deleteRemoteEntry: async (connId: string, entry: SftpFileEntry) => {
    if (entry.file_type === "directory") {
      await sftpRemoveDir(connId, entry.path);
    } else {
      await sftpRemoveFile(connId, entry.path);
    }
    await get().refreshRemote(connId);
  },

  renameRemoteEntry: async (connId: string, oldPath: string, newName: string) => {
    const dir = oldPath.substring(0, oldPath.lastIndexOf("/"));
    const newPath = dir ? `${dir}/${newName}` : `/${newName}`;
    await sftpRename(connId, oldPath, newPath);
    await get().refreshRemote(connId);
  },

  openEditor: async (connId: string, path: string) => {
    set({
      editor: {
        open: true,
        connId,
        path,
        content: "加载中...",
        saving: false,
      },
    });
    try {
      const bytes = await sftpReadFile(connId, path, 5 * 1024 * 1024);
      const text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
      set((state) => ({
        editor: { ...state.editor, content: text },
      }));
    } catch (e: any) {
      set((state) => ({
        editor: { ...state.editor, error: formatFriendlyError(e) || "无法读取文件内容" },
      }));
    }
  },

  updateEditorContent: (content: string) => {
    set((state) => ({
      editor: { ...state.editor, content },
    }));
  },

  saveEditor: async () => {
    const { connId, path, content } = get().editor;
    if (!connId || !path) return;
    set((state) => ({
      editor: { ...state.editor, saving: true, error: undefined },
    }));
    try {
      const bytes = new TextEncoder().encode(content);
      await sftpWriteFile(connId, path, bytes);
      set((state) => ({
        editor: { ...state.editor, saving: false },
      }));
      await get().refreshRemote(connId);
    } catch (e: any) {
      set((state) => ({
        editor: { ...state.editor, saving: false, error: formatFriendlyError(e) || "保存失败" },
      }));
    }
  },

  closeEditor: () => {
    set({
      editor: {
        open: false,
        connId: "",
        path: "",
        content: "",
        saving: false,
      },
    });
  },
}));
