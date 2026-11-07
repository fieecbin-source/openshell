import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { ImportExportModal } from "./ImportExportModal";
import * as ipcModule from "../lib/ipc";

import { useSnippetStore } from "../stores/snippetStore";

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
}));

vi.mock("../stores/sessionStore", () => ({
  useSessionStore: Object.assign(
    () => ({
      loadAll: vi.fn().mockResolvedValue(undefined),
    }),
    {
      getState: () => ({
        loadAll: vi.fn().mockResolvedValue(undefined),
      }),
    }
  ),
}));

const fillTextarea = (val: string) =>
  act(() => {
    const el = document.body.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

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
    vi.mocked(ipcModule.snippetList).mockResolvedValue([]);
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
  });
});
