import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as ipc from "./ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));

beforeEach(() => vi.mocked(invoke).mockReset());

describe("Task 4 shared IPC contracts", () => {
  it("passes the same transfer ID to resume and propagates failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("closed"));
    await expect(ipc.sftpResumeTransfer("transfer-1")).rejects.toThrow("closed");
    expect(invoke).toHaveBeenCalledWith("sftp_resume_transfer", { taskId: "transfer-1" });
  });

  it("lists and resolves conflict metadata without swallowing errors", async () => {
    const conflicts = [{ id: "conflict", record_id: "record", record_type: "session", created_at: 1, has_local_snapshot: true }];
    vi.mocked(invoke).mockResolvedValueOnce(conflicts);
    expect(await ipc.syncListConflicts()).toEqual(conflicts);
    expect(invoke).toHaveBeenLastCalledWith("sync_list_conflicts");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("locked"));
    await expect(ipc.syncResolveConflict("conflict", "local")).rejects.toThrow("locked");
    expect(invoke).toHaveBeenLastCalledWith("sync_resolve_conflict", { conflictId: "conflict", choice: "local" });
  });

  it("binds commit and discard to the preview token", async () => {
    await ipc.importerCommit([], "preview-1");
    expect(invoke).toHaveBeenLastCalledWith("importer_commit", { candidates: [], archiveToken: "preview-1" });
    await ipc.importerDiscardPreview("preview-1");
    expect(invoke).toHaveBeenLastCalledWith("importer_discard_preview", { archiveToken: "preview-1" });
  });

  it("queries and closes the requested RDP launch instance", async () => {
    await ipc.rdpGetStatus("launch-1");
    expect(invoke).toHaveBeenLastCalledWith("rdp_get_status", { launchId: "launch-1" });
    await ipc.rdpClose("launch-1");
    expect(invoke).toHaveBeenLastCalledWith("rdp_close", { launchId: "launch-1" });
  });
});
