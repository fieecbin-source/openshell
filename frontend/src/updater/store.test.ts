import { afterEach, expect, it, vi } from "vitest";
import * as api from "./ipc";
import { useUpdaterStore } from "./store";
import type { UpdateCheckResult } from "./types";

vi.mock("./ipc", () => ({ installUpdate: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  useUpdaterStore.setState({ state: { kind: "idle" }, installHint: null });
});

it("retries the downloaded installer after a launch failure", async () => {
  const result: UpdateCheckResult = {
    has_update: true, current_version: "1.1.1", latest_version: "1.1.4",
    tag: "v1.1.4", release_name: "OpenShell 1.1.4", release_notes: "", notes_html: "",
    asset: { name: "OpenShell.exe", url: "https://github.com/a/b/x.exe", size: 1, sha256: "0".repeat(64) },
    mandatory: false, channel: "stable", from_cache: false,
    release_page_url: "https://github.com/a/b/releases", source: "github", checked_at_ms: 1,
  };
  const error = { code: "UPDATE_INSTALL_FAILED", message: "cancelled", retryable: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(api.installUpdate).mockRejectedValueOnce(error).mockResolvedValueOnce({
    strategy: "self_install", launched: true,
  });
  useUpdaterStore.setState({ state: { kind: "ready", result, path: "C:/Downloads/OpenShell.exe" } });

  await useUpdaterStore.getState().install();
  expect(useUpdaterStore.getState().state).toMatchObject({ kind: "install_failed" });
  await useUpdaterStore.getState().install();
  expect(api.installUpdate).toHaveBeenCalledTimes(2);
  expect(api.installUpdate).toHaveBeenLastCalledWith("C:/Downloads/OpenShell.exe", result.asset, "1.1.4");
});
