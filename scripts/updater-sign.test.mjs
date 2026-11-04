import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "openshell-sign-test-"));
after(() => {
  assert.equal(dirname(fixture), resolve(tmpdir()));
  rmSync(fixture, { recursive: true });
});
const meta = join(fixture, "update-meta.json");
const sig = `${meta}.sig`;
const key = join(fixture, "test.key");
const pub = join(fixture, "test.pub");

function run(...args) {
  return spawnSync(process.execPath, [join(repo, "scripts/updater-sign.mjs"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

assert.equal(run("keygen", "--id", "test", "--out", fixture).status, 0);
const publicKey = readFileSync(pub, "utf8");
writeFileSync(meta, JSON.stringify({ assets: [] }));
assert.equal(run("sign", "--key", key, "--meta", meta, "--out", sig).status, 0);
const signature = readFileSync(sig, "utf8");
const verify = () => run("verify", "--meta", meta, "--sig", sig, "--keys-dir", fixture);

test("verification rejects unknown and revoked key states", () => {
  for (const status of ["active", "current", "next", "revoked", "typo"]) {
    writeFileSync(pub, publicKey.replace("status = active", `status = ${status}`));
    assert.equal(verify().status, ["active", "current", "next"].includes(status) ? 0 : 1, status);
  }
  writeFileSync(pub, publicKey);
});

test("verification requires an entry for the manifest key id", () => {
  writeFileSync(pub, publicKey.replace("key_id = test", "key_id = other"));
  const changed = JSON.parse(signature);
  changed.signatures[0].key_id = "other";
  writeFileSync(sig, JSON.stringify(changed));
  assert.equal(verify().status, 1);
  writeFileSync(pub, publicKey);
  writeFileSync(sig, signature);
});

test("signing rejects a secondary private key inside the repository", () => {
  const result = run("sign", "--key", key, "--also-key", join(repo, "package.json"),
    "--meta", meta, "--out", sig);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /私钥不能位于仓库内/);
});

test("verification rejects a tampered manifest", () => {
  writeFileSync(meta, readFileSync(meta, "utf8") + " ");
  assert.equal(verify().status, 1);
});
