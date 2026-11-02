import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("./release.mjs", import.meta.url));

test("release notes use the current Chinese changelog and reach both manifests", () => {
  const dir = mkdtempSync(join(tmpdir(), "openshell-release-"));
  try {
    const notesPath = join(dir, "release-notes.md");
    execFileSync(process.execPath, [script, "notes", "--out", notesPath]);
    const notes = readFileSync(notesPath, "utf8");
    const version = JSON.parse(readFileSync(new URL("../frontend/package.json", import.meta.url))).version;
    assert.ok(notes.startsWith(`## OpenShell ${version}\n`));
    assert.match(notes, /### 修复/);
    assert.doesNotMatch(notes, /\[Unreleased\]|## \[1\.0\.0\]/);
    writeFileSync(join(dir, "assets-windows.json"), JSON.stringify({ platform: "windows", arch: "x86_64", files: [] }));
    execFileSync(process.execPath, [script, "manifest", "--dir", dir, "--version", version]);
    for (const name of ["update-meta.json", "latest.json"]) {
      const bytes = readFileSync(join(dir, name));
      assert.equal(JSON.parse(bytes).notes, notes);
      assert.equal(bytes.includes(13), false);
      assert.notEqual(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
