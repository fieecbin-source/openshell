import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransferQueueDrawer } from "./TransferQueueDrawer";
import { useSftpStore } from "../stores/sftpStore";
import type { TransferTask } from "../types/ipc";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("TransferQueueDrawer (BUG-006, BUG-007)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders 'running' state as active with pause and cancel buttons", () => {
    const pauseSpy = vi.fn();
    const cancelSpy = vi.fn();
    const resumeSpy = vi.fn();

    const runningTask = {
      id: "task_run",
      session_id: "sess_1",
      direction: "upload",
      local_path: "/local/data.bin",
      remote_path: "/remote/data.bin",
      total_bytes: 1000,
      transferred_bytes: 500,
      speed_bps: 10240,
      state: "running" as any,
      error_message: null,
      created_at: 100,
      updated_at: 200,
    } as TransferTask;

    useSftpStore.setState({
      transfers: [runningTask],
      transferQueueOpen: true,
      pauseTransfer: pauseSpy,
      cancelTransfer: cancelSpy,
      resumeTransfer: resumeSpy,
      pollTransfers: vi.fn(),
    });

    act(() => root.render(<TransferQueueDrawer />));

    expect(document.body.textContent).toContain("传输中");
    expect(document.body.textContent).toContain("10 KB/s");
    expect(document.body.textContent).toContain("正在处理 1 个任务");

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const pauseBtn = buttons.find((b) => b.textContent?.includes("暂停"));
    const cancelBtn = buttons.find((b) => b.textContent?.includes("取消"));
    const resumeBtn = buttons.find((b) => b.textContent?.includes("恢复"));

    expect(pauseBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();
    expect(resumeBtn).toBeFalsy();

    act(() => pauseBtn!.click());
    expect(pauseSpy).toHaveBeenCalledWith("task_run");
  });

  it("renders 'paused' state with resume and cancel buttons, clicking resume calls resumeTransfer", () => {
    const pauseSpy = vi.fn();
    const cancelSpy = vi.fn();
    const resumeSpy = vi.fn();

    const pausedTask = {
      id: "task_paused",
      session_id: "sess_1",
      direction: "download",
      local_path: "/local/data.bin",
      remote_path: "/remote/data.bin",
      total_bytes: 1000,
      transferred_bytes: 300,
      speed_bps: 0,
      state: "paused",
      error_message: null,
      created_at: 100,
      updated_at: 200,
    } as TransferTask;

    useSftpStore.setState({
      transfers: [pausedTask],
      transferQueueOpen: true,
      pauseTransfer: pauseSpy,
      cancelTransfer: cancelSpy,
      resumeTransfer: resumeSpy,
      pollTransfers: vi.fn(),
    });

    act(() => root.render(<TransferQueueDrawer />));

    expect(document.body.textContent).toContain("已暂停");

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const resumeBtn = buttons.find((b) => b.textContent?.includes("恢复"));
    const cancelBtn = buttons.find((b) => b.textContent?.includes("取消"));
    const pauseBtn = buttons.find((b) => b.textContent?.includes("暂停"));

    expect(resumeBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();
    expect(pauseBtn).toBeFalsy();

    act(() => resumeBtn!.click());
    expect(resumeSpy).toHaveBeenCalledWith("task_paused");
  });

  it("does not render action buttons for completed, failed, or cancelled tasks (terminal states)", () => {
    const completedTask = {
      id: "task_done",
      session_id: "sess_1",
      direction: "upload",
      local_path: "/local/data.bin",
      remote_path: "/remote/data.bin",
      total_bytes: 1000,
      transferred_bytes: 1000,
      speed_bps: 0,
      state: "completed",
      error_message: null,
      created_at: 100,
      updated_at: 200,
    } as TransferTask;

    useSftpStore.setState({
      transfers: [completedTask],
      transferQueueOpen: true,
      pauseTransfer: vi.fn(),
      cancelTransfer: vi.fn(),
      resumeTransfer: vi.fn(),
      pollTransfers: vi.fn(),
    });

    act(() => root.render(<TransferQueueDrawer />));

    expect(document.body.textContent).toContain("已完成");
    const buttons = Array.from(document.body.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.includes("暂停"))).toBeFalsy();
    expect(buttons.find((b) => b.textContent?.includes("恢复"))).toBeFalsy();
    // Action buttons inside task item: cancel button should not exist for completed task
    expect(buttons.filter((b) => b.textContent?.includes("取消"))).toHaveLength(0);
  });
});
