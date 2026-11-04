#!/usr/bin/env node
/**
 * 升级演练 · 发布侧自检（可自动化部分）。
 *
 * 校验一个 GitHub Release 的元数据是否自洽，避免「装了才发现清单不对」：
 *   1. 资产命名是否符合 `OpenShell-<version>-<platform>-<arch>.<ext>`；
 *   2. `SHA256SUMS.txt` 是否覆盖全部安装包，哈希格式是否合法；
 *   3. `update-meta.json` 里的 sha256 是否与清单一致；
 *   4. `update-meta.json.sig` 是否存在，且能用仓库内置公钥验签；
 *   5. 预发布 tag（含 `-`）必须标记为 prerelease，且**不得**提供正式 `latest.json`。
 *
 * 用法：
 *   node scripts/e2e-upgrade/check-release.mjs --repo fieecbin-source/openshell --tag v1.0.2-rc.1
 *   node scripts/e2e-upgrade/check-release.mjs --repo owner/repo --tag v1.1.0 --allow-draft
 *
 * 退出码：0 = 全部通过；1 = 存在问题（逐条打印）；2 = 取数失败（网络/权限）。
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLER = /^OpenShell-(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?<platform>windows|macos|linux)-(?<arch>x86_64|aarch64|universal)\.(?<ext>exe|msi|dmg|AppImage|deb)$/;
const HEX64 = /^[0-9a-f]{64}$/i;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYS_DIR = join(REPO_ROOT, "backend", "crates", "updater", "keys");

/** 解析 `key_id=... / status=... / public_key=...` 格式的公钥文件。 */
function loadTrustedKeys() {
  if (!existsSync(KEYS_DIR)) return [];
  return readdirSync(KEYS_DIR)
    .filter((name) => extname(name) === ".pub")
    .map((name) => {
      const fields = {};
      for (const line of readFileSync(join(KEYS_DIR, name), "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        fields[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
      }
      if (!fields.key_id || !fields.public_key) return null;
      try {
        return {
          file: name,
          keyId: fields.key_id,
          status: (fields.status ?? "active").toLowerCase(),
          publicKey: createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: fields.public_key },
            format: "jwk",
          }),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const repo = String(arg("repo") ?? "fieecbin-source/openshell");
const tag = arg("tag");
if (!tag) {
  console.error("用法：node scripts/e2e-upgrade/check-release.mjs --repo <owner/repo> --tag <tag>");
  process.exit(2);
}

const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
let release;
try {
  const response = await fetch(api, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openshell-e2e-check" },
  });
  if (!response.ok) {
    console.error(`取 Release 失败：HTTP ${response.status} ${response.statusText}`);
    process.exit(2);
  }
  release = await response.json();
} catch (err) {
  console.error(`取 Release 失败：${err.message}`);
  process.exit(2);
}

const problems = [];
const notes = [];
const assets = release.assets ?? [];
const byName = new Map(assets.map((asset) => [asset.name, asset]));

if (release.draft && !arg("allow-draft", false)) {
  problems.push("Release 仍是草稿：请先在 GitHub 上 Publish 再跑演练");
}

const isPrereleaseTag = tag.includes("-");
if (isPrereleaseTag && !release.prerelease) {
  problems.push(`tag ${tag} 含预发布后缀，但 Release 未标记 prerelease`);
}
if (!isPrereleaseTag && release.prerelease) {
  problems.push(`正式 tag ${tag} 被标记为 prerelease`);
}

// 1) 安装包命名
const installers = [];
for (const asset of assets) {
  const match = INSTALLER.exec(asset.name);
  if (match) {
    installers.push({ asset, ...match.groups });
    if (!tag.startsWith(`v${match.groups.version}`)) {
      problems.push(`资产 ${asset.name} 的版本与 tag ${tag} 不一致`);
    }
    continue;
  }
  const suspicious = /\.(exe|msi|dmg|AppImage|deb)$/i.test(asset.name);
  if (suspicious) {
    problems.push(`资产 ${asset.name} 不符合命名规范 OpenShell-<version>-<platform>-<arch>.<ext>`);
  }
}
if (installers.length === 0) {
  problems.push("Release 里没有符合命名规范的安装包");
}
notes.push(`安装包数量：${installers.length}`);

// 2) SHA256SUMS.txt
const sumsAsset = byName.get("SHA256SUMS.txt");
const sums = new Map();
if (!sumsAsset) {
  problems.push("缺少 SHA256SUMS.txt：客户端会拒绝自动安装");
} else {
  const text = await (await fetch(sumsAsset.browser_download_url)).text();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s{1,2}(.+)$/i.exec(line.trim());
    if (!match) continue;
    sums.set(match[2].trim(), match[1].toLowerCase());
  }
  for (const { asset } of installers) {
    if (!sums.has(asset.name)) {
      problems.push(`SHA256SUMS.txt 未覆盖 ${asset.name}`);
    }
  }
  notes.push(`SHA256SUMS.txt 条目：${sums.size}`);
}

// 3) update-meta.json 与清单一致
let metaText = null;
const metaAsset = byName.get("update-meta.json");
if (!metaAsset) {
  problems.push("缺少 update-meta.json：客户端无法判断强制更新与最低支持版本");
} else {
  metaText = await (await fetch(metaAsset.browser_download_url)).text();
  const meta = JSON.parse(metaText);
  if (typeof meta.mandatory !== "boolean") {
    problems.push("update-meta.json 缺少布尔字段 mandatory");
  }
  if (typeof meta.key_id !== "string" || meta.key_id.trim() === "") {
    problems.push("update-meta.json 缺少 key_id：客户端无法选择签名公钥");
  }
  for (const item of meta.assets ?? []) {
    if (!HEX64.test(item.sha256 ?? "")) {
      problems.push(`update-meta.json 中 ${item.name} 的 sha256 格式非法`);
    }
    if (sums.has(item.name) && sums.get(item.name) !== item.sha256.toLowerCase()) {
      problems.push(`update-meta.json 与 SHA256SUMS.txt 对 ${item.name} 的哈希不一致`);
    }
  }
  notes.push(`update-meta.json 声明资产：${(meta.assets ?? []).length}，mandatory=${meta.mandatory}`);
}

// 4) 清单签名：缺失或验签失败都视为发布不合格（客户端会拒绝自动安装）
const sigAsset = byName.get("update-meta.json.sig");
if (!sigAsset) {
  problems.push("缺少 update-meta.json.sig：客户端会拒绝自动安装");
} else if (metaText !== null) {
  const signatureText = await (await fetch(sigAsset.browser_download_url)).text();
  try {
    const signatureFile = JSON.parse(signatureText);
    const meta = JSON.parse(metaText);
    if (signatureFile.version !== 1) {
      problems.push("update-meta.json.sig 的 version 不是 1");
    } else if (!Array.isArray(signatureFile.signatures) || signatureFile.signatures.length === 0) {
      problems.push("update-meta.json.sig 没有签名条目");
    } else {
      const keys = loadTrustedKeys();
      if (keys.length === 0) {
        problems.push(`仓库未内置更新签名公钥（${KEYS_DIR}），无法验证发布签名`);
      } else {
        const manifestKeyId = String(meta.key_id ?? "").trim();
        if (!signatureFile.signatures.some((entry) => entry.key_id === manifestKeyId)) {
          problems.push("签名条目没有覆盖 update-meta.json 声明的 key_id");
        }
        const verified = signatureFile.signatures.some((entry) => {
          if (String(entry.alg ?? "ed25519").toLowerCase() !== "ed25519") return false;
          const key = keys.find((candidate) => candidate.keyId === entry.key_id);
          if (!key || key.status === "revoked") return false;
          try {
            return verifySignature(
              null,
              Buffer.from(metaText),
              key.publicKey,
              Buffer.from(entry.signature, "base64url"),
            );
          } catch {
            return false;
          }
        });
        if (verified) {
          notes.push(`清单签名验证通过：key_id=${signatureFile.signatures[0].key_id}`);
        } else {
          problems.push("update-meta.json.sig 验签失败（内容被篡改、key 未内置或 key 已吊销）");
        }
      }
    }
  } catch (err) {
    problems.push(`无法解析或验证 update-meta.json.sig：${err.message}`);
  }
}

// 5) 预发布不得污染正式检测源
if (isPrereleaseTag && byName.has("latest.json")) {
  problems.push("预发布 Release 不应附带 latest.json（会污染稳定通道的备用检测源）");
}

console.log(`\nRelease: ${repo}@${tag}   prerelease=${release.prerelease} draft=${release.draft}`);
for (const line of notes) console.log(`  · ${line}`);

if (problems.length > 0) {
  console.error("\n发现以下问题：");
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  process.exit(1);
}
console.log("\n✔ 发布侧元数据自检通过");
