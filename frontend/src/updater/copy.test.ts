import { describe, expect, it } from "vitest";
import {
  UPDATE_COPY,
  UPDATE_ERROR_COPY,
  describeUpdateError,
  formatBytes,
  formatRemaining,
  formatSpeed,
} from "./copy";

/** 递归收集所有文案节点，确保没有空字符串（漏翻会立刻暴露）。 */
function collectStrings(node: unknown, path: string[] = []): { path: string; value: string }[] {
  if (typeof node === "string") return [{ path: path.join("."), value: node }];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
      collectStrings(value, [...path, key])
    );
  }
  return [];
}

describe("updater copy", () => {
  it("has no empty text nodes", () => {
    const nodes = collectStrings(UPDATE_COPY);
    expect(nodes.length).toBeGreaterThan(40);
    for (const node of nodes) {
      expect(node.value.trim(), `empty copy at ${node.path}`).not.toBe("");
    }
  });

  it("covers every update error code the backend can return", () => {
    const required = [
      "UPDATE_CHECK_FAILED",
      "UPDATE_ASSET_NOT_FOUND",
      "UPDATE_CHECKSUM_MISMATCH",
      "UPDATE_CHECKSUM_MISSING",
      "UPDATE_INSUFFICIENT_DISK",
      "UPDATE_INSTALL_FAILED",
      "UPDATE_DOWNLOAD",
      "UPDATE_SIGNATURE",
      "SCHEMA_NEWER_THAN_APP",
      "RATE_LIMITED",
      "CANCELLED",
    ];
    for (const code of required) {
      expect(UPDATE_ERROR_COPY[code], `missing copy for ${code}`).toBeTruthy();
    }
  });

  it("translates a known ipc error into a friendly sentence", () => {
    const message = describeUpdateError({
      code: "UPDATE_CHECKSUM_MISMATCH",
      message: "downloaded file does not match the published sha256",
    });
    expect(message).toBe(UPDATE_ERROR_COPY.UPDATE_CHECKSUM_MISMATCH);
  });

  it("falls back to a generic sentence for unknown failures", () => {
    expect(describeUpdateError({ code: "SOMETHING_ELSE", message: "" })).toBe(
      UPDATE_COPY.errors.generic
    );
  });

  it("formats sizes, speeds and remaining time", () => {
    expect(formatBytes(0)).toContain("0");
    expect(formatBytes(1024 * 1024 * 12)).toContain("12");
    expect(formatSpeed(1024 * 1024)).toContain(UPDATE_COPY.units.perSecond);
    expect(formatRemaining(0, 1024 * 1024, 1024 * 1024)).toContain(UPDATE_COPY.units.second);
    // 未知总量时不渲染剩余时间
    expect(formatRemaining(10, undefined, 100)).toBe("");
  });
});
