import { create } from "zustand";
import type { Snippet, SnippetInput } from "../types/ipc";
import {
  snippetCreate,
  snippetDelete,
  snippetList,
  snippetUpdate,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

let snippetGeneration = 0;

interface SnippetState {
  snippets: Snippet[];
  loading: boolean;
  error: string | null;
  activeGroupId: string | null;
  searchQuery: string;

  loadSnippets: (
    groupIdOrOptions?: string | { throwOnError?: boolean },
    options?: { throwOnError?: boolean }
  ) => Promise<void>;
  createSnippet: (input: SnippetInput) => Promise<Snippet>;
  updateSnippet: (id: string, input: SnippetInput) => Promise<Snippet>;
  deleteSnippet: (id: string) => Promise<void>;
  setActiveGroupId: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  loading: false,
  error: null,
  activeGroupId: null,
  searchQuery: "",

  loadSnippets: async (
    groupIdOrOptions?: string | { throwOnError?: boolean },
    options?: { throwOnError?: boolean }
  ) => {
    const groupId = typeof groupIdOrOptions === "string" ? groupIdOrOptions : undefined;
    const opts = typeof groupIdOrOptions === "object" && groupIdOrOptions !== null ? groupIdOrOptions : options;
    const generation = ++snippetGeneration;
    set({ loading: true, error: null });
    try {
      const list = await snippetList(groupId);
      const normalized = (list || []).map((snip) => ({
        ...snip,
        kind: snip.kind ?? "snippet",
        body: snip.body ?? null,
      }));
      if (generation === snippetGeneration) {
        set({ snippets: normalized, loading: false, error: null });
      }
    } catch (e: any) {
      console.warn("load snippets error", e);
      const friendly = formatFriendlyError(e);
      if (generation === snippetGeneration) {
        set({ loading: false, error: friendly });
      }
      if (opts?.throwOnError !== false) {
        throw e;
      }
    }
  },

  createSnippet: async (input: SnippetInput) => {
    const normalized: SnippetInput = {
      ...input,
      kind: input.kind ?? "snippet",
      body: input.body ?? null,
    };
    const snip = await snippetCreate(normalized);
    try {
      await get().loadSnippets(get().activeGroupId || undefined);
    } catch (e) {
      console.warn("createSnippet succeeded but reload failed:", e);
    }
    return snip;
  },

  updateSnippet: async (id: string, input: SnippetInput) => {
    const normalized: SnippetInput = {
      ...input,
      kind: input.kind ?? "snippet",
      body: input.body ?? null,
    };
    const snip = await snippetUpdate(id, normalized);
    try {
      await get().loadSnippets(get().activeGroupId || undefined);
    } catch (e) {
      console.warn("updateSnippet succeeded but reload failed:", e);
    }
    return snip;
  },

  deleteSnippet: async (id: string) => {
    await snippetDelete(id);
    try {
      await get().loadSnippets(get().activeGroupId || undefined);
    } catch (e) {
      console.warn("deleteSnippet succeeded but reload failed:", e);
    }
  },

  setActiveGroupId: (activeGroupId: string | null) => {
    set({ activeGroupId });
    void get()
      .loadSnippets(activeGroupId || undefined)
      .catch((e) => {
        console.warn("setActiveGroupId reload failed:", e);
      });
  },

  setSearchQuery: (searchQuery: string) => set({ searchQuery }),
}));
