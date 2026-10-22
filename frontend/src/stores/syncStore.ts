import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
  syncing: boolean;
  modalOpen: boolean;
  lastResult: SyncResult | null;
  updateInfo: UpdateManifest | null;
  error: string | null;

  setModalOpen: (open: boolean) => void;
  loadConfig: () => Promise<void>;
  saveConfig: (serverUrl: string | null, autoSync: boolean) => Promise<void>;
  register: (serverUrl: string, email: string, pass: string, invite?: string) => Promise<void>;
  login: (serverUrl: string, email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  syncNow: () => Promise<SyncResult>;
  checkUpdates: () => Promise<UpdateManifest | null>;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  config: null,
  syncing: false,
  modalOpen: false,
  lastResult: null,
  updateInfo: null,
  error: null,

  setModalOpen: (open) => set({ modalOpen: open, error: null }),

  loadConfig: async () => {
    try {
      const cfg = await invoke<SyncConfig>("sync_get_config");
      set({ config: cfg });
    } catch (err: any) {
      console.error("Failed to load sync config:", err);
    }
  },

  saveConfig: async (serverUrl, autoSync) => {
    try {
      await invoke("sync_save_config", { serverUrl, autoSync });
      await get().loadConfig();
    } catch (err: any) {
      set({ error: err?.message || String(err) });
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
    } catch (err: any) {
      set({ error: err?.message || String(err) });
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
    } catch (err: any) {
      set({ error: err?.message || String(err) });
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
      set({ error: err?.message || String(err) });
      throw err;
    }
  },

  syncNow: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await invoke<SyncResult>("sync_now");
      set({ lastResult: result });
      await get().loadConfig();
      return result;
    } catch (err: any) {
      set({ error: err?.message || String(err) });
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
