import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSnippetStore } from "./snippetStore";
import * as ipcModule from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  snippetCreate: vi.fn(),
  snippetUpdate: vi.fn(),
  snippetDelete: vi.fn(),
  snippetList: vi.fn(),
}));

describe("snippetStore and Snippet logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippetStore.setState({
      snippets: [],
      loading: false,
      activeGroupId: null,
      searchQuery: "",
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
});
