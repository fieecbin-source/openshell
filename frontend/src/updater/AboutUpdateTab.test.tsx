import { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { AboutUpdateTab } from "./AboutUpdateTab";
import { useUpdaterStore } from "./store";
import type { BackupInfo, UpdateConfig } from "./types";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

describe("AboutUpdateTab Backup UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);

    const testConfig: UpdateConfig = {
      owner: "fieecbin-source",
      repo: "openshell",
      proxy: { mode: "system" },
      allow_downgrade: false,
      auto_check: true,
      interval_hours: 6,
      channel: "stable",
      fallback_source: null,
      mirror_prefix: null,
      backup_keep: 5,
    };

    useUpdaterStore.setState({
      state: { kind: "idle" },
      config: testConfig,
      appInfo: {
        version: "1.0.0",
        target: "windows",
        arch: "x86_64",
        data_dir: "C:/Users/test/AppData/OpenShell",
        schema_version: 1,
        degraded: false,
        is_portable: false,
      },
      runtime: {
        current_version: "1.0.0",
        latest_version: null,
        backups_dir: "C:/data/backups",
        skipped_versions: [],
        last_error: null,
        data_dir: "C:/Users/test/AppData/OpenShell",
      } as any,
      refreshRuntime: vi.fn().mockResolvedValue(undefined),
    });
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

  it("displays red failure message when backupNow rejects", async () => {
    const backupNowMock = vi.fn().mockRejectedValue(new Error("Disk IO failure"));
    useUpdaterStore.setState({ backupNow: backupNowMock });

    await act(async () => {
      root = createRoot(container);
      root.render(<AboutUpdateTab />);
    });

    const backupBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("立即备份数据")
    );
    expect(backupBtn).toBeTruthy();

    await act(async () => {
      backupBtn!.click();
    });

    expect(backupNowMock).toHaveBeenCalled();
    expect(document.body.textContent).toContain("备份失败");
    expect(document.body.querySelector(".text-\\[\\#d70015\\]")).toBeTruthy();
    expect(document.body.querySelector(".text-\\[\\#1a7f37\\]")).toBeNull();
  });

  it("displays green success message with file details when backupNow resolves", async () => {
    const mockBackup: BackupInfo = {
      file_name: "openshell_manual_2026.db",
      path: "C:/data/backups/openshell_manual_2026.db",
      size_bytes: 50000,
      created_at_ms: Date.now(),
      reason: "manual",
      app_version: "1.0.0",
    };
    const backupNowMock = vi.fn().mockResolvedValue(mockBackup);
    useUpdaterStore.setState({ backupNow: backupNowMock });

    await act(async () => {
      root = createRoot(container);
      root.render(<AboutUpdateTab />);
    });

    const backupBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("立即备份数据")
    );
    expect(backupBtn).toBeTruthy();

    await act(async () => {
      backupBtn!.click();
    });

    expect(backupNowMock).toHaveBeenCalled();
    expect(document.body.textContent).toContain("备份成功：openshell_manual_2026.db");
    expect(document.body.querySelector(".text-\\[\\#1a7f37\\]")).toBeTruthy();
    expect(document.body.querySelector(".text-\\[\\#d70015\\]")).toBeNull();
  });
});
