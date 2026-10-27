#!/usr/bin/env node
/**
 * 发布辅助脚本（把「打 tag」到「生成 Release」之间所有机械步骤收敛到一处）。
 *
 * 子命令：
 *   node scripts/release.mjs check  [--tag v1.2.3]      版本/tag/CHANGELOG 一致性
 *   node scripts/release.mjs notes  [--from v1.1.0] [--out notes.md]
 *   node scripts/release.mjs assets  --root target --version 1.2.3 --platform windows --arch x86_64 --out artifacts
 *   node scripts/release.mjs manifest --dir artifacts --version 1.2.3 --tag v1.2.3 [--mandatory] [--min 1.0.0]
 *
 * 所有子命令都不访问网络（`notes` 只读本地 git 历史），可在 CI 与本地复现。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = "OpenShell";

const EXT_PRIORITY = {
  windows: ["exe", "msi"],
  macos: ["dmg"],
  linux: ["appimage", "deb"],
};

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function fail(message) {
  console.error(`\u2716 ${message}`);
  process.exit(1);
}

function appVersion() {
  return JSON.parse(readFileSync(join(root, "frontend/package.json"), "utf8")).version;
}

// ==========================================
// check
// ==========================================

function checkVersions() {
  execFileSync(process.execPath, [join(root, "scripts/version.mjs"), "--check"], {
    stdio: "inherit",
  });
}

function checkChangelog(version) {
  const path = join(root, "CHANGELOG.md");
  if (!existsSync(path)) {
    fail("缺少 CHANGELOG.md：发布前必须写明本次变更");
  }
  const text = readFileSync(path, "utf8");
  if (!new RegExp(`^##\\s*\\[${version.replace(/\./g, "\\.")}\\]`, "m").test(text)) {
    fail(`CHANGELOG.md 中没有 ${version} 的条目（需要 \`## [${version}]\` 小节）`);
  }
}

function runCheck() {
  const version = appVersion();
  checkVersions();
  checkChangelog(version);
  const tag = arg("tag");
  if (tag && tag !== `v${version}`) {
    fail(`tag ${tag} 与版本号 v${version} 不一致`);
  }
  console.log(`\u2714 发布预检通过：v${version}`);
}

// ==========================================
// notes
// ==========================================

const SECTIONS = [
  ["breaking", "破坏性变更"],
  ["feat", "新增"],
  ["improve", "改进"],
  ["fix", "修复"],
];

function classify(subject, body) {
  if (/BREAKING CHANGE/i.test(body) || /^[a-z]+(\(.+\))?!:/i.test(subject)) return "breaking";
  const match = /^([a-z]+)(\(.+\))?:/i.exec(subject);
  const type = (match?.[1] ?? "").toLowerCase();
  if (type === "feat") return "feat";
  if (type === "fix") return "fix";
  if (["perf", "refactor", "style", "revert"].includes(type)) return "improve";
  return null;
}

function gitLog(from) {
  const range = from ? `${from}..HEAD` : "HEAD";
  const raw = execFileSync(
    "git",
    ["log", range, "--no-merges", "--pretty=format:%s%n%b%n==OSCOMMIT=="],
    { cwd: root, encoding: "utf8" },
  );
  return raw
    .split("==OSCOMMIT==")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [subject, ...rest] = chunk.split("\n");
      return { subject: subject.trim(), body: rest.join("\n") };
    });
}

function runNotes() {
  const from = arg("from");
  const fromFile = arg("from-file");
  const version = appVersion();

  let commits;
  if (fromFile) {
    commits = readFileSync(resolve(root, String(fromFile)), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((subject) => ({ subject, body: "" }));
  } else {
    commits = gitLog(from);
  }

  const buckets = Object.fromEntries(SECTIONS.map(([key]) => [key, []]));
  for (const commit of commits) {
    const key = classify(commit.subject, commit.body);
    if (!key) continue;
    const text = commit.subject.replace(/^[a-z]+(\(.+\))?!?:\s*/i, "").trim();
    if (text && !buckets[key].includes(text)) buckets[key].push(text);
  }

  const lines = [`## ${APP_NAME} ${version}`, ""];
  let wrote = false;
  for (const [key, title] of SECTIONS) {
    if (buckets[key].length === 0) continue;
    wrote = true;
    lines.push(`### ${title}`, "");
    for (const item of buckets[key]) lines.push(`- ${item}`);
    lines.push("");
  }
  if (!wrote) {
    lines.push("### 更新内容", "", "- 本次发布以稳定性与兼容性改进为主，详见提交历史。", "");
  }
  lines.push("### 升级提示", "", "- 安装前会自动备份本地连接数据，升级后数据保持原样。", "");

  const out = arg("out");
  const text = lines.join("\n");
  if (out) {
    writeFileSync(resolve(root, String(out)), text, "utf8");
    console.log(`\u2714 已生成发布说明：${out}`);
  } else {
    process.stdout.write(text);
  }
}

