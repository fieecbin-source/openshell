import { create } from "zustand";
import type { VaultStatus } from "../types/ipc";
import {
  changeVaultPassword,
  getVaultStatus,
  initVault,
  lockVault,
  unlockVault,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

interface VaultState {
  status: VaultStatus | null;
  isLoading: boolean;
  error: string | null;
  checkStatus: () => Promise<void>;
  init: (masterPassword: string, rememberInKeychain?: boolean) => Promise<void>;
  unlock: (masterPassword?: string, useKeychain?: boolean) => Promise<void>;
  lock: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

export const useVaultStore = create<VaultState>((set) => ({
  status: null,
  isLoading: true,
  error: null,

  checkStatus: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await getVaultStatus();
      set({ status, isLoading: false });
    } catch (err: any) {
      set({ error: formatFriendlyError(err), isLoading: false });
    }
  },

  init: async (masterPassword, rememberInKeychain = false) => {
    set({ isLoading: true, error: null });
    try {
      const status = await initVault(masterPassword, rememberInKeychain);
      set({ status, isLoading: false });
    } catch (err: any) {
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },

  unlock: async (masterPassword, useKeychain = false) => {
    set({ isLoading: true, error: null });
    try {
      const status = await unlockVault(masterPassword, useKeychain);
      set({ status, isLoading: false });
    } catch (err: any) {
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },

  lock: async () => {
    set({ isLoading: true, error: null });
    try {
      const status = await lockVault();
      set({ status, isLoading: false });
    } catch (err: any) {
      set({ error: formatFriendlyError(err), isLoading: false });
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    set({ isLoading: true, error: null });
    try {
      const status = await changeVaultPassword(oldPassword, newPassword);
      set({ status, isLoading: false });
    } catch (err: any) {
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },
}));
