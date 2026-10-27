#!/usr/bin/env node
/**
 * 文案集中性检查：`frontend/src/updater/**` 里的中文只能出现在 `copy.ts`。
 *
 * 实现方式：先用一个小的字符扫描器剔除注释（保留字符串内容），再查找 CJK 字符。
 * 这样「中文注释」不会被误报，而「硬编码在 JSX 里的中文」一定会被抓到。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "frontend/src/updater");
/** 例外：文案文件本身，以及只用于断言的测试夹具。 */
const isAllowed = (name) => name === "copy.ts" || /\.test\.tsx?$/.test(name);
const CJK = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

/** 去掉注释，保留字符串字面量内容（字符串里的中文同样算违规）。 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

let violations = 0;
const files = statSync(targetDir).isDirectory() ? walk(targetDir) : [];
for (const file of files) {
  const name = relative(targetDir, file).replace(/\\/g, "/");
  if (isAllowed(name)) continue;
  const code = stripComments(readFileSync(file, "utf8"));
  code.split("\n").forEach((line, index) => {
    if (!CJK.test(line)) return;
    violations += 1;
    console.error(`\u2716 frontend/src/updater/${name}:${index + 1} 出现硬编码中文`);
    console.error(`    ${line.trim().slice(0, 120)}`);
  });
}

if (violations > 0) {
  console.error(`\n共 ${violations} 处：请把文案移到 frontend/src/updater/copy.ts`);
  process.exit(1);
}
console.log("\u2714 更新模块文案集中在 copy.ts");
