import { create } from "zustand";
import type { Snippet, SnippetInput } from "../types/ipc";
import {
  snippetCreate,
  snippetDelete,
  snippetList,
  snippetUpdate,
} from "../lib/ipc";

interface SnippetState {
  snippets: Snippet[];
  loading: boolean;
  activeGroupId: string | null;
  searchQuery: string;

  loadSnippets: (groupId?: string) => Promise<void>;
  createSnippet: (input: SnippetInput) => Promise<Snippet>;
  updateSnippet: (id: string, input: SnippetInput) => Promise<Snippet>;
  deleteSnippet: (id: string) => Promise<void>;
  setActiveGroupId: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  loading: false,
  activeGroupId: null,
  searchQuery: "",

  loadSnippets: async (groupId?: string) => {
    set({ loading: true });
    try {
      const list = await snippetList(groupId);
      const normalized = (list || []).map((snip) => ({
        ...snip,
        kind: snip.kind ?? "snippet",
        body: snip.body ?? null,
      }));
      set({ snippets: normalized, loading: false });
    } catch (e) {
      console.warn("load snippets error", e);
      set({ loading: false });
    }
  },

  createSnippet: async (input: SnippetInput) => {
    const normalized: SnippetInput = {
      ...input,
      kind: input.kind ?? "snippet",
      body: input.body ?? null,
    };
    const snip = await snippetCreate(normalized);
    await get().loadSnippets(get().activeGroupId || undefined);
    return snip;
  },

  updateSnippet: async (id: string, input: SnippetInput) => {
    const normalized: SnippetInput = {
      ...input,
      kind: input.kind ?? "snippet",
      body: input.body ?? null,
    };
    const snip = await snippetUpdate(id, normalized);
    await get().loadSnippets(get().activeGroupId || undefined);
    return snip;
  },

  deleteSnippet: async (id: string) => {
    await snippetDelete(id);
    await get().loadSnippets(get().activeGroupId || undefined);
  },

  setActiveGroupId: (activeGroupId: string | null) => {
    set({ activeGroupId });
    get().loadSnippets(activeGroupId || undefined);
  },

  setSearchQuery: (searchQuery: string) => set({ searchQuery }),
}));
