#!/usr/bin/env node
/**
 * 更新签名工具（离线执行）。
 *
 * 子命令：
 *   keygen  —— 生成 Ed25519 密钥对；私钥写到仓库之外的离线目录
 *   sign    —— 对 `update-meta.json` 签名，产出 `update-meta.json.sig`，可选同步 `latest.json`
 *   verify  —— 用仓库内的公钥验证签名（发布自检 / 排障）
 *
 * 安全约束：
 *   * 私钥文件（`*.key`）**不允许**落在仓库目录内，脚本会直接拒绝；
 *   * 脚本不打印私钥内容，不把私钥写入日志；
 *   * 仓库只提交 `backend/crates/updater/keys/<key-id>.pub` 与文档。
 *
 * 示例：
 *   node scripts/updater-sign.mjs keygen --id openshell-updater-2026a --out D:\\openshell-keys
 *   node scripts/updater-sign.mjs sign \
 *       --key D:\\openshell-keys\\openshell-updater-2026a.key \
 *       --meta artifacts\\update-meta.json \
 *       --out artifacts\\update-meta.json.sig \
 *       --latest artifacts\\latest.json
 *   node scripts/updater-sign.mjs verify --meta artifacts\\update-meta.json --sig artifacts\\update-meta.json.sig
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_DIR = join(REPO_ROOT, "backend", "crates", "updater", "keys");
const SIGNATURE_VERSION = 1;

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    const text = readFileSync(path, "utf8");
    return { text, value: JSON.parse(text) };
  } catch (err) {
    fail(`读取${label}失败：${path}（${err.message}）`);
  }
}

function withinRepo(path) {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 解析 `key_id=... / status=... / public_key=...` 格式的公钥文件。 */
function parsePub(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    fields[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  if (!fields.key_id || !fields.public_key) throw new Error("公钥文件缺少 key_id 或 public_key");
  return {
    keyId: fields.key_id,
    status: (fields.status ?? "active").toLowerCase(),
    publicKey: createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: fields.public_key },
      format: "jwk",
    }),
  };
}

