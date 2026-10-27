#!/usr/bin/env node
/**
 * 版本号单一来源工具。
 *
 * 真源：`frontend/package.json` 的 `version`。
 * 需要同步的派生位置：
 *   1. `Cargo.toml` 的 `[workspace.package].version`
 *   2. `backend/desktop/tauri.conf.json` 的 `version`
 *
 * 用法：
 *   node scripts/version.mjs            # 以 package.json 为准写回其余两处
 *   node scripts/version.mjs --check    # 只校验，不一致则退出码 1（CI 使用）
 *   node scripts/version.mjs --print    # 打印当前版本
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PKG_JSON = join(root, "frontend/package.json");
const CARGO_TOML = join(root, "Cargo.toml");
const TAURI_CONF = join(root, "backend/desktop/tauri.conf.json");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`\u2716 ${message}`);
  process.exit(1);
}

function readVersionFromPackage() {
  const raw = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  const version = String(raw.version ?? "").trim();
  if (!SEMVER.test(version)) {
    fail(`frontend/package.json 的 version 不是合法语义化版本：${version || "(空)"}`);
  }
  return version;
}

/** 读取 `[workspace.package]` 段里的 version（只在段内匹配，避免命中依赖版本）。 */
function readVersionFromCargo() {
  const text = readFileSync(CARGO_TOML, "utf8");
  const sectionMatch = /^\[workspace\.package\][^\[]*/m.exec(text);
  if (!sectionMatch) {
    fail("Cargo.toml 缺少 [workspace.package] 段");
  }
  const versionMatch = /^version\s*=\s*"([^"]+)"/m.exec(sectionMatch[0]);
  if (!versionMatch) {
    fail("Cargo.toml 的 [workspace.package] 缺少 version 字段");
  }
  return versionMatch[1];
}

function readVersionFromTauri() {
  const raw = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const version = String(raw.version ?? "").trim();
  if (!version) {
    fail("backend/desktop/tauri.conf.json 缺少 version 字段");
  }
  return version;
}

/** 只替换 `[workspace.package]` 段内的 version 行，保留其余格式。 */
function writeCargoVersion(version) {
  const text = readFileSync(CARGO_TOML, "utf8");
  const sectionMatch = /^(\[workspace\.package\][^\[]*)/m.exec(text);
  if (!sectionMatch) {
    fail("Cargo.toml 缺少 [workspace.package] 段");
  }
  const section = sectionMatch[1];
  const nextSection = section.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  if (nextSection === section) {
    return false;
  }
  writeFileSync(CARGO_TOML, text.replace(section, nextSection), "utf8");
  return true;
}

/** 用文本替换改写 version，避免 JSON.stringify 重排整个配置文件。 */
function writeTauriVersion(version) {
  const text = readFileSync(TAURI_CONF, "utf8");
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text) {
    return false;
  }
  writeFileSync(TAURI_CONF, next, "utf8");
  return true;
}

function main() {
  for (const file of [PKG_JSON, CARGO_TOML, TAURI_CONF]) {
    if (!existsSync(file)) {
      fail(`找不到版本文件：${file}`);
    }
  }

  const source = readVersionFromPackage();
  const cargoVersion = readVersionFromCargo();
  const tauriVersion = readVersionFromTauri();
  const args = process.argv.slice(2);

  if (args.includes("--print")) {
    console.log(source);
    return;
  }

  const mismatched = [
    ["Cargo.toml [workspace.package].version", cargoVersion],
    ["backend/desktop/tauri.conf.json #version", tauriVersion],
  ].filter(([, value]) => value !== source);

  if (args.includes("--check")) {
    if (mismatched.length > 0) {
      console.error(`\u2716 版本号不一致，真源 frontend/package.json = ${source}`);
      for (const [where, value] of mismatched) {
        console.error(`  - ${where} = ${value}`);
      }
      console.error("运行 `pnpm version:write` 自动同步。");
      process.exit(1);
    }
    console.log(`\u2714 三处版本号一致：${source}`);
    return;
  }

  let changed = false;
  if (cargoVersion !== source) {
    changed = writeCargoVersion(source) || changed;
  }
  if (tauriVersion !== source) {
    changed = writeTauriVersion(source) || changed;
  }
  console.log(
    changed
      ? `\u2714 已把版本号同步为 ${source}（Cargo.toml / tauri.conf.json）`
      : `\u2714 版本号已经是 ${source}，无需修改`,
  );
}

main();
