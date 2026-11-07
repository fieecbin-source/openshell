import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { ImportExportModal } from "./ImportExportModal";
import * as ipcModule from "../lib/ipc";

import { useSnippetStore } from "../stores/snippetStore";
import type { ImportPreviewReport, Snippet } from "../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  importerCommit: vi.fn(),
  importerDiscardPreview: vi.fn(),
  importerExportBundleEncrypted: vi.fn(),
  importerExportBundleJson: vi.fn(),
  importerPreviewBundleEncrypted: vi.fn(),
  importerPreviewBundleJson: vi.fn(),
  importerPreviewFinalShell: vi.fn(),
  importerPreviewOpenSsh: vi.fn(),
  snippetList: vi.fn(),
  listSessions: vi.fn(),
  listGroups: vi.fn(),
}));

import { useSessionStore } from "../stores/sessionStore";

const fillTextarea = (val: string) =>
  act(() => {
    const el = document.body.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ImportExportModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    useSnippetStore.setState({
      snippets: [],
      loading: false,
      activeGroupId: null,
      searchQuery: "",
    });
    useSessionStore.setState({
      sessions: [],
      groups: [],
      selectedSessionId: null,
      searchQuery: "",
      isLoading: false,
      error: null,
    });
    vi.mocked(ipcModule.snippetList).mockReset().mockResolvedValue([]);
    vi.mocked(ipcModule.listSessions).mockResolvedValue([]);
    vi.mocked(ipcModule.listGroups).mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  describe("Task9 file reader ownership at preview IPC", () => {
    const cases = (["json", "osvault"] as const).flatMap((kind) =>
      (["tab", "close", "unmount"] as const).flatMap((exit) =>
        (["resolve", "reject"] as const).map((outcome) => ({ kind, exit, outcome }))),
    );
    const click = async (label: string) => {
      const button = Array.from(document.body.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
      expect(button).toBeTruthy();
      await act(async () => { button!.click(); });
    };
    const select = async (file: File) => {
      const input = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      await act(async () => {
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    it.each(cases)("keeps B's reader and preview payload when $kind A $outcome after $exit", async ({ kind, exit, outcome }) => {
      vi.mocked(ipcModule.importerPreviewBundleJson).mockReset();
      vi.mocked(ipcModule.importerPreviewBundleEncrypted).mockReset();
      vi.mocked(ipcModule.importerCommit).mockReset().mockResolvedValueOnce(0);
      const report: ImportPreviewReport = { total: 0, new_count: 0, update_count: 0, skip_count: 0, warnings: [], candidates: [], archive_token: "current-file-token" };
      vi.mocked(ipcModule.importerPreviewBundleJson).mockResolvedValueOnce(report);
      vi.mocked(ipcModule.importerPreviewBundleEncrypted).mockResolvedValueOnce(report);
      const oldRead = deferred<string | ArrayBuffer>();
      const currentRead = deferred<string | ArrayBuffer>();
      const makeFile = (name: string, read: typeof oldRead) => {
        const file = new File(["fixture"], `${name}.${kind}`);
        if (kind === "json") file.text = () => read.promise as Promise<string>;
        else file.arrayBuffer = () => read.promise as Promise<ArrayBuffer>;
        return file;
      };
      const close = vi.fn(() => root.render(null));
      await act(async () => { root = createRoot(container); root.render(<ImportExportModal onClose={close} />); });
      await click("恢复备份");
      await select(makeFile("old-file", oldRead));
      expect(document.body.textContent).toContain(`old-file.${kind} (读取中...)`);
      if (exit === "tab") {
        await click("FinalShell 导入");
        expect(document.body.textContent).not.toContain("读取中...");
        await click("恢复备份");
      } else if (exit === "close") {
        await click("关闭");
        expect(close).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).not.toContain("会话导入与数据备份");
        await act(async () => { root.render(<ImportExportModal onClose={close} />); });
        await click("恢复备份");
      } else {
        await act(async () => { root.unmount(); });
        expect(document.body.textContent).not.toContain("会话导入与数据备份");
        await act(async () => { root = createRoot(container); root.render(<ImportExportModal onClose={close} />); });
        await click("恢复备份");
      }
      await select(makeFile("current-file", currentRead));
      await act(async () => {
        if (outcome === "reject") oldRead.reject({ code: "IO", message: "failed to read obsolete file" });
        else oldRead.resolve(kind === "json" ? '{"obsolete":true}' : new Uint8Array([1, 2]).buffer);
      });
      expect(document.body.textContent).toContain(`current-file.${kind} (读取中...)`);
      expect(document.body.textContent).not.toContain("old-file");
      expect(document.body.textContent).not.toContain("本地文件读写失败，请检查磁盘空间与文件权限。");
      expect(document.body.textContent).not.toContain("操作未完成");
      const reading = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "读取中...")!;
      expect(reading.disabled).toBe(true);
      expect(ipcModule.importerPreviewBundleJson).not.toHaveBeenCalled();
      expect(ipcModule.importerPreviewBundleEncrypted).not.toHaveBeenCalled();
      expect(ipcModule.importerCommit).not.toHaveBeenCalled();
      await act(async () => { currentRead.resolve(kind === "json" ? '{"current":true}' : new Uint8Array([8, 9]).buffer); });
      expect(document.body.textContent).not.toContain("读取中...");
      if (kind === "osvault") {
        const password = document.body.querySelector<HTMLInputElement>("#restore-password")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "fixture-password");
          password.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      await click("校验并预览");
      if (kind === "json") {
        expect(ipcModule.importerPreviewBundleJson).toHaveBeenCalledTimes(1);
        expect(ipcModule.importerPreviewBundleJson).toHaveBeenCalledWith('{"current":true}', "skip");
        expect(ipcModule.importerPreviewBundleEncrypted).not.toHaveBeenCalled();
      } else {
        expect(ipcModule.importerPreviewBundleEncrypted).toHaveBeenCalledTimes(1);
        expect(ipcModule.importerPreviewBundleEncrypted).toHaveBeenCalledWith(new Uint8Array([8, 9]), "fixture-password", "skip");
        expect(ipcModule.importerPreviewBundleJson).not.toHaveBeenCalled();
      }
      await click("确认恢复");
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(ipcModule.importerCommit).toHaveBeenCalledWith([], "current-file-token");
      expect(document.body.textContent).not.toContain("操作未完成");
      expect(document.body.textContent).not.toContain("读取中...");
    });

    it.each(["resolve", "reject"] as const)("preserves B's pending preview and token when commit A %s late", async (outcome) => {
      const commit = deferred<number>();
      const preview = deferred<ImportPreviewReport>();
      const reportA: ImportPreviewReport = { total: 0, new_count: 0, update_count: 0, skip_count: 0, warnings: [], candidates: [], archive_token: "pending-commit-a" };
      const reportB: ImportPreviewReport = { ...reportA, archive_token: "pending-preview-b", total: 1, new_count: 1, candidates: [{ input: { name: "Current B", host: "example.invalid", port: 22, username: "fixture" }, action: "create", existing_session_id: null }] };
      vi.mocked(ipcModule.importerCommit).mockReset().mockReturnValueOnce(commit.promise).mockResolvedValueOnce(1);
      vi.mocked(ipcModule.importerPreviewBundleJson).mockReset().mockResolvedValueOnce(reportA);
      vi.mocked(ipcModule.importerPreviewOpenSsh).mockReset().mockReturnValueOnce(preview.promise);
      await act(async () => { root = createRoot(container); root.render(<ImportExportModal onClose={() => {}} />); });
      await click("恢复备份");
      const file = new File(["{}"], "commit-a.json");
      file.text = () => Promise.resolve("{}");
      await select(file);
      await click("校验并预览");
      await click("确认恢复");
      await click("OpenSSH 配置");
      await fillTextarea("Host current-b\nHostName example.invalid");
      await click("解析并预览");
      expect(document.body.textContent).toContain("分析中...");
      await act(async () => {
        if (outcome === "resolve") commit.resolve(0);
        else commit.reject({ code: "IO", message: "failed to commit obsolete A" });
      });
      expect(document.body.textContent).toContain("分析中...");
      expect(document.body.textContent).not.toContain("本地文件读写失败");
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      if (outcome === "resolve") {
        expect(ipcModule.listSessions).toHaveBeenCalledTimes(1);
        expect(ipcModule.listGroups).toHaveBeenCalledTimes(1);
        expect(ipcModule.snippetList).toHaveBeenCalledTimes(1);
        expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("pending-commit-a");
      } else {
        expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("pending-commit-a");
        expect(ipcModule.snippetList).not.toHaveBeenCalled();
      }
      await act(async () => { preview.resolve(reportB); });
      expect(document.body.textContent).toContain("Current B");
      expect(document.body.textContent).not.toContain("分析中...");
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("pending-preview-b");
      await click("确认导入");
      expect(ipcModule.importerCommit).toHaveBeenNthCalledWith(2, reportB.candidates, "pending-preview-b");
    });

    it.each(["resolve", "reject"] as const)("keeps B's file reader owned after restore A's read-only retry %s late", async (outcome) => {
      const report: ImportPreviewReport = { total: 0, new_count: 0, update_count: 0, skip_count: 0, warnings: [], candidates: [], archive_token: "restore-retry-a" };
      const refresh = deferred<Snippet[]>();
      const fileRead = deferred<string>();
      vi.mocked(ipcModule.importerCommit).mockReset().mockResolvedValueOnce(0);
      vi.mocked(ipcModule.importerPreviewBundleJson).mockReset().mockResolvedValueOnce(report);
      vi.mocked(ipcModule.snippetList).mockReset()
        .mockRejectedValueOnce({ code: "IO", message: "failed to refresh A" })
        .mockReturnValueOnce(refresh.promise);
      await act(async () => { root = createRoot(container); root.render(<ImportExportModal onClose={() => {}} />); });
      await click("恢复备份");
      const fileA = new File(["{}"], "retry-a.json");
      fileA.text = () => Promise.resolve("{}");
      await select(fileA);
      await click("校验并预览");
      await click("确认恢复");
      expect(document.body.textContent).toContain("操作已成功、刷新失败");
      await click("重试刷新");
      const fileB = new File(["{}"], "current-reader-b.json");
      fileB.text = () => fileRead.promise;
      await select(fileB);
      expect(document.body.textContent).toContain("current-reader-b.json (读取中...)");
      expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
      await act(async () => {
        if (outcome === "resolve") refresh.resolve([]);
        else refresh.reject({ code: "IO", message: "failed to retry old A" });
      });
      expect(document.body.textContent).toContain("current-reader-b.json (读取中...)");
      expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
      expect(document.body.textContent).not.toContain("本地文件读写失败");
      expect(document.body.textContent).not.toContain("重试刷新");
      await act(async () => { fileRead.resolve('{"current":true}'); });
      const previewButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "校验并预览")!;
      expect(previewButton.disabled).toBe(false);
      expect(document.body.textContent).not.toContain("读取中...");
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(ipcModule.snippetList).toHaveBeenCalledTimes(2);
      expect(ipcModule.importerPreviewBundleJson).toHaveBeenCalledTimes(1);
    });
  });

  it("passes archive_token to importerCommit and keeps warnings visible on commit", async () => {
    const mockReport = {
      total: 1,
      new_count: 1,
      update_count: 0,
      skip_count: 0,
      warnings: ["检测到未导入的私钥依赖 id_ed25519，请稍后补录"],
      candidates: [
        {
          input: { name: "Server A", host: "1.2.3.4", port: 22, username: "root" },
          action: "create",
          existing_session_id: null,
        },
      ],
      archive_token: "token-12345",
    };

    (ipcModule.importerPreviewOpenSsh as any).mockResolvedValue(mockReport);
    (ipcModule.importerCommit as any).mockResolvedValue(1);

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    await fillTextarea("Host server-a\n  HostName 1.2.3.4");

    const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("解析并预览")
    );
    expect(previewBtn).toBeTruthy();

    await act(async () => {
      previewBtn!.click();
    });

    expect(ipcModule.importerPreviewOpenSsh).toHaveBeenCalledWith(
      "Host server-a\n  HostName 1.2.3.4",
      "skip"
    );

    // Should see preview candidate and warning
    expect(document.body.textContent).toContain("检测到会话 1 个");
    expect(document.body.textContent).toContain("检测到未导入的私钥依赖 id_ed25519");

    const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认导入")
    );
    expect(commitBtn).toBeTruthy();

    await act(async () => {
      commitBtn!.click();
    });

    expect(ipcModule.importerCommit).toHaveBeenCalledWith(mockReport.candidates, "token-12345");
    // Verify success message and persistent warning notice
    expect(document.body.textContent).toContain("已成功恢复 1 个会话及对应归档配置");
    expect(document.body.textContent).toContain("已导入会话的待补录依赖");
    expect(document.body.textContent).toContain("检测到未导入的私钥依赖 id_ed25519");
  });

  it("calls discardArchiveToken when closing modal with active preview token", async () => {
    const mockReport = {
      total: 1,
      new_count: 1,
      update_count: 0,
      skip_count: 0,
      warnings: [],
      candidates: [
        {
          input: { name: "Server A", host: "1.2.3.4", port: 22, username: "root" },
          action: "create",
          existing_session_id: null,
        },
      ],
      archive_token: "token-discard-999",
    };

    (ipcModule.importerPreviewOpenSsh as any).mockResolvedValue(mockReport);

    const onClose = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={onClose} />);
    });

    await fillTextarea("Host server-a\n  HostName 1.2.3.4");

    const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("解析并预览")
    );
    await act(async () => {
      previewBtn!.click();
    });

    // Ensure preview report is rendered and token is in state
    expect(document.body.textContent).toContain("检测到会话 1 个");

    const closeBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "关闭"
    );
    expect(closeBtn).toBeTruthy();

    await act(async () => {
      closeBtn!.click();
    });

    expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("token-discard-999");
    expect(onClose).toHaveBeenCalled();
  });

  it("displays error message and does not claim success when preview or commit fails", async () => {
    (ipcModule.importerPreviewOpenSsh as any).mockRejectedValue(
      new Error("Invalid SSH config syntax")
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    await fillTextarea("invalid content");

    const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("解析并预览")
    );
    await act(async () => {
      previewBtn!.click();
    });

    expect(document.body.textContent).toContain("操作未完成");
    expect(document.body.textContent).not.toContain("成功导入");
  });

  it("allows commit for snippets-only JSON restore when candidates is empty and archive_token exists", async () => {
    const mockSnippetReport = {
      total: 0,
      new_count: 0,
      update_count: 0,
      skip_count: 0,
      warnings: [],
      candidates: [],
      archive_token: "token-snippets-only",
    };

    (ipcModule.importerPreviewBundleJson as any).mockResolvedValue(mockSnippetReport);
    (ipcModule.importerCommit as any).mockResolvedValue(0);

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    // Switch to restore tab
    const restoreTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("恢复备份")
    );
    expect(restoreTab).toBeTruthy();
    await act(async () => {
      restoreTab!.click();
    });

    // Simulate choosing a JSON file
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"snippets":[{"id":"s1"}]}'], "snippets_backup.json", {
      type: "application/json",
    });
    // mock text
    file.text = () => Promise.resolve('{"snippets":[{"id":"s1"}]}');

    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        value: [file],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("校验并预览")
    );
    expect(verifyBtn).toBeTruthy();

    await act(async () => {
      verifyBtn!.click();
    });

    expect(ipcModule.importerPreviewBundleJson).toHaveBeenCalled();
    expect(document.body.textContent).toContain("检测到归档配置数据（片段/分组/密钥/代理等）");

    const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认恢复")
    );
    expect(commitBtn).toBeTruthy();
    expect(commitBtn!.disabled).toBe(false);

    await act(async () => {
      commitBtn!.click();
    });

    expect(ipcModule.importerCommit).toHaveBeenCalledWith([], "token-snippets-only");
    expect(document.body.textContent).toContain("已成功恢复 0 个会话及对应归档配置");
    expect(ipcModule.snippetList).toHaveBeenCalled();
  });

  it("allows commit for keys-only encrypted osvault restore when candidates is empty and archive_token exists", async () => {
    const mockKeysReport = {
      total: 0,
      new_count: 0,
      update_count: 0,
      skip_count: 0,
      warnings: [],
      candidates: [],
      archive_token: "token-keys-only",
    };

    (ipcModule.importerPreviewBundleEncrypted as any).mockResolvedValue(mockKeysReport);
    (ipcModule.importerCommit as any).mockResolvedValue(0);

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    // Switch to restore tab
    const restoreTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("恢复备份")
    );
    await act(async () => {
      restoreTab!.click();
    });

    // Simulate choosing .osvault file
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "keys.osvault", {
      type: "application/octet-stream",
    });
    file.arrayBuffer = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);

    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        value: [file],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Fill password
    const pwdInput = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        pwdInput,
        "SecretPass123"
      );
      pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
      pwdInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("校验并预览")
    );
    await act(async () => {
      verifyBtn!.click();
    });

    expect(ipcModule.importerPreviewBundleEncrypted).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "SecretPass123",
      "skip"
    );

    const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认恢复")
    );
    expect(commitBtn).toBeTruthy();
    expect(commitBtn!.disabled).toBe(false);

    await act(async () => {
      commitBtn!.click();
    });

    expect(ipcModule.importerCommit).toHaveBeenCalledWith([], "token-keys-only");
  });

  it("changing strategy discards existing preview token and clears preview report", async () => {
    const mockReport = {
      total: 1,
      new_count: 1,
      update_count: 0,
      skip_count: 0,
      warnings: [],
      candidates: [
        {
          input: { name: "Server A", host: "1.2.3.4", port: 22, username: "root" },
          action: "create",
          existing_session_id: null,
        },
      ],
      archive_token: "token-strat-change",
    };

    (ipcModule.importerPreviewOpenSsh as any).mockResolvedValue(mockReport);

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    await fillTextarea("Host server-a\n  HostName 1.2.3.4");

    const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("解析并预览")
    );
    await act(async () => {
      previewBtn!.click();
    });

    expect(document.body.textContent).toContain("检测到会话 1 个");

    // Click "覆盖已有" radio button
    const overwriteRadio = Array.from(document.body.querySelectorAll("input[type='radio']")).find(
      (r) => (r as HTMLInputElement).nextSibling?.textContent?.includes("覆盖已有") || r.parentElement?.textContent?.includes("覆盖已有")
    ) as HTMLInputElement;

    expect(overwriteRadio).toBeTruthy();
    await act(async () => {
      overwriteRadio.click();
    });

    expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("token-strat-change");
    // Preview report should be cleared
    expect(document.body.textContent).not.toContain("检测到会话 1 个");
  });

  it("re-preview failure discards old token, clears report and prevents submitting invalid token", async () => {
    const mockReport = {
      total: 1,
      new_count: 1,
      update_count: 0,
      skip_count: 0,
      warnings: [],
      candidates: [
        {
          input: { name: "Server A", host: "1.2.3.4", port: 22, username: "root" },
          action: "create",
          existing_session_id: null,
        },
      ],
      archive_token: "token-repreview-1",
    };

    (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(mockReport);

    await act(async () => {
      root = createRoot(container);
      root.render(<ImportExportModal onClose={vi.fn()} />);
    });

    await fillTextarea("Host server-a\n  HostName 1.2.3.4");

    const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("解析并预览")
    );
    await act(async () => {
      previewBtn!.click();
    });

    expect(document.body.textContent).toContain("检测到会话 1 个");

    // Next preview fails
    (ipcModule.importerPreviewOpenSsh as any).mockRejectedValueOnce(new Error("Corrupted archive syntax"));

    await act(async () => {
      previewBtn!.click();
    });

    expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("token-repreview-1");
    expect(document.body.textContent).not.toContain("检测到会话 1 个");
    expect(document.body.textContent).toContain("Corrupted archive syntax");
    // No commit button should be present
    const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认导入") || b.textContent?.includes("确认恢复")
    );
    expect(commitBtn).toBeFalsy();
  });

  describe("S03: preview pending cancellation and loading cleanup", () => {
    it("switching tab while preview is pending clears loading, discards late token, and leaves other tabs usable", async () => {
      let resolvePreview!: (val: any) => void;
      const deferredPreview = new Promise((resolve) => {
        resolvePreview = resolve;
      });

      (ipcModule.importerPreviewOpenSsh as any).mockReturnValueOnce(deferredPreview);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-pending\n  HostName 1.2.3.4");

      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      expect(previewBtn).toBeTruthy();

      await act(async () => {
        previewBtn!.click();
      });

      // Preview is now pending, loading should be true
      expect(document.body.textContent).toContain("分析中...");

      // Switch to export tab
      const exportTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("导出与归档")
      );
      expect(exportTab).toBeTruthy();

      await act(async () => {
        exportTab!.click();
      });

      // Loading must be cleared on tab switch, export button must NOT be disabled by loading
      const downloadBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("下载 JSON")
      );
      expect(downloadBtn).toBeTruthy();
      expect(downloadBtn!.disabled).toBe(false);

      // Now late preview resolves with token
      const lateToken = "token-late-tab-switch";
      await act(async () => {
        resolvePreview({
          total: 1,
          new_count: 1,
          update_count: 0,
          skip_count: 0,
          warnings: [],
          candidates: [{ input: { name: "Late Server", host: "1.2.3.4", port: 22, username: "root" }, action: "create", existing_session_id: null }],
          archive_token: lateToken,
        });
      });

      // Token must be discarded
      expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith(lateToken);
      // Late preview must not display in export tab
      expect(document.body.textContent).not.toContain("检测到会话 1 个");
    });

    it("switching strategy while preview is pending clears loading, allows new preview, and late resolve/reject cannot overwrite newer state", async () => {
      let resolvePreview1!: (val: any) => void;
      const deferredPreview1 = new Promise((resolve) => {
        resolvePreview1 = resolve;
      });

      (ipcModule.importerPreviewOpenSsh as any).mockReturnValueOnce(deferredPreview1);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-1\n  HostName 1.2.3.4");

      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      expect(document.body.textContent).toContain("分析中...");

      // Switch strategy to "overwrite"
      const overwriteRadio = Array.from(document.body.querySelectorAll("input[type='radio']")).find(
        (r) => (r as HTMLInputElement).nextSibling?.textContent?.includes("覆盖已有") || r.parentElement?.textContent?.includes("覆盖已有")
      ) as HTMLInputElement;

      await act(async () => {
        overwriteRadio.click();
      });

      // Loading should be cleared after strategy switch
      expect(document.body.textContent).not.toContain("分析中...");
      expect(previewBtn!.textContent).toContain("解析并预览");

      // Start preview 2 under new strategy
      const report2 = {
        total: 1,
        new_count: 0,
        update_count: 1,
        skip_count: 0,
        warnings: [],
        candidates: [{ input: { name: "Server 2", host: "1.2.3.4", port: 22, username: "root" }, action: "update", existing_session_id: "s1" }],
        archive_token: "token-gen-2",
      };
      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(report2);

      await act(async () => {
        previewBtn!.click();
      });

      // Preview 2 is resolved
      expect(document.body.textContent).toContain("检测到会话 1 个");
      expect(document.body.textContent).toContain("Server 2");

      // Now preview 1 late resolves
      await act(async () => {
        resolvePreview1({
          total: 1,
          new_count: 1,
          update_count: 0,
          skip_count: 0,
          warnings: [],
          candidates: [{ input: { name: "Server 1 Old", host: "1.2.3.4", port: 22, username: "root" }, action: "create", existing_session_id: null }],
          archive_token: "token-gen-1-late",
        });
      });

      // Old token must be discarded
      expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("token-gen-1-late");
      // UI must retain preview 2's content, not overwritten by preview 1
      expect(document.body.textContent).toContain("Server 2");
      expect(document.body.textContent).not.toContain("Server 1 Old");
    });
  });

  describe("S04: handleRestoreFileChange generation check and out-of-order protection", () => {
    it("out-of-order JSON file reads ensure file name and content are strictly paired from the latest selection", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      // Switch to restore tab
      const restoreTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTab!.click();
      });

      const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;

      let resolveFileA!: (content: string) => void;
      const fileAPromise = new Promise<string>((res) => {
        resolveFileA = res;
      });
      const fileA = new File(["dummy"], "file_A.json", { type: "application/json" });
      fileA.text = () => fileAPromise;

      let resolveFileB!: (content: string) => void;
      const fileBPromise = new Promise<string>((res) => {
        resolveFileB = res;
      });
      const fileB = new File(["dummy"], "file_B.json", { type: "application/json" });
      fileB.text = () => fileBPromise;

      // Select file A
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // While file A is reading, preview button must be disabled (cannot treat file selected as ready)
      const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览") || b.textContent?.includes("读取中...")
      )!;
      expect(verifyBtn.disabled).toBe(true);

      // Select file B
      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileB], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // File B resolves first
      await act(async () => {
        resolveFileB('{"sessions":[{"name":"Server B Only"}]}');
      });

      // File A resolves late
      await act(async () => {
        resolveFileA('{"sessions":[{"name":"Server A Old"}]}');
      });

      // Verify button should now be enabled and verify file B
      const activeVerifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览")
      );
      expect(activeVerifyBtn).toBeTruthy();
      expect(activeVerifyBtn!.disabled).toBe(false);

      (ipcModule.importerPreviewBundleJson as any).mockResolvedValueOnce({
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [{ input: { name: "Server B Only", host: "1.2.3.4", port: 22, username: "root" }, action: "create", existing_session_id: null }],
        archive_token: "token-b",
      });

      await act(async () => {
        activeVerifyBtn!.click();
      });

      // Must call importerPreviewBundleJson with B's content, NOT A's content
      expect(ipcModule.importerPreviewBundleJson).toHaveBeenCalledWith(
        '{"sessions":[{"name":"Server B Only"}]}',
        "skip"
      );
    });

    it("out-of-order osvault file reads ensure bytes and name come strictly from latest file", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTab!.click();
      });

      const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;

      let resolveFileA!: (buf: ArrayBuffer) => void;
      const fileAPromise = new Promise<ArrayBuffer>((res) => {
        resolveFileA = res;
      });
      const fileA = new File([new Uint8Array([1, 1])], "vault_A.osvault", { type: "application/octet-stream" });
      fileA.arrayBuffer = () => fileAPromise;

      let resolveFileB!: (buf: ArrayBuffer) => void;
      const fileBPromise = new Promise<ArrayBuffer>((res) => {
        resolveFileB = res;
      });
      const fileB = new File([new Uint8Array([2, 2])], "vault_B.osvault", { type: "application/octet-stream" });
      fileB.arrayBuffer = () => fileBPromise;

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileB], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // B finishes first
      await act(async () => {
        resolveFileB(new Uint8Array([20, 21, 22]).buffer);
      });

      // A finishes late
      await act(async () => {
        resolveFileA(new Uint8Array([10, 11, 12]).buffer);
      });

      // Password input should appear for osvault
      const pwdInput = document.body.querySelector('input[type="password"]') as HTMLInputElement;
      expect(pwdInput).toBeTruthy();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pwdInput, "SecretPassB");
        pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
        pwdInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览")
      );
      expect(verifyBtn).toBeTruthy();

      (ipcModule.importerPreviewBundleEncrypted as any).mockResolvedValueOnce({
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [],
        archive_token: "token-vault-b",
      });

      await act(async () => {
        verifyBtn!.click();
      });

      expect(ipcModule.importerPreviewBundleEncrypted).toHaveBeenCalledWith(
        new Uint8Array([20, 21, 22]),
        "SecretPassB",
        "skip"
      );
    });

    it("file read failure clears filename and content and displays error notice", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTab!.click();
      });

      const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
      const badFile = new File(["bad"], "bad.json", { type: "application/json" });
      badFile.text = () => Promise.reject(new Error("File unreadable: disk error"));

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [badFile], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      expect(document.body.textContent).toContain("File unreadable: disk error");
      expect(document.body.textContent).toContain("尚未选择文件");
      const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览")
      );
      expect(verifyBtn!.disabled).toBe(true);
    });
  });

  describe("S07: commit succeeded but real snippetStore refresh failed", () => {
    it("clears the previous restore refresh retry while a newly selected file is still reading", async () => {
      const report: ImportPreviewReport = {
        total: 0,
        new_count: 0,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [],
        archive_token: "restore-refresh-owner-a",
      };
      vi.mocked(ipcModule.importerPreviewBundleJson).mockResolvedValueOnce(report);
      vi.mocked(ipcModule.importerCommit).mockResolvedValueOnce(1);
      vi.mocked(ipcModule.snippetList).mockRejectedValueOnce(new Error("Restore A refresh failed"));
      const click = async (label: string) => {
        const button = Array.from(document.body.querySelectorAll("button")).find(
          (candidate) => candidate.textContent === label,
        );
        expect(button).toBeTruthy();
        await act(async () => { button!.click(); });
      };
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });
      await click("恢复备份");
      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const selectFile = async (file: File) => act(async () => {
        Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const fileA = new File(["{}"], "restore-a.json", { type: "application/json" });
      fileA.text = () => Promise.resolve("{}");
      await selectFile(fileA);
      await click("校验并预览");
      await click("确认恢复");
      expect(document.body.textContent).toContain("操作已成功、刷新失败");

      const fileBRead = deferred<string>();
      const fileB = new File(["{}"], "restore-b.json", { type: "application/json" });
      fileB.text = () => fileBRead.promise;
      await selectFile(fileB);
      expect(document.body.textContent).toContain("restore-b.json (读取中...)");
      expect(Array.from(document.body.querySelectorAll("button")).some(
        (button) => button.textContent === "重试刷新",
      )).toBe(false);

      await act(async () => { fileBRead.resolve('{"sessions":[]}'); });
      const previewB = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "校验并预览",
      );
      expect(previewB?.disabled).toBe(false);
      expect(document.body.textContent).toContain("restore-b.json");
      expect(document.body.textContent).not.toContain("读取中...");
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(ipcModule.snippetList).toHaveBeenCalledTimes(1);
    });

    it("recognizes commit success but refresh failure with real snippetStore and mock snippetList IPC error, allows retry refresh without re-commit", async () => {
      const mockReport = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server S07", host: "1.2.3.4", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-s07",
      };

      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(mockReport);
      (ipcModule.importerCommit as any).mockResolvedValueOnce(1);
      // Real snippetStore will call snippetList IPC, which rejects
      (ipcModule.snippetList as any).mockRejectedValueOnce(new Error("Snippet database locked"));

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host s07\n  HostName 1.2.3.4");

      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      expect(commitBtn).toBeTruthy();

      await act(async () => {
        commitBtn!.click();
      });

      // 1. Commit succeeded
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("已成功恢复 1 个会话及对应归档配置");

      // 2. Refresh failure is visible with exact status "操作已成功、刷新失败"
      expect(document.body.textContent).toContain("操作已成功、刷新失败");
      expect(document.body.textContent).toContain("Snippet database locked");

      // 3. Retry refresh button is available
      const retryRefreshBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("重试刷新")
      );
      expect(retryRefreshBtn).toBeTruthy();

      // Next snippetList succeeds
      (ipcModule.snippetList as any).mockResolvedValueOnce([]);

      await act(async () => {
        retryRefreshBtn!.click();
      });

      // Commit was NOT called again! (still 1)
      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      // Snippet list was called again to refresh
      expect(ipcModule.snippetList).toHaveBeenCalledTimes(2);
      // Refresh failure notice is now dismissed
      expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
    });

    it("retry refresh pending -> switch tab -> late reject: does not write refreshError into new tab, old refresh is ignored", async () => {
      const mockReport = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server S07b", host: "1.2.3.4", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-s07b",
      };

      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(mockReport);
      (ipcModule.importerCommit as any).mockResolvedValueOnce(1);
      (ipcModule.snippetList as any).mockRejectedValueOnce(new Error("Snippet DB initial error"));

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host s07b\n  HostName 1.2.3.4");
      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      expect(document.body.textContent).toContain("操作已成功、刷新失败");

      const retryRefreshBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("重试刷新")
      );
      expect(retryRefreshBtn).toBeTruthy();

      // Retry refresh will be delayed
      const retryDeferred = deferred<any[]>();
      (ipcModule.snippetList as any).mockReturnValueOnce(retryDeferred.promise);

      await act(async () => {
        retryRefreshBtn!.click();
      });

      // User switches tab to FinalShell while retry refresh is pending
      const finalshellTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("FinalShell 导入")
      );
      expect(finalshellTabBtn).toBeTruthy();
      await act(async () => {
        finalshellTabBtn!.click();
      });

      // Now retry refresh rejects late
      await act(async () => {
        retryDeferred.reject(new Error("Snippet DB late failure"));
      });

      // FinalShell tab must NOT display the old retry's refreshError!
      expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
      expect(document.body.textContent).not.toContain("Snippet DB late failure");
    });

    it.each(["switch tab", "start preview"] as const)(
      "keeps B's refresh retry available after retry A is pending and the user chooses to %s",
      async (transfer) => {
        const report: ImportPreviewReport = {
          total: 1,
          new_count: 1,
          update_count: 0,
          skip_count: 0,
          warnings: [],
          candidates: [{
            input: { name: "Refresh owner", host: "example.invalid", protocol: "ssh" },
            action: "create",
            existing_session_id: null,
          }],
        };
        const retryA = deferred<Snippet[]>();
        vi.mocked(ipcModule.importerPreviewOpenSsh).mockResolvedValue(report);
        vi.mocked(ipcModule.importerPreviewFinalShell).mockResolvedValue(report);
        vi.mocked(ipcModule.importerCommit).mockResolvedValue(1);
        vi.mocked(ipcModule.snippetList)
          .mockRejectedValueOnce(new Error("Refresh A failed"))
          .mockReturnValueOnce(retryA.promise)
          .mockRejectedValueOnce(new Error("Refresh B failed"))
          .mockResolvedValueOnce([]);
        const click = async (label: string) => {
          const button = Array.from(document.body.querySelectorAll("button")).find(
            (candidate) => candidate.textContent === label,
          );
          expect(button).toBeTruthy();
          await act(async () => { button!.click(); });
        };

        await act(async () => {
          root = createRoot(container);
          root.render(<ImportExportModal onClose={vi.fn()} />);
        });
        await fillTextarea("Host refresh-a\n  HostName example.invalid");
        await click("解析并预览");
        await click("确认导入");
        await click("重试刷新");
        if (transfer === "switch tab") await click("FinalShell 导入");
        await fillTextarea("Host refresh-b\n  HostName example.invalid");
        await click("解析并预览");
        await click("确认导入");
        await act(async () => { retryA.resolve([]); });

        const retryB = Array.from(document.body.querySelectorAll("button")).find(
          (button) => button.textContent === "重试刷新",
        );
        expect(retryB).toBeTruthy();
        expect(retryB!.disabled).toBe(false);
        await click("重试刷新");
        expect(ipcModule.importerCommit).toHaveBeenCalledTimes(2);
        expect(ipcModule.snippetList).toHaveBeenCalledTimes(4);
        expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
      },
    );

    it("recognizes commit success but refresh failure with real sessionStore and mock listSessions IPC error", async () => {
      const mockReport = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server Session Fail", host: "1.2.3.4", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-session-fail",
      };

      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(mockReport);
      (ipcModule.importerCommit as any).mockResolvedValueOnce(1);
      // Real sessionStore listSessions IPC rejects
      (ipcModule.listSessions as any).mockRejectedValueOnce(new Error("Session DB read error"));

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host session-fail\n  HostName 1.2.3.4");

      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("操作已成功、刷新失败");
      expect(document.body.textContent).toContain("Session DB read error");

      const retryRefreshBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("重试刷新")
      );
      expect(retryRefreshBtn).toBeTruthy();

      (ipcModule.listSessions as any).mockResolvedValueOnce([]);

      await act(async () => {
        retryRefreshBtn!.click();
      });

      expect(ipcModule.importerCommit).toHaveBeenCalledTimes(1);
      expect(ipcModule.listSessions).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).not.toContain("操作已成功、刷新失败");
    });
  });

  describe("R03: commit A pending -> switch tab/strategy -> preview B -> commit A resolve/reject", () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("commit A pending -> switch strategy and preview B -> commit A resolves: B report/token/loading preserved, global refresh runs", async () => {
      const reportA = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server A", host: "1.1.1.1", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-commit-A",
      };

      const reportB = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server B", host: "2.2.2.2", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-preview-B",
      };

      const commitADeferred = deferred<number>();
      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(reportA);
      (ipcModule.importerCommit as any).mockReturnValueOnce(commitADeferred.promise);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-a\n  HostName 1.1.1.1");

      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      expect(document.body.textContent).toContain("Server A");

      // Commit A starts
      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      expect(ipcModule.importerCommit).toHaveBeenCalledWith(reportA.candidates, "token-commit-A");

      // While commit A is pending, change strategy to "overwrite"
      const overwriteRadio = Array.from(document.body.querySelectorAll("input[type='radio']")).find(
        (r) => (r as HTMLInputElement).name === "strategy" && (r.closest("label")?.textContent?.includes("覆盖已有") ?? false)
      );
      expect(overwriteRadio).toBeTruthy();
      await act(async () => {
        (overwriteRadio as HTMLInputElement).click();
      });

      // token-commit-A must NOT have been discarded while commit is in flight!
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-commit-A");

      // Now preview B
      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(reportB);
      await fillTextarea("Host server-b\n  HostName 2.2.2.2");
      const previewBtn2 = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn2!.click();
      });

      expect(document.body.textContent).toContain("Server B");

      // Now Commit A resolves
      await act(async () => {
        commitADeferred.resolve(1);
      });

      // B's preview report MUST NOT be wiped out!
      expect(document.body.textContent).toContain("Server B");
      // B's token must NOT have been discarded
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-preview-B");
      // Global read refresh MUST have been called
      expect(ipcModule.listSessions).toHaveBeenCalled();
      expect(ipcModule.snippetList).toHaveBeenCalled();
    });

    it("commit A pending -> start preview B -> commit A resolves while preview B is still pending: B loading preserved, token A not lost", async () => {
      const reportA = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server A Pending", host: "1.1.1.1", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-commit-A-pend",
      };

      const reportB = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server B Result", host: "2.2.2.2", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-preview-B-pend",
      };

      const commitADeferred = deferred<number>();
      const previewBDeferred = deferred<any>();

      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(reportA);
      (ipcModule.importerCommit as any).mockReturnValueOnce(commitADeferred.promise);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-a-pend\n  HostName 1.1.1.1");
      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      // Commit A starts
      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      expect(ipcModule.importerCommit).toHaveBeenCalledWith(reportA.candidates, "token-commit-A-pend");

      // While Commit A is pending, change strategy to overwrite (cancels pending preview A view, invalidates generation)
      const overwriteRadio = Array.from(document.body.querySelectorAll("input[type='radio']")).find(
        (r) => (r as HTMLInputElement).value === "overwrite" || (r as any).labels?.[0]?.textContent?.includes("覆盖已有")
      ) as HTMLInputElement | undefined;
      await act(async () => {
        if (overwriteRadio) {
          overwriteRadio.click();
        } else {
          // click strategy radio label
          const radioLabel = Array.from(document.body.querySelectorAll("label")).find((l) =>
            l.textContent?.includes("覆盖已有")
          );
          radioLabel?.click();
        }
      });

      // Now start Preview B
      (ipcModule.importerPreviewOpenSsh as any).mockReturnValueOnce(previewBDeferred.promise);
      await fillTextarea("Host server-b-pend\n  HostName 2.2.2.2");
      const previewBtn2 = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      expect(previewBtn2).toBeTruthy();
      await act(async () => {
        previewBtn2!.click();
      });

      // At this point, Preview B is pending, button shows loading / 分析中
      expect(document.body.textContent).toContain("分析中...");

      // NOW Commit A resolves while Preview B is STILL PENDING
      await act(async () => {
        commitADeferred.resolve(1);
      });

      // Preview B is STILL PENDING: loading must NOT have been turned off by Commit A!
      expect(document.body.textContent).toContain("分析中...");

      // Now Preview B resolves
      await act(async () => {
        previewBDeferred.resolve(reportB);
      });

      // Preview B report is now rendered and loading finished!
      expect(document.body.textContent).toContain("Server B Result");
      expect(document.body.textContent).not.toContain("分析中...");
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-preview-B-pend");
    });

    it("commit A pending -> switch tab -> preview B -> commit A rejects: B report preserved, token A discarded on failure, B error not overwritten", async () => {
      const reportA = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server A Rej", host: "1.1.1.1", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-commit-A-rej",
      };

      const reportB = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server B JSON", host: "2.2.2.2", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-preview-B-json",
      };

      const commitADeferred = deferred<number>();
      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(reportA);
      (ipcModule.importerCommit as any).mockReturnValueOnce(commitADeferred.promise);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-a-rej\n  HostName 1.1.1.1");
      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      // Switch to restore tab
      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      // token-commit-A-rej was NOT discarded during tab switch
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-commit-A-rej");

      // Load file B on restore tab
      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileB = new File(['{"sessions":[]}'], "backup_b.json", { type: "application/json" });
      (fileB as any).text = vi.fn().mockResolvedValue('{"sessions":[]}');

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileB], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      (ipcModule.importerPreviewBundleJson as any).mockResolvedValueOnce(reportB);
      const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览")
      );
      await act(async () => {
        verifyBtn!.click();
      });

      expect(document.body.textContent).toContain("Server B JSON");

      // Commit A rejects
      await act(async () => {
        commitADeferred.reject(new Error("Backend commit internal error"));
      });

      // B's report is preserved
      expect(document.body.textContent).toContain("Server B JSON");
      // B's token is not discarded
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-preview-B-json");
      // Failed orphaned token-commit-A-rej IS discarded
      expect(ipcModule.importerDiscardPreview).toHaveBeenCalledWith("token-commit-A-rej");
      // Commit A's error is NOT shown on tab B
      expect(document.body.textContent).not.toContain("Backend commit internal error");
    });

    it("commit A pending -> modal unmounts: token A not discarded on unmount, global refresh runs on resolve", async () => {
      const reportA = {
        total: 1,
        new_count: 1,
        update_count: 0,
        skip_count: 0,
        warnings: [],
        candidates: [
          {
            input: { name: "Server Unmount", host: "1.1.1.1", port: 22, username: "root" },
            action: "create",
            existing_session_id: null,
          },
        ],
        archive_token: "token-commit-unmount",
      };

      const commitADeferred = deferred<number>();
      (ipcModule.importerPreviewOpenSsh as any).mockResolvedValueOnce(reportA);
      (ipcModule.importerCommit as any).mockReturnValueOnce(commitADeferred.promise);

      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      await fillTextarea("Host server-unmount\n  HostName 1.1.1.1");
      const previewBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("解析并预览")
      );
      await act(async () => {
        previewBtn!.click();
      });

      const commitBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("确认导入")
      );
      await act(async () => {
        commitBtn!.click();
      });

      expect(ipcModule.importerCommit).toHaveBeenCalledWith(reportA.candidates, "token-commit-unmount");

      // Modal unmounts
      await act(async () => {
        root.unmount();
      });

      // Token must NOT be discarded on unmount while commit is in flight!
      expect(ipcModule.importerDiscardPreview).not.toHaveBeenCalledWith("token-commit-unmount");

      // Commit resolves
      await act(async () => {
        commitADeferred.resolve(1);
      });

      // Global store refresh must STILL run even after unmount!
      expect(ipcModule.listSessions).toHaveBeenCalled();
      expect(ipcModule.snippetList).toHaveBeenCalled();
    });
  });

  describe("S04: file read pending -> switch tab / close modal regressions", () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("file reading pending -> switch tab -> resolves late: does not restore old file, state remains clean", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<string>();
      const fileA = new File(["dummy"], "slow_backup.json", { type: "application/json" });
      (fileA as any).text = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      expect(document.body.textContent).toContain("读取中...");

      // User switches tab to OpenSSH before read finishes
      const opensshTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("OpenSSH 配置")
      );
      await act(async () => {
        opensshTabBtn!.click();
      });

      // File A read resolves late
      await act(async () => {
        fileADeferred.resolve('{"sessions":[{"name":"Stale Session"}]}');
      });

      // Switch back to restore tab
      await act(async () => {
        restoreTabBtn!.click();
      });

      // Verify: Old file was NOT populated, verify button is disabled
      const verifyBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("校验并预览")
      );
      expect(verifyBtn!.disabled).toBe(true);
    });

    it("file reading pending -> switch tab -> rejects late: does not crash or corrupt new tab", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<string>();
      const fileA = new File(["dummy"], "err_backup.json", { type: "application/json" });
      (fileA as any).text = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const opensshTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("OpenSSH 配置")
      );
      await act(async () => {
        opensshTabBtn!.click();
      });

      // File A read rejects late
      await act(async () => {
        fileADeferred.reject(new Error("File disk unreadable"));
      });

      // Tab remains healthy, no error banner displayed on OpenSSH tab
      expect(document.body.textContent).not.toContain("File disk unreadable");
    });

    it("file reading (json) pending -> modal unmounts -> late resolve: causes no errors", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<string>();
      const fileA = new File(["dummy"], "unmount_backup.json", { type: "application/json" });
      (fileA as any).text = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Unmount while reading
      await act(async () => {
        root.unmount();
      });

      // Late resolve after unmount
      await act(async () => {
        fileADeferred.resolve('{"sessions":[]}');
      });
      // No crash
    });

    it("file reading (json) pending -> modal unmounts -> late reject: causes no errors", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<string>();
      const fileA = new File(["dummy"], "unmount_err.json", { type: "application/json" });
      (fileA as any).text = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        root.unmount();
      });

      // Late reject after unmount
      await act(async () => {
        fileADeferred.reject(new Error("Disk unreadable on unmount"));
      });
      // No crash
    });

    it("file reading (osvault) pending -> switch tab -> late reject: does not crash or corrupt new tab", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<ArrayBuffer>();
      const fileA = new File(["dummy"], "err_backup.osvault", { type: "application/octet-stream" });
      (fileA as any).arrayBuffer = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const opensshTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("OpenSSH 配置")
      );
      await act(async () => {
        opensshTabBtn!.click();
      });

      // ArrayBuffer read rejects late
      await act(async () => {
        fileADeferred.reject(new Error("Encrypted vault corrupt"));
      });

      // Tab remains healthy, no error banner displayed on OpenSSH tab
      expect(document.body.textContent).not.toContain("Encrypted vault corrupt");
    });

    it("file reading (osvault) pending -> modal unmounts -> late resolve: causes no errors", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<ArrayBuffer>();
      const fileA = new File(["dummy"], "unmount_backup.osvault", { type: "application/octet-stream" });
      (fileA as any).arrayBuffer = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        root.unmount();
      });

      await act(async () => {
        fileADeferred.resolve(new ArrayBuffer(16));
      });
      // No crash
    });

    it("file reading (osvault) pending -> modal unmounts -> late reject: causes no errors", async () => {
      await act(async () => {
        root = createRoot(container);
        root.render(<ImportExportModal onClose={vi.fn()} />);
      });

      const restoreTabBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("恢复备份")
      );
      await act(async () => {
        restoreTabBtn!.click();
      });

      const fileInput = document.body.querySelector<HTMLInputElement>("input[type='file']")!;
      const fileADeferred = deferred<ArrayBuffer>();
      const fileA = new File(["dummy"], "unmount_err.osvault", { type: "application/octet-stream" });
      (fileA as any).arrayBuffer = vi.fn().mockReturnValue(fileADeferred.promise);

      await act(async () => {
        Object.defineProperty(fileInput, "files", { value: [fileA], configurable: true });
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await act(async () => {
        root.unmount();
      });

      await act(async () => {
        fileADeferred.reject(new Error("Encrypted unmount error"));
      });
      // No crash
    });
  });
});