function loadTrustedKeys(dir = KEYS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => extname(name) === ".pub")
    .map((name) => {
      try {
        return { file: name, ...parsePub(readFileSync(join(dir, name), "utf8")) };
      } catch (err) {
        console.warn(`  忽略无法解析的公钥 ${name}：${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function keygen() {
  const keyId = arg("id");
  const outDir = arg("out");
  const status = String(arg("status", "active")).toLowerCase();
  if (!keyId || typeof keyId !== "string") fail("keygen 需要 --id <key-id>");
  if (!outDir || typeof outDir !== "string") fail("keygen 需要 --out <离线目录>");
  if (!/^[A-Za-z0-9._-]+$/.test(keyId)) fail("--id 只允许字母、数字、点、下划线和短横线");
  if (!["active", "next"].includes(status)) fail("--status 只能是 active 或 next");
  if (withinRepo(outDir)) {
    fail("私钥目录不能位于仓库内；请使用仓库之外的离线目录（例如加密磁盘）");
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });

  mkdirSync(outDir, { recursive: true });
  const keyPath = join(outDir, `${keyId}.key`);
  const pubPath = join(outDir, `${keyId}.pub`);
  if (existsSync(keyPath) || existsSync(pubPath)) {
    fail("目标密钥已存在；请换一个 --id，避免覆盖离线私钥");
  }

  writeFileSync(
    keyPath,
    `${JSON.stringify(
      {
        format: "openshell-updater-key-v1",
        key_id: keyId,
        alg: "ed25519",
        created: new Date().toISOString().slice(0, 10),
        public_key: publicJwk.x,
        private_key: privateJwk.d,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，权限仍需依赖目录 ACL。
  }

  writeFileSync(
    pubPath,
    `# OpenShell update signing public key (commit this file, never the private key)
key_id = ${keyId}
status = ${status}
created = ${new Date().toISOString().slice(0, 10)}
public_key = ${publicJwk.x}
`,
  );

  console.log(`✔ 私钥：${keyPath}（离线保存，权限 0600，禁止入库/上传/贴日志）`);
  console.log(`✔ 公钥：${pubPath}（复制到 ${join(KEYS_DIR, `${keyId}.pub`)} 后提交）`);
}

function loadPrivateKey(path) {
  const parsed = readJson(path, "私钥");
  if (parsed.value.format !== "openshell-updater-key-v1" || parsed.value.alg !== "ed25519") {
    fail("私钥文件格式不受支持");
  }
  if (!parsed.value.key_id || !parsed.value.private_key) fail("私钥文件缺少 key_id/private_key");
  return {
    keyId: parsed.value.key_id,
    key: createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: parsed.value.public_key,
        d: parsed.value.private_key,
      },
      format: "jwk",
    }),
  };
}

function sign() {
  const keyPath = arg("key");
  const alsoPath = arg("also-key", null);
  const metaPath = arg("meta");
  const outPath = arg("out");
  const latestPath = arg("latest", null);
  if (!keyPath || typeof keyPath !== "string") fail("sign 需要 --key <私钥文件>");
  if (!metaPath || typeof metaPath !== "string") fail("sign 需要 --meta <update-meta.json>");
  if (!outPath || typeof outPath !== "string") fail("sign 需要 --out <update-meta.json.sig>");
  if (withinRepo(keyPath)) fail("私钥不能位于仓库内");

  const primary = loadPrivateKey(keyPath);
  const extra = alsoPath && typeof alsoPath === "string" ? [loadPrivateKey(alsoPath)] : [];

  const meta = readJson(metaPath, "更新清单");
  // key_id 属于被签名内容：由主密钥写入后再序列化，避免清单与签名文件不同步。
  meta.value.key_id = primary.keyId;
  const manifestText = `${JSON.stringify(meta.value, null, 2)}\n`;
  writeFileSync(metaPath, manifestText);

  const signers = [primary, ...extra];
  const signatures = signers.map((signer) => ({
    key_id: signer.keyId,
    alg: "ed25519",
    signature: signPayload(null, Buffer.from(manifestText), signer.key).toString("base64url"),
  }));

  const signatureText = `${JSON.stringify(
    { version: SIGNATURE_VERSION, file: "update-meta.json", signatures },
    null,
    2,
  )}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, signatureText);

  if (latestPath && typeof latestPath === "string") {
    const latest = readJson(latestPath, "latest.json");
    latest.value.manifest = manifestText;
    latest.value.signature = signatureText;
    writeFileSync(latestPath, `${JSON.stringify(latest.value, null, 2)}\n`);
    console.log(`✔ latest.json 已内嵌签名清单：${latestPath}`);
  }

  console.log(`✔ 清单已签名：${metaPath}`);
  console.log(`  签名文件：${outPath}`);
  console.log(`  签名密钥：${signers.map((signer) => signer.keyId).join(", ")}`);
}

function verify() {
  const metaPath = arg("meta");
  const sigPath = arg("sig");
  if (!metaPath || typeof metaPath !== "string") fail("verify 需要 --meta <update-meta.json>");
  if (!sigPath || typeof sigPath !== "string") fail("verify 需要 --sig <update-meta.json.sig>");

  const manifestText = readFileSync(metaPath, "utf8");
  const meta = JSON.parse(manifestText);
  const signatureFile = readJson(sigPath, "签名文件").value;
  if (signatureFile.version !== SIGNATURE_VERSION) fail("签名文件版本不受支持");
  if (!meta.key_id) fail("清单缺少 key_id");
  if (!Array.isArray(signatureFile.signatures) || signatureFile.signatures.length === 0) {
    fail("签名文件没有签名条目");
  }

  const keysDir = arg("keys-dir", KEYS_DIR);
  const keys = loadTrustedKeys(typeof keysDir === "string" ? keysDir : KEYS_DIR);
  if (keys.length === 0) fail(`没有可用公钥（${keysDir}）；请先提交公钥文件`);

  let sawUnknown = false;
  let sawRevoked = false;
  for (const entry of signatureFile.signatures) {
    if (String(entry.alg).toLowerCase() !== "ed25519") continue;
    const key = keys.find((candidate) => candidate.keyId === entry.key_id);
    if (!key) {
      sawUnknown = true;
      continue;
    }
    if (key.status === "revoked") {
      sawRevoked = true;
      continue;
    }
    const ok = verifyPayload(
      null,
      Buffer.from(manifestText),
      key.publicKey,
      Buffer.from(entry.signature, "base64url"),
    );
    if (ok) {
      console.log(`✔ 验签通过：key_id=${entry.key_id}（${key.file}）`);
      return;
    }
  }

  if (sawRevoked) fail("签名使用了已吊销的 key");
  if (sawUnknown) fail("签名使用了仓库未内置的 key");
  fail("签名与清单内容不匹配");
}

const command = process.argv[2];
switch (command) {
  case "keygen":
    keygen();
    break;
  case "sign":
    sign();
    break;
  case "verify":
    verify();
    break;
  default:
    console.error(
      "用法：node scripts/updater-sign.mjs <keygen|sign|verify> ...（详见文件头注释）",
    );
    process.exit(2);
}
