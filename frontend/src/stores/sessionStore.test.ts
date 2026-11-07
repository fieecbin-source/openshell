import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSessionStore } from "./sessionStore";
import * as ipcModule from "../lib/ipc";
import type { Session, Group } from "../types/ipc";

vi.mock("../lib/ipc", () => ({
  listSessions: vi.fn(),
  listGroups: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  duplicateSession: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
}));

const mockSession: Session = {
  id: "sess_1",
  group_id: null,
  name: "Server 1",
  protocol: "ssh",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  auth_method: "password",
  credential_id: null,
  ssh_key_id: null,
  host_key_policy: "accept_new",
  proxy_jump_json: null,
  proxy_id: null,
  terminal_profile_id: null,
  encoding: "utf-8",
  startup_command: null,
  working_dir: null,
  keepalive_sec: 0,
  keepalive_max_miss: 0,
  auto_reconnect: false,
  reconnect_max: 0,
  compression: false,
  agent_forwarding: false,
  x11_forwarding: false,
  tags_json: null,
  favorite: false,
  color: null,
  icon_key: null,
  notes: null,
  protocol_options_json: null,
  last_used_at: null,
  last_result: null,
  use_count: 0,
  sort_order: 0,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
};

const mockGroup: Group = {
  id: "grp_1",
  parent_id: null,
  name: "Production",
  kind: "session",
  sort_order: 0,
  color: null,
  icon_key: null,
  expanded: true,
  notes: null,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
};

describe("sessionStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      groups: [],
      selectedSessionId: null,
      searchQuery: "",
      isLoading: false,
      error: null,
    });
  });

  it.each(["resolve", "reject"])("ignores an older read's late %s after a successful retry", async (outcome) => {
    let resolve!: (value: Session[]) => void;
    let reject!: (reason: Error) => void;
    const oldRead = new Promise<Session[]>((yes, no) => { resolve = yes; reject = no; });
    vi.mocked(ipcModule.listSessions).mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce([{ ...mockSession, name: "fresh" }]);
    vi.mocked(ipcModule.listGroups).mockResolvedValue([mockGroup]);
    const pending = useSessionStore.getState().loadAll({ throwOnError: true }).catch(() => {});
    await useSessionStore.getState().loadAll({ throwOnError: true });
    if (outcome === "resolve") resolve([mockSession]);
    else reject(new Error("obsolete read failure"));
    await pending;
    expect(useSessionStore.getState().sessions[0].name).toBe("fresh");
    expect(useSessionStore.getState().error).toBeNull();
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it("loads sessions and groups successfully and clears error", async () => {
    vi.mocked(ipcModule.listSessions).mockResolvedValueOnce([mockSession]);
    vi.mocked(ipcModule.listGroups).mockResolvedValueOnce([mockGroup]);

    useSessionStore.setState({ error: "Previous error" });

    await useSessionStore.getState().loadAll();

    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([mockSession]);
    expect(state.groups).toEqual([mockGroup]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("preserves existing sessions and groups when listSessions fails, recording friendly error", async () => {
    useSessionStore.setState({
      sessions: [mockSession],
      groups: [mockGroup],
    });

    vi.mocked(ipcModule.listSessions).mockRejectedValueOnce(new Error("Database locked"));
    vi.mocked(ipcModule.listGroups).mockResolvedValueOnce([]);

    // Default call should resolve without throwing to protect top-level lifecycle
    await expect(useSessionStore.getState().loadAll()).resolves.toBeUndefined();

    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([mockSession]);
    expect(state.groups).toEqual([mockGroup]);
    expect(state.error).toContain("Database locked");
    expect(state.isLoading).toBe(false);
  });

  it("re-throws error when throwOnError is true on listSessions failure", async () => {
    vi.mocked(ipcModule.listSessions).mockRejectedValueOnce(new Error("Network timeout"));
    vi.mocked(ipcModule.listGroups).mockResolvedValueOnce([]);

    await expect(
      useSessionStore.getState().loadAll({ throwOnError: true })
    ).rejects.toThrow("Network timeout");

    expect(useSessionStore.getState().error).toContain("连接超时");
  });

  it("completes createSession mutation even if subsequent loadAll reload fails", async () => {
    const createdSession: Session = { ...mockSession, id: "sess_created" };
    vi.mocked(ipcModule.createSession).mockResolvedValueOnce(createdSession);
    vi.mocked(ipcModule.listSessions).mockRejectedValueOnce(new Error("IPC read error during reload"));
    vi.mocked(ipcModule.listGroups).mockResolvedValueOnce([]);

    const result = await useSessionStore.getState().createSession({
      name: "New Server",
      protocol: "ssh",
      host: "1.2.3.4",
      port: 22,
      username: "user",
    });

    expect(result).toEqual(createdSession);
    expect(ipcModule.createSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().error).toContain("IPC read error during reload");
  });

  it("handles deleteSession safely without crashing if reload fails", async () => {
    useSessionStore.setState({
      sessions: [mockSession],
      selectedSessionId: "sess_1",
    });
    vi.mocked(ipcModule.deleteSession).mockResolvedValueOnce(undefined);
    vi.mocked(ipcModule.listSessions).mockRejectedValueOnce(new Error("Reload failure"));
    vi.mocked(ipcModule.listGroups).mockResolvedValueOnce([]);

    await expect(useSessionStore.getState().deleteSession("sess_1")).resolves.toBeUndefined();

    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(useSessionStore.getState().error).toContain("Reload failure");
  });
});
