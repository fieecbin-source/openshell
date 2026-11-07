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
let syncBusyGeneration = 0;
let resolveBusyGeneration = 0;
let lifecycleGeneration = 0;
let conflictReadError: string | null = null;

// All refresh entry points share their visible error; each busy flag owns its release.
const startSyncFlow = () => {
  configGeneration++;
  conflictsGeneration++;
  return ++syncFlowGeneration;
};

const refreshSyncedViews = async () => {
  const results = await Promise.allSettled([
    useSessionStore.getState().loadAll({ throwOnError: true }),
    useVaultStore.getState().checkStatus({ throwOnError: true }),
    useSnippetStore.getState().loadSnippets({ throwOnError: true }),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
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
    let cfg: SyncConfig;
    try {
      cfg = await invoke<SyncConfig>("sync_get_config");
    } catch (err: any) {
      console.error("Failed to load sync config:", err);
      const friendly = formatFriendlyError(err);
      if (gen === configGeneration) {
        set({ configError: friendly });
      }
      if (options?.throwOnError) {
        throw err;
      }
      return;
    }
    if (gen !== configGeneration) return;
    set({ config: cfg, configError: null });
    if (cfg && cfg.conflict_count > 0) {
      // Conflict failures belong to the conflict notice, not configError.
      await get().loadConflicts({ throwOnError: options?.throwOnError === true });
    }
  },

  loadConflicts: async (options?: { throwOnError?: boolean }) => {
    const gen = ++conflictsGeneration;
    const configGen = configGeneration;
    try {
      const list = await syncListConflicts();
      if (gen === conflictsGeneration && configGen === configGeneration) {
        set({ conflicts: list || [], ...(conflictReadError !== null && get().error === conflictReadError ? { error: null } : {}) });
        conflictReadError = null;
      }
      return list || [];
    } catch (err: any) {
      console.warn("Failed to load sync conflicts:", err);
      const friendly = formatFriendlyError(err);
      if (gen === conflictsGeneration && configGen === configGeneration) {
        if (get().error === null || get().error === conflictReadError) {
          conflictReadError = friendly;
          set({ error: friendly });
        }
      }
      if (options?.throwOnError !== false) {
        throw err;
      }
      return [];
    }
  },

  resolveConflict: async (conflictId: string, choice: "local" | "remote") => {
    const { resolvingConflictId, syncing } = get();
    if (resolvingConflictId || syncing) return;
    const busyGen = ++resolveBusyGeneration;
    const flowGen = startSyncFlow();
    const lifecycle = lifecycleGeneration;
    conflictReadError = null;
    set({ resolvingConflictId: conflictId, error: null, refreshError: null });
    try {
      try {
        await syncResolveConflict(conflictId, choice);
      } catch (err: any) {
        if (lifecycle === lifecycleGeneration && busyGen === resolveBusyGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }
      try {
        if (flowGen === syncFlowGeneration) await get().loadConflicts({ throwOnError: true });
        if (flowGen === syncFlowGeneration) await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Sync conflict resolved but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) set({ refreshError: formatFriendlyError(refreshErr) });
      }
    } finally {
      if (busyGen === resolveBusyGeneration) set({ resolvingConflictId: null });
    }
  },

  retryRefreshViews: async () => {
    if (get().refreshingViews) return;
    const retryGen = ++refreshFlowGeneration;
    const flowGen = startSyncFlow();
    set({ refreshingViews: true });
    try {
      await get().loadConflicts({ throwOnError: true });
      if (flowGen !== syncFlowGeneration) return;
      await get().loadConfig({ throwOnError: true });
      if (flowGen !== syncFlowGeneration) return;
      await refreshSyncedViews();
      if (flowGen === syncFlowGeneration) {
        set({ refreshError: null });
      }
    } catch (refreshErr: any) {
      console.warn("Retry view refresh failed:", refreshErr);
      if (flowGen === syncFlowGeneration) {
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
    if (get().syncing || get().resolvingConflictId) return;
    const flowGen = startSyncFlow();
    const busyGen = ++syncBusyGeneration;
    const lifecycle = lifecycleGeneration;
    conflictReadError = null;
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
        if (lifecycle === lifecycleGeneration && busyGen === syncBusyGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        if (flowGen === syncFlowGeneration) await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Register succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
    } finally {
      if (busyGen === syncBusyGeneration) {
        set({ syncing: false });
      }
    }
  },

  login: async (serverUrl, email, password) => {
    if (get().syncing || get().resolvingConflictId) return;
    const flowGen = startSyncFlow();
    const busyGen = ++syncBusyGeneration;
    const lifecycle = lifecycleGeneration;
    conflictReadError = null;
    set({ syncing: true, error: null, refreshError: null });
    try {
      try {
        await invoke("sync_login", { serverUrl, email, password });
      } catch (err: any) {
        if (lifecycle === lifecycleGeneration && busyGen === syncBusyGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        if (flowGen === syncFlowGeneration) await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Login succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
    } finally {
      if (busyGen === syncBusyGeneration) {
        set({ syncing: false });
      }
    }
  },

  logout: async () => {
    const lifecycle = ++lifecycleGeneration;
    startSyncFlow();
    const busyGen = ++syncBusyGeneration;
    resolveBusyGeneration++;
    refreshFlowGeneration++;
    set({ syncing: true, resolvingConflictId: null, refreshingViews: false });
    try {
      await invoke("sync_logout");
      if (lifecycle !== lifecycleGeneration) return;
      startSyncFlow();
      conflictReadError = null;
      set({ config: get().config ? { ...get().config!, is_logged_in: false, account_id: null, conflict_count: 0 } : null,
        conflicts: [], lastResult: null, error: null, configError: null, refreshError: null });
      await get().loadConfig();
    } catch (err: any) {
      if (lifecycle === lifecycleGeneration) set({ error: formatFriendlyError(err) });
      throw err;
    } finally {
      if (busyGen === syncBusyGeneration) set({ syncing: false });
    }
  },

  clearLocalSyncData: async () => {
    await get().logout();
  },

  syncNow: async () => {
    if (get().syncing || get().resolvingConflictId) {
      return get().lastResult!;
    }
    const flowGen = startSyncFlow();
    const busyGen = ++syncBusyGeneration;
    const lifecycle = lifecycleGeneration;
    conflictReadError = null;
    set({ syncing: true, error: null, refreshError: null });
    let result: SyncResult;
    try {
      try {
        result = await invoke<SyncResult>("sync_now");
        if (lifecycle === lifecycleGeneration && busyGen === syncBusyGeneration) {
          set({ lastResult: result });
        }
      } catch (err: any) {
        if (lifecycle === lifecycleGeneration && busyGen === syncBusyGeneration) {
          set({ error: formatFriendlyError(err) });
        }
        throw err;
      }

      try {
        if (flowGen === syncFlowGeneration) await get().loadConfig({ throwOnError: true });
        await refreshSyncedViews();
      } catch (refreshErr: any) {
        console.warn("Sync succeeded but view refresh failed:", refreshErr);
        if (flowGen === syncFlowGeneration) {
          set({ refreshError: formatFriendlyError(refreshErr) });
        }
      }
      return result;
    } finally {
      if (busyGen === syncBusyGeneration) {
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
