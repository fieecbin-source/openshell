import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { syncListConflicts, syncResolveConflict } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { useSessionStore } from "./sessionStore";
import { useVaultStore } from "./vaultStore";
import { useSnippetStore } from "./snippetStore";

const refreshSyncedViews = async () => {
  await Promise.all([
    useSessionStore.getState().loadAll(),
    useVaultStore.getState().checkStatus(),
    useSnippetStore.getState().loadSnippets(),
  ]);
};

export interface SyncConfig {
  server_url: string | null;
  account_id: string | null;
  device_id: string;
  auto_sync: boolean;
  last_sync_at: number | null;
  last_error: string | null;
  conflict_count: number;
  is_logged_in: boolean;
}

export interface SyncConflict {
  id: string;
  record_id: string;
  record_type: string;
  created_at: number;
  has_local_snapshot: boolean;
}

export interface SyncResult {
  pushed_count: number;
  pulled_count: number;
  conflict_count: number;
  head_seq: number;
}

export interface UpdateManifest {
  manifest_version: number;
  target: string;
  channel: string;
  version: string;
  mandatory: boolean;
  notes_url?: string;
}

interface SyncStoreState {
  config: SyncConfig | null;
  conflicts: SyncConflict[];
  resolvingConflictId: string | null;
  syncing: boolean;
  modalOpen: boolean;
  lastResult: SyncResult | null;
  updateInfo: UpdateManifest | null;
  error: string | null;
  refreshError: string | null;
  refreshingViews: boolean;

  setModalOpen: (open: boolean) => void;
  loadConfig: () => Promise<void>;
  loadConflicts: () => Promise<SyncConflict[]>;
  resolveConflict: (conflictId: string, choice: "local" | "remote") => Promise<void>;
  retryRefreshViews: () => Promise<void>;
  saveConfig: (serverUrl: string | null, autoSync: boolean) => Promise<void>;
  register: (serverUrl: string, email: string, pass: string, invite?: string) => Promise<void>;
  login: (serverUrl: string, email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  clearLocalSyncData: () => Promise<void>;
  syncNow: () => Promise<SyncResult>;
  checkUpdates: () => Promise<UpdateManifest | null>;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  config: null,
  conflicts: [],
  resolvingConflictId: null,
  syncing: false,
  modalOpen: false,
  lastResult: null,
  updateInfo: null,
  error: null,
  refreshError: null,
  refreshingViews: false,

  setModalOpen: (open) => set({ modalOpen: open, error: null, refreshError: null }),

  loadConfig: async () => {
    try {
      const cfg = await invoke<SyncConfig>("sync_get_config");
      set({ config: cfg });
      if (cfg && cfg.conflict_count > 0) {
        void get().loadConflicts().catch(() => { });
      }
    } catch (err: any) {
      console.error("Failed to load sync config:", err);
    }
  },

  loadConflicts: async () => {
    try {
      const list = await syncListConflicts();
      set({ conflicts: list || [], error: null });
      return list || [];
    } catch (err: any) {
      console.warn("Failed to load sync conflicts:", err);
      set({ error: formatFriendlyError(err) });
      throw err;
    }
  },

  resolveConflict: async (conflictId: string, choice: "local" | "remote") => {
    const { resolvingConflictId } = get();
    if (resolvingConflictId) return; // 执行中防重复
    set({ resolvingConflictId: conflictId, error: null, refreshError: null });
    try {
      await syncResolveConflict(conflictId, choice);
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    } finally {
      set({ resolvingConflictId: null });
    }

    try {
      await get().loadConflicts();
      await get().loadConfig();
      await refreshSyncedViews();
    } catch (refreshErr: any) {
      console.warn("Sync conflict resolved but view refresh failed:", refreshErr);
      set({ refreshError: formatFriendlyError(refreshErr) });
    }
  },

  retryRefreshViews: async () => {
    set({ refreshingViews: true });
    try {
      await get().loadConflicts();
      await get().loadConfig();
      await refreshSyncedViews();
      set({ refreshError: null });
    } catch (refreshErr: any) {
      console.warn("Retry view refresh failed:", refreshErr);
      set({ refreshError: formatFriendlyError(refreshErr) });
      throw refreshErr;
    } finally {
      set({ refreshingViews: false });
    }
  },

  saveConfig: async (serverUrl, autoSync) => {
    try {
      await invoke("sync_save_config", { serverUrl, autoSync });
      await get().loadConfig();
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    }
  },

  register: async (serverUrl, email, password, inviteCode) => {
    set({ syncing: true, error: null });
    try {
      await invoke("sync_register", {
        serverUrl,
        email,
        password,
        inviteCode: inviteCode || null,
      });
      await get().loadConfig();
      await refreshSyncedViews();
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  login: async (serverUrl, email, password) => {
    set({ syncing: true, error: null });
    try {
      await invoke("sync_login", { serverUrl, email, password });
      await get().loadConfig();
      await refreshSyncedViews();
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  logout: async () => {
    try {
      await invoke("sync_logout");
      await get().loadConfig();
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    }
  },

  clearLocalSyncData: async () => {
    try {
      await invoke("sync_logout");
      set({ lastResult: null, error: null });
      await get().loadConfig();
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    }
  },

  syncNow: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await invoke<SyncResult>("sync_now");
      set({ lastResult: result });
      await get().loadConfig();
      await refreshSyncedViews();
      return result;
    } catch (err: any) {
      set({ error: formatFriendlyError(err) });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  checkUpdates: async () => {
    try {
      const manifest = await invoke<UpdateManifest | null>("sync_check_updates");
      set({ updateInfo: manifest });
      return manifest;
    } catch (err: any) {
      console.warn("Check updates failed:", err);
      return null;
    }
  },
}));
