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

let statusGeneration = 0;

interface VaultState {
  status: VaultStatus | null;
  isLoading: boolean;
  error: string | null;
  checkStatus: (options?: { throwOnError?: boolean }) => Promise<void>;
  init: (masterPassword: string, rememberInKeychain?: boolean) => Promise<void>;
  unlock: (masterPassword?: string, useKeychain?: boolean) => Promise<void>;
  lock: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

export const useVaultStore = create<VaultState>((set) => ({
  status: null,
  isLoading: true,
  error: null,

  checkStatus: async (options?: { throwOnError?: boolean }) => {
    const generation = ++statusGeneration;
    set({ isLoading: true, error: null });
    try {
      const status = await getVaultStatus();
      if (generation === statusGeneration) set({ status, isLoading: false, error: null });
    } catch (err: any) {
      const friendly = formatFriendlyError(err);
      if (generation === statusGeneration) set({ error: friendly, isLoading: false });
      if (options?.throwOnError) {
        throw err;
      }
    }
  },

  init: async (masterPassword, rememberInKeychain = false) => {
    statusGeneration++;
    set({ isLoading: true, error: null });
    try {
      const status = await initVault(masterPassword, rememberInKeychain);
      statusGeneration++;
      set({ status, isLoading: false });
    } catch (err: any) {
      statusGeneration++;
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },

  unlock: async (masterPassword, useKeychain = false) => {
    statusGeneration++;
    set({ isLoading: true, error: null });
    try {
      const status = await unlockVault(masterPassword, useKeychain);
      statusGeneration++;
      set({ status, isLoading: false });
    } catch (err: any) {
      statusGeneration++;
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },

  lock: async () => {
    statusGeneration++;
    set({ isLoading: true, error: null });
    try {
      const status = await lockVault();
      statusGeneration++;
      set({ status, isLoading: false });
    } catch (err: any) {
      statusGeneration++;
      set({ error: formatFriendlyError(err), isLoading: false });
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    statusGeneration++;
    set({ isLoading: true, error: null });
    try {
      const status = await changeVaultPassword(oldPassword, newPassword);
      statusGeneration++;
      set({ status, isLoading: false });
    } catch (err: any) {
      statusGeneration++;
      set({ error: formatFriendlyError(err), isLoading: false });
      throw err;
    }
  },
}));
