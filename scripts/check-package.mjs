#!/usr/bin/env node
/**
 * 构建产物体检：确保发布包里不夹带环境变量文件、服务端源码与任何密钥。
 *
 * 用法：node scripts/check-package.mjs [目录...]
 *   默认检查 `frontend/dist` 与 `artifacts`（存在才检查）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_DIRS = ["frontend/dist", "artifacts"];
const FORBIDDEN_PATH = [
  /(^|[\\/])\.env(\..*)?$/,
  /(^|[\\/])target[\\/]/,
  /(^|[\\/])backend[\\/]server[\\/]/,
  /(^|[\\/])\.git[\\/]/,
  /(^|[\\/])node_modules[\\/]/,
];
const FORBIDDEN_CONTENT = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /TAURI_SIGNING_PRIVATE_KEY\s*=/,
  /CLOUDFLARE_API_TOKEN\s*=/,
  /(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{16,}["']/i,
];

/** 这些文件天然是二进制，跳过内容扫描（仍会检查路径）。 */
const SKIP_CONTENT = /\.(exe|msi|dmg|AppImage|deb|png|ico|icns|woff2?|ttf|zip|gz)$/i;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DIRS;
const problems = [];
let scanned = 0;

for (const target of targets) {
  const dir = resolve(root, target);
  if (!existsSync(dir)) {
    console.log(`- 跳过（不存在）：${target}`);
    continue;
  }
  if (!statSync(dir).isDirectory()) continue;
  for (const file of walk(dir)) {
    scanned += 1;
    const rel = relative(root, file).replace(/\\/g, "/");
    if (FORBIDDEN_PATH.some((rule) => rule.test(rel))) {
      problems.push(`${rel}：不应出现在发布产物中`);
      continue;
    }
    if (SKIP_CONTENT.test(file)) continue;
    const size = statSync(file).size;
    if (size > 8 * 1024 * 1024) continue;
    const text = readFileSync(file, "utf8");
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.test(text)) {
        problems.push(`${rel}：疑似包含密钥或私钥内容`);
        break;
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`\u2716 ${problem}`);
  process.exit(1);
}
console.log(`\u2714 产物检查通过（扫描 ${scanned} 个文件）`);
