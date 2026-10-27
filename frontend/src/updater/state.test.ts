import { describe, expect, it } from "vitest";
import {
  currentResult,
  isBusy,
  isMandatory,
  progressPercent,
  reduce,
  shouldShowBadge,
  type UpdateState,
} from "./state";
import type { DownloadProgress, UpdateCheckResult } from "./types";

function result(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    has_update: true,
    current_version: "1.0.1",
    latest_version: "1.1.0",
    tag: "v1.1.0",
    release_name: "OpenShell 1.1.0",
    release_notes: "- 新增自动更新",
    notes_html: "<ul><li>新增自动更新</li></ul>",
    published_at: "2026-10-27T00:00:00Z",
    asset: {
      name: "OpenShell-1.1.0-windows-x86_64.exe",
      url: "https://github.com/a/b/releases/download/v1.1.0/x.exe",
      size: 1024,
      sha256: "0".repeat(64),
    },
    mandatory: false,
    channel: "stable",
    from_cache: false,
    release_page_url: "https://github.com/a/b/releases",
    source: "github",
    checked_at_ms: 1,
    ...overrides,
  };
}

const progress = (overrides: Partial<DownloadProgress> = {}): DownloadProgress => ({
  received: 512,
  total: 1024,
  percent: 50,
  bytes_per_sec: 256,
  phase: "downloading",
  ...overrides,
});

describe("update state machine", () => {
  it("starts from idle and reports checking", () => {
    const next = reduce({ kind: "idle" }, { type: "check_started", manual: true });
    expect(next).toEqual({ kind: "checking", manual: true });
  });

  it("maps check results to available / latest", () => {
    const available = reduce({ kind: "checking", manual: false }, {
      type: "check_succeeded",
      result: result(),
    });
    expect(available.kind).toBe("available");

    const latest = reduce({ kind: "checking", manual: false }, {
      type: "check_succeeded",
      result: result({ has_update: false }),
    });
    expect(latest.kind).toBe("latest");
  });

  it("keeps an available update when a background check fails", () => {
    const state: UpdateState = { kind: "available", result: result() };
    const next = reduce(state, { type: "check_failed", error: "boom", retryable: true });
    expect(next).toBe(state);
  });

  it("reports check failures only when nothing is pending", () => {
    const next = reduce({ kind: "idle" }, { type: "check_failed", error: "boom", retryable: true });
    expect(next).toEqual({ kind: "check_failed", error: "boom", retryable: true });
  });

  it("walks the happy path to ready", () => {
    const available: UpdateState = { kind: "available", result: result() };
    const downloading = reduce(available, { type: "download_started" });
    expect(downloading.kind).toBe("downloading");
    expect(progressPercent(downloading)).toBe(0);

    const progressing = reduce(downloading, { type: "download_progress", progress: progress() });
    expect(progressPercent(progressing)).toBe(50);

    const verifying = reduce(progressing, {
      type: "download_progress",
      progress: progress({ phase: "verifying", percent: 100 }),
    });
    expect(verifying.kind).toBe("verifying");

    const ready = reduce(verifying, { type: "download_succeeded", path: "/tmp/x.exe" });
    expect(ready).toEqual({ kind: "ready", result: result(), path: "/tmp/x.exe" });
    expect(currentResult(ready)?.latest_version).toBe("1.1.0");
  });

  it("returns to available when the download is cancelled", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      result: result(),
      progress: progress(),
    };
    const next = reduce(downloading, { type: "download_cancelled" });
    expect(next.kind).toBe("available");
    expect(isBusy(next)).toBe(false);
  });

  it("does not let a new check clobber an in-flight download", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      result: result(),
      progress: progress(),
    };
    expect(reduce(downloading, { type: "check_started", manual: true })).toBe(downloading);
  });

  it("reports download and install failures with retryable flags", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      result: result(),
      progress: progress(),
    };
    const failed = reduce(downloading, {
      type: "download_failed",
      error: "offline",
      retryable: true,
    });
    expect(failed.kind).toBe("download_failed");

    const ready: UpdateState = { kind: "ready", result: result(), path: "/tmp/x.exe" };
    const installFailed = reduce(ready, {
      type: "install_failed",
      error: "denied",
      retryable: false,
    });
    expect(installFailed.kind).toBe("install_failed");
  });

  it("dismissing clears transient states but keeps a pending update", () => {
    expect(reduce({ kind: "check_failed", error: "x", retryable: true }, { type: "dismissed" })).toEqual({
      kind: "idle",
    });
    const available: UpdateState = { kind: "available", result: result() };
    expect(reduce(available, { type: "dismissed" })).toBe(available);
  });

  it("derives badge and mandatory flags", () => {
    const available: UpdateState = { kind: "available", result: result() };
    expect(shouldShowBadge(available)).toBe(true);
    expect(isMandatory(available)).toBe(false);

    const mandatory: UpdateState = { kind: "available", result: result({ mandatory: true }) };
    expect(isMandatory(mandatory)).toBe(true);

    expect(shouldShowBadge({ kind: "latest", result: result({ has_update: false }) })).toBe(false);
    expect(isMandatory({ kind: "idle" })).toBe(false);
  });
});
