import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  sftpStartTransfer: vi.fn(),
  sftpListTransfers: vi.fn(),
  sftpPauseTransfer: vi.fn(),
  sftpResumeTransfer: vi.fn(),
  sftpCancelTransfer: vi.fn(),
  sftpGetCwd: vi.fn(),
  sftpListDir: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpReadFile: vi.fn(),
  sftpRemoveDir: vi.fn(),
  sftpRemoveFile: vi.fn(),
  sftpRename: vi.fn(),
  sftpSetPermissions: vi.fn(),
  sftpWriteFile: vi.fn(),
  localFsHome: vi.fn(),
  localFsList: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useSftpStore } from "./sftpStore";
import {
  sftpStartTransfer,
  sftpListTransfers,
  sftpPauseTransfer,
  sftpResumeTransfer,
  sftpCancelTransfer,
} from "../lib/ipc";
import { invoke } from "@tauri-apps/api/core";

describe("sftpStore transfer operations (BUG-002, BUG-006, BUG-007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSftpStore.setState({
      transfers: [],
      transferQueueOpen: false,
    });
    vi.mocked(sftpListTransfers).mockResolvedValue([]);
    vi.mocked(sftpStartTransfer).mockResolvedValue("task_123");
    vi.mocked(sftpResumeTransfer).mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("uploadFile defaults to resume = false (safe overwrite, not length-based resume)", async () => {
    await useSftpStore.getState().uploadFile("conn1", "sess1", "/local/path/file.txt", "/remote/dest");

    expect(sftpStartTransfer).toHaveBeenCalledTimes(1);
    expect(sftpStartTransfer).toHaveBeenCalledWith(
      "conn1",
      "sess1",
      "upload",
      "/local/path/file.txt",
      "/remote/dest/file.txt",
      false // resume MUST be false by default
    );
  });

  it("downloadFile defaults to resume = false (safe overwrite, not length-based resume)", async () => {
    await useSftpStore.getState().downloadFile("conn1", "sess1", "/remote/dest/file.txt", "/local/path");

    expect(sftpStartTransfer).toHaveBeenCalledTimes(1);
    expect(sftpStartTransfer).toHaveBeenCalledWith(
      "conn1",
      "sess1",
      "download",
      "/local/path/file.txt",
      "/remote/dest/file.txt",
      false // resume MUST be false by default
    );
  });

  it("pauseTransfer calls sftpPauseTransfer with task id and refreshes", async () => {
    await useSftpStore.getState().pauseTransfer("task_123");
    expect(sftpPauseTransfer).toHaveBeenCalledWith("task_123");
    expect(sftpListTransfers).toHaveBeenCalled();
  });

  it("resumeTransfer calls sftpResumeTransfer with same taskId without starting a new task", async () => {
    await useSftpStore.getState().resumeTransfer("task_123");
    expect(sftpResumeTransfer).toHaveBeenCalledWith("task_123");
    expect(sftpListTransfers).toHaveBeenCalled();
  });

  it("resumeTransfer propagates error immediately when sftpResumeTransfer rejects without fallback retry", async () => {
    vi.mocked(sftpResumeTransfer).mockRejectedValueOnce(new Error("Transfer already finished"));
    await expect(useSftpStore.getState().resumeTransfer("task_fail")).rejects.toThrow(
      "Transfer already finished"
    );
    expect(invoke).not.toHaveBeenCalledWith("sftp_resume_transfer", expect.anything());
  });

  it("cancelTransfer calls sftpCancelTransfer and refreshes list", async () => {
    await useSftpStore.getState().cancelTransfer("task_123");
    expect(sftpCancelTransfer).toHaveBeenCalledWith("task_123");
    expect(sftpListTransfers).toHaveBeenCalled();
  });
});