// ==========================================
// assets
// ==========================================

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runAssets() {
  const platform = arg("platform");
  const arch = arg("arch");
  const version = String(arg("version") ?? appVersion());
  const roots = String(arg("root") ?? "target");
  const outDir = resolve(root, String(arg("out") ?? "artifacts"));
  if (!platform || !arch) fail("assets 需要 --platform 与 --arch");
  if (!EXT_PRIORITY[platform]) fail(`不支持的平台：${platform}`);

  const candidates = [];
  for (const rel of roots.split(",")) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const ext = extname(file).slice(1).toLowerCase();
      if (EXT_PRIORITY[platform].includes(ext)) candidates.push({ file, ext });
    }
  }
  if (candidates.length === 0) fail(`在 ${roots} 中找不到 ${platform} 的安装包`);

  mkdirSync(outDir, { recursive: true });
  const produced = [];
  for (const ext of EXT_PRIORITY[platform]) {
    const hits = candidates.filter((candidate) => candidate.ext === ext);
    if (hits.length === 0) continue;
    // 优先选择文件名里带版本号的产物（tauri 默认命名形如 OpenShell_1.2.3_x64-setup.exe）
    const pick = hits.find((hit) => basename(hit.file).includes(version)) ?? hits[0];
    const suffix = ext === "appimage" ? "AppImage" : ext;
    const name = `${APP_NAME}-${version}-${platform}-${arch}.${suffix}`;
    copyFileSync(pick.file, join(outDir, name));
    produced.push({ name, size: statSync(join(outDir, name)).size, sha256: sha256(join(outDir, name)) });
    console.log(`  + ${relative(root, join(outDir, name))}`);
  }
  writeFileSync(
    join(outDir, `assets-${platform}-${arch}.json`),
    JSON.stringify({ platform, arch, version, files: produced }, null, 2),
    "utf8",
  );
  console.log(`\u2714 已规整 ${produced.length} 个安装包到 ${relative(root, outDir)}`);
}

// ==========================================
// manifest
// ==========================================

function runManifest() {
  const dir = resolve(root, String(arg("dir") ?? "artifacts"));
  const version = String(arg("version") ?? appVersion());
  const tag = String(arg("tag") ?? `v${version}`);
  if (!existsSync(dir)) fail(`目录不存在：${dir}`);

  const fragments = readdirSync(dir)
    .filter((name) => /^assets-.*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  if (fragments.length === 0) fail("没有找到 assets-*.json，无法生成清单");

  const files = fragments.flatMap((fragment) => fragment.files);
  const assets = files.map((file) => ({ name: file.name, sha256: file.sha256 }));

  const meta = {
    mandatory: Boolean(arg("mandatory", false)),
    min_supported_version: arg("min") === undefined ? undefined : String(arg("min")),
    notes: existsSync(join(dir, "release-notes.md"))
      ? readFileSync(join(dir, "release-notes.md"), "utf8")
      : undefined,
    assets,
  };
  writeFileSync(join(dir, "update-meta.json"), JSON.stringify(meta, null, 2), "utf8");

  const sums = files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS.txt"), sums, "utf8");

  const latest = {
    version,
    tag,
    name: `${APP_NAME} ${version}`,
    published_at: new Date().toISOString(),
    mandatory: meta.mandatory,
    min_supported_version: meta.min_supported_version,
    release_page: `https://github.com/fieecbin-source/openshell/releases`,
    assets: files.map((file) => {
      const fragment = fragments.find((f) => f.files.some((x) => x.name === file.name)) ?? {};
      return {
        name: file.name,
        url: `https://github.com/fieecbin-source/openshell/releases/download/${tag}/${file.name}`,
        size: file.size,
        sha256: file.sha256,
        platform: fragment.platform,
        arch: fragment.arch,
      };
    }),
  };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2), "utf8");

  console.log(`\u2714 已生成 update-meta.json / SHA256SUMS.txt / latest.json（${files.length} 个资产）`);
}

const command = process.argv[2];
const handlers = { check: runCheck, notes: runNotes, assets: runAssets, manifest: runManifest };
if (!handlers[command]) {
  fail("用法：node scripts/release.mjs <check|notes|assets|manifest> [选项]");
}
handlers[command]();
