import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSnippetStore } from "./snippetStore";
import * as ipcModule from "../lib/ipc";
import type { Snippet } from "../types/ipc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const currentSnippet: Snippet = {
  id: "current", group_id: "current-group", name: "Current snippet", kind: "snippet", body: "echo current",
  shortcut: null, send_mode: "insert", sort_order: 0, created_at: 1, updated_at: 1, deleted_at: null,
};

vi.mock("../lib/ipc", () => ({
  snippetCreate: vi.fn(),
  snippetUpdate: vi.fn(),
  snippetDelete: vi.fn(),
  snippetList: vi.fn(),
}));

describe("snippetStore and Snippet logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipcModule.snippetList).mockReset();
    useSnippetStore.setState({
      snippets: [],
      loading: false,
      activeGroupId: null,
      searchQuery: "",
      error: null,
    });
  });

  it("should extract placeholders with default values", () => {
    const template = "docker logs -f --tail ${LINES:-100} ${CONTAINER_NAME}";
    const regex = /\$\{([a-zA-Z0-9_]+)(?::-(.*?))?\}/g;
    const matches: { name: string; defaultValue: string }[] = [];

    let match;
    while ((match = regex.exec(template)) !== null) {
      matches.push({ name: match[1], defaultValue: match[2] || "" });
    }

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ name: "LINES", defaultValue: "100" });
    expect(matches[1]).toEqual({ name: "CONTAINER_NAME", defaultValue: "" });
  });

  it("should replace placeholders with user parameters", () => {
    let template = "curl -X POST http://${HOST:-localhost}:${PORT:-8080}/api";
    const params = [
      { name: "HOST", value: "192.168.1.50" },
      { name: "PORT", value: "9000" },
    ];

    for (const p of params) {
      const regex = new RegExp(`\\$\\{${p.name}(?::-.*?)?\\}`, "g");
      template = template.replace(regex, p.value);
    }

    expect(template).toBe("curl -X POST http://192.168.1.50:9000/api");
  });

  it("createSnippet should pass body and kind: snippet without losing multiline body", async () => {
    const multilineBody = "echo 'line 1'\necho 'line 2'\nps aux | grep node";
    const mockCreated = {
      id: "snip_1",
      group_id: null,
      name: "Check Node",
      kind: "snippet" as const,
      body: multilineBody,
      shortcut: null,
      send_mode: "execute" as const,
      sort_order: 0,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    };

    vi.mocked(ipcModule.snippetCreate).mockResolvedValueOnce(mockCreated);
    vi.mocked(ipcModule.snippetList).mockResolvedValueOnce([mockCreated]);

    const created = await useSnippetStore.getState().createSnippet({
      name: "Check Node",
      body: multilineBody,
      send_mode: "execute",
    });

    expect(ipcModule.snippetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Check Node",
        kind: "snippet",
        body: multilineBody,
      })
    );
    expect(created.body).toBe(multilineBody);
    expect(useSnippetStore.getState().snippets).toHaveLength(1);
    expect(useSnippetStore.getState().snippets[0].body).toBe(multilineBody);
  });

  it("updateSnippet should preserve body and kind", async () => {
    const updatedBody = "docker restart my_app\ndocker logs -f my_app";
    const mockUpdated = {
      id: "snip_1",
      group_id: null,
      name: "Restart App",
      kind: "snippet" as const,
      body: updatedBody,
      shortcut: null,
      send_mode: "insert" as const,
      sort_order: 0,
      created_at: 1,
      updated_at: 2,
      deleted_at: null,
    };

    vi.mocked(ipcModule.snippetUpdate).mockResolvedValueOnce(mockUpdated);
    vi.mocked(ipcModule.snippetList).mockResolvedValueOnce([mockUpdated]);

    const updated = await useSnippetStore.getState().updateSnippet("snip_1", {
      name: "Restart App",
      body: updatedBody,
      kind: "snippet",
      send_mode: "insert",
    });

    expect(ipcModule.snippetUpdate).toHaveBeenCalledWith(
      "snip_1",
      expect.objectContaining({
        name: "Restart App",
        kind: "snippet",
        body: updatedBody,
      })
    );
    expect(updated.body).toBe(updatedBody);
  });

  it("loadSnippets normalizes body and kind strictly on read", async () => {
    const item = {
      id: "snip_item",
      group_id: null,
      name: "Standard Snip",
      kind: "snippet" as const,
      body: "ls -la",
      shortcut: null,
      send_mode: "insert" as const,
      sort_order: 0,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    };

    vi.mocked(ipcModule.snippetList).mockResolvedValueOnce([item]);

    await useSnippetStore.getState().loadSnippets();

    const snips = useSnippetStore.getState().snippets;
    expect(snips).toHaveLength(1);
    expect(snips[0].body).toBe("ls -la");
    expect(snips[0].kind).toBe("snippet");
    expect(snips[0].deleted_at).toBeNull();
  });

  it("verifies execution mode appends newline and insertion mode does not", () => {
    const formatCommand = (cmd: string, mode: "execute" | "insert") =>
      mode === "execute" ? `${cmd}\n` : cmd;

    expect(formatCommand("uptime", "execute")).toBe("uptime\n");
    expect(formatCommand("uptime", "insert")).toBe("uptime");
    expect(formatCommand("echo 123", "insert")).not.toContain("\n");
  });

  it("loadSnippets rejects when snippetList IPC fails, keeping existing snippets and resetting loading", async () => {
    const existing = [
      {
        id: "snip_existing",
        group_id: null,
        name: "Existing Snip",
        kind: "snippet" as const,
        body: "echo keep_me",
        shortcut: null,
        send_mode: "insert" as const,
        sort_order: 0,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    ];
    useSnippetStore.setState({ snippets: existing, loading: false });

    vi.mocked(ipcModule.snippetList).mockRejectedValueOnce(new Error("IPC snippet list failure"));

    await expect(useSnippetStore.getState().loadSnippets()).rejects.toThrow(
      "IPC snippet list failure"
    );

    // snippets must not be cleared on failure
    expect(useSnippetStore.getState().snippets).toEqual(existing);
    expect(useSnippetStore.getState().loading).toBe(false);
  });

  it("loadSnippets: slow read A resolving late after read B succeeds must not overwrite B's data (generation check)", async () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const defA = deferred<any[]>();
    const defB = deferred<any[]>();

    vi.mocked(ipcModule.snippetList)
      .mockReturnValueOnce(defA.promise)
      .mockReturnValueOnce(defB.promise);

    // Call A (slow)
    const promiseA = useSnippetStore.getState().loadSnippets();

    // Call B (faster)
    const promiseB = useSnippetStore.getState().loadSnippets();

    // B resolves with new snippets
    const snipB = [{ id: "snip_B", name: "Snippet B", kind: "snippet" as const, body: "cmd B", shortcut: null, send_mode: "execute" as const, sort_order: 0, created_at: 2, updated_at: 2, deleted_at: null }];
    defB.resolve(snipB);
    await promiseB;

    expect(useSnippetStore.getState().snippets).toEqual(snipB);

    // A resolves late with old snippets
    const snipA = [{ id: "snip_A", name: "Snippet A", kind: "snippet" as const, body: "cmd A", shortcut: null, send_mode: "execute" as const, sort_order: 0, created_at: 1, updated_at: 1, deleted_at: null }];
    defA.resolve(snipA);
    await promiseA;

    // A must NOT overwrite B's data!
    expect(useSnippetStore.getState().snippets).toEqual(snipB);
  });

  it.each([
    ["resolve", "pending"], ["reject", "pending"],
    ["resolve", "finished"], ["reject", "finished"],
  ] as const)("keeps a sibling failure and retry owned when old IPC %s arrives with retry %s", async (outcome, retryStage) => {
    const older = deferred<Snippet[]>();
    const retry = deferred<Snippet[]>();
    useSnippetStore.setState({ snippets: [currentSnippet] });
    vi.mocked(ipcModule.snippetList)
      .mockReturnValueOnce(older.promise)
      .mockRejectedValueOnce({ code: "IO", message: "failed to read current snippets" })
      .mockReturnValueOnce(retry.promise);
    const olderRead = useSnippetStore.getState().loadSnippets("old-group").catch((error) => error);
    await expect(useSnippetStore.getState().loadSnippets("current-group")).rejects.toEqual({ code: "IO", message: "failed to read current snippets" });
    expect(useSnippetStore.getState().error).toBe("本地文件读写失败，请检查磁盘空间与文件权限。");
    expect(useSnippetStore.getState().loading).toBe(false);
    expect(useSnippetStore.getState().snippets).toEqual([currentSnippet]);
    const retried = useSnippetStore.getState().loadSnippets("current-group");
    if (retryStage === "finished") { retry.resolve([currentSnippet]); await retried; }
    if (outcome === "resolve") older.resolve([{ ...currentSnippet, id: "obsolete", name: "Obsolete" }]);
    else older.reject({ code: "TIMEOUT", message: "failed to read old snippets" });
    await olderRead;
    expect(useSnippetStore.getState().snippets).toEqual([currentSnippet]);
    expect(useSnippetStore.getState().error).toBeNull();
    expect(useSnippetStore.getState().loading).toBe(retryStage === "pending");
    if (retryStage === "pending") { retry.resolve([currentSnippet]); await retried; }
    expect(useSnippetStore.getState().loading).toBe(false);
    expect(useSnippetStore.getState().error).toBeNull();
    expect(ipcModule.snippetList).toHaveBeenNthCalledWith(3, "current-group");
  });
});
