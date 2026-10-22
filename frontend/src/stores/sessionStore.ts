import { create } from "zustand";
import type { Group, Session, SessionInput, SessionPatch } from "../types/ipc";
import {
  createGroup,
  createSession,
  deleteGroup,
  deleteSession,
  duplicateSession,
  listGroups,
  listSessions,
  renameGroup,
  updateSession,
} from "../lib/ipc";

interface SessionState {
  sessions: Session[];
  groups: Group[];
  selectedSessionId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;

  loadAll: () => Promise<void>;
  createSession: (input: SessionInput) => Promise<Session>;
  updateSession: (id: string, patch: SessionPatch) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  duplicateSession: (id: string) => Promise<Session>;
  createGroup: (name: string, parentId?: string | null) => Promise<Group>;
  renameGroup: (id: string, name: string) => Promise<Group>;
  deleteGroup: (id: string) => Promise<void>;
  selectSession: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  groups: [],
  selectedSessionId: null,
  searchQuery: "",
  isLoading: false,
  error: null,

  loadAll: async () => {
    set({ isLoading: true, error: null });
    try {
      const [sessions, groups] = await Promise.all([
        listSessions({ query: get().searchQuery || undefined }),
        listGroups(),
      ]);
      set({ sessions, groups, isLoading: false });
    } catch (err: any) {
      set({ error: err?.message || String(err), isLoading: false });
    }
  },

  createSession: async (input) => {
    const session = await createSession(input);
    await get().loadAll();
    return session;
  },

  updateSession: async (id, patch) => {
    const session = await updateSession(id, patch);
    await get().loadAll();
    return session;
  },

  deleteSession: async (id) => {
    await deleteSession(id);
    if (get().selectedSessionId === id) {
      set({ selectedSessionId: null });
    }
    await get().loadAll();
  },

  duplicateSession: async (id) => {
    const session = await duplicateSession(id);
    await get().loadAll();
    return session;
  },

  createGroup: async (name, parentId) => {
    const group = await createGroup(name, parentId);
    await get().loadAll();
    return group;
  },

  renameGroup: async (id, name) => {
    const group = await renameGroup(id, name);
    await get().loadAll();
    return group;
  },

  deleteGroup: async (id) => {
    await deleteGroup(id);
    await get().loadAll();
  },

  selectSession: (id) => set({ selectedSessionId: id }),
  setSearchQuery: (searchQuery) => {
    set({ searchQuery });
    get().loadAll();
  },
}));
