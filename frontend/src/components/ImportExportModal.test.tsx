import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { ImportExportModal } from "./ImportExportModal";
import * as ipcModule from "../lib/ipc";

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

const mockLoadSnippets = vi.fn().mockResolvedValue(undefined);
vi.mock("../stores/snippetStore", () => ({
  useSnippetStore: Object.assign(
    () => ({
      loadSnippets: mockLoadSnippets,
    }),
    {
      getState: () => ({
        loadSnippets: mockLoadSnippets,
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
    expect(mockLoadSnippets).toHaveBeenCalled();
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
});
