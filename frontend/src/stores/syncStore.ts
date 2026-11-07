import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { syncListConflicts, syncResolveConflict } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { useSessionStore } from "./sessionStore";
import { useVaultStore } from "./vaultStore";
import { useSnippetStore } from "./snippetStore";

let configGeneration = 0;
let conflictsGeneration = 0;
let syncFlowGeneration = 0;
let refreshFlowGeneration = 0;

const refreshSyncedViews = async () => {
  await Promise.all([
    useSessionStore.getState().loadAll({ throwOnError: true }),
    useVaultStore.getState().checkStatus({ throwOnError: true }),
    useSnippetStore.getState().loadSnippets({ throwOnError: true }),
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
  configError: string | null;
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
  loadConfig: (options?: { throwOnError?: boolean }) => Promise<void>;
  loadConflicts: (options?: { throwOnError?: boolean }) => Promise<SyncConflict[]>;
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
  configError: null,
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

  loadConfig: async (options?: { throwOnError?: boolean }) => {
    const gen = ++configGeneration;
    try {
      const cfg = await invoke<SyncConfig>("sync_get_config");
      if (gen === configGeneration) {
        set({ config: cfg, configError: null });
      }
      if (cfg && cfg.conflict_count > 0) {
        await get().loadConflicts({ throwOnError: options?.throwOnError });
      }
    } catch (err: any) {
      console.error("Failed to load sync config:", err);
      const friendly = formatFriendlyError(err);
      if (gen === configGeneration) {
        set({ configError: friendly });
      }
      if (options?.throwOnError) {
        throw err;
      }
    }
  },

  loadConflicts: async (options?: { throwOnError?: boolean }) => {
    const gen = ++conflictsGeneration;
    try {
      const list = await syncListConflicts();
      if (gen === conflictsGeneration) {
        set({ conflicts: list || [], error: null });
      }
      return list || [];
    } catch (err: any) {
      console.warn("Failed to load sync conflicts:", err);
      const friendly = formatFriendlyError(err);
      if (gen === conflictsGeneration) {
        set({ error: friendly });
      }
      if (options?.throwOnError !== false) {
        throw err;
      }
      return [];
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

    const flowGen = ++syncFlowGeneration;
    try {
      await get().loadConflicts({ throwOnError: true });
      await get().loadConfig({ throwOnError: true });
      await refreshSyncedViews();
    } catch (refreshErr: any) {
      console.warn("Sync conflict resolved but view refresh failed:", refreshErr);
      if (flowGen === syncFlowGeneration) {
        set({ refreshError: formatFriendlyError(refreshErr) });
      }
    }
  },

  retryRefreshViews: async () => {
    const retryGen = ++refreshFlowGeneration;
    set({ refreshingViews: true });
    try {
      await get().loadConflicts({ throwOnError: true });
      await get().loadConfig({ throwOnError: true });
      await refreshSyncedViews();
      if (retryGen === refreshFlowGeneration) {
        set({ refreshError: null });
      }
    } catch (refreshErr: any) {
      console.warn("Retry view refresh failed:", refreshErr);
      if (retryGen === refreshFlowGeneration) {
        set({ refreshError: formatFriendlyError(refreshErr) });
      }
      throw refreshErr;
    } finally {
      if (retryGen === refreshFlowGeneration) {
        set({ refreshingViews: false });
      }
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
    const flowGen = ++syncFlowGeneration;
    set({ syncing: true, error: null, refreshError: null });
    try {
      try {
        await invoke("sync_register", {
          serverUrl,
          email,
          password,
          inviteCode: inviteCode || null,
        });
      } catch (err: any) {
        if (flowGen === syncFlowGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Register succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
    } finally {
      if (flowGen === syncFlowGeneration) {
        set({ syncing: false });
      }
    }
  },

  login: async (serverUrl, email, password) => {
    const flowGen = ++syncFlowGeneration;
    set({ syncing: true, error: null, refreshError: null });
    try {
      try {
        await invoke("sync_login", { serverUrl, email, password });
      } catch (err: any) {
        if (flowGen === syncFlowGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Login succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
    } finally {
      if (flowGen === syncFlowGeneration) {
        set({ syncing: false });
      }
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
    if (get().syncing) {
      return get().lastResult!;
    }
    const flowGen = ++syncFlowGeneration;
    set({ syncing: true, error: null, refreshError: null });
    let result: SyncResult;
    try {
      try {
        result = await invoke<SyncResult>("sync_now");
        if (flowGen === syncFlowGeneration) {
          set({ lastResult: result });
        }
      } catch (err: any) {
        if (flowGen === syncFlowGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Sync succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
      return result;
    } finally {
      if (flowGen === syncFlowGeneration) {
        set({ syncing: false });
      }
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
