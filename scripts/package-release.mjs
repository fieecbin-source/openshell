#!/usr/bin/env node
/**
 * 本地「干净打包」一条命令跑完，专门用来产出可以上传 GitHub Release 的安装包。
 *
 * 用法：
 *   node scripts/package-release.mjs                  # 当前平台默认 bundle
 *   node scripts/package-release.mjs --bundles nsis    # 指定 bundle 格式
 *   node scripts/package-release.mjs --allow-dirty     # 明知工作区脏还坚持打包
 *
 * 它和手工 `pnpm tauri build` 的区别只有一个，但很关键：
 * 打包前先把「本机不该进包」的东西全部挡掉，打完再扫一遍产物。
 *
 *   1. 工作区必须是干净的 git 树（未提交的改动一律拒绝，除非显式 --allow-dirty）
 *   2. 仓库里不允许存在被跟踪的数据库 / .env / 私钥（同 CI 的发布守卫）
 *   3. 构建完成后跑 check-package：产物里出现本机主机、账号、私钥即失败
 *
 * 之所以要第 1 条：本地构建最容易出事的场景就是「顺手把测试用的数据库、
 * .env、导出的连接备份放在工程目录里」，然后被前端构建或打包脚本一起卷进去。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** 把 Rust 工具链加进 PATH（Windows 上 cargo 常常没进系统 PATH）。 */
function childEnv() {
  const env = { ...process.env };
  const cargoBin = join(os.homedir(), ".cargo", "bin");
  if (existsSync(cargoBin)) {
    env.PATH = `${cargoBin}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
  }
  return env;
}

function run(command, args) {
  const needsShell = process.platform === "win32" && !command.toLowerCase().endsWith(".exe");
  execFileSync(command, args, { cwd: root, stdio: "inherit", env: childEnv(), shell: needsShell });
}

function preflight() {
  run(process.execPath, [join(root, "scripts/check-release-inputs.mjs")]);
  // 1. 工作区干净
  if (!arg("allow-dirty")) {
    const dirty = git(["status", "--porcelain"]);
    if (dirty) {
      console.error(dirty);
      fail("工作区有未提交改动：先提交或 stash，避免把本地临时文件打进安装包（确需打包可加 --allow-dirty）");
    }
  } else {
    console.warn("\u26a0 已跳过工作区干净检查（--allow-dirty）");
  }

  // 2. 被跟踪的本地数据 / 密钥文件
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const forbidden = tracked.filter((file) =>
    /(^|\/)\.env$|\.(db|db-wal|db-shm|sqlite|sqlite3|osvault|pem|key|log)$/i.test(file)
  );
  if (forbidden.length > 0) {
    console.error(forbidden.join("\n"));
    fail("仓库里有被跟踪的本地数据 / 密钥文件：先移出版本库再打包");
  }

  // 3. 前端产物目录必须由本次构建重新生成
  const dist = join(root, "frontend", "dist");
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });

  const version = JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version;
  console.log(`\u2714 预检通过，准备打包 OpenShell v${version}`);
  return version;
}

function defaultBundles() {
  if (process.platform === "win32") return "nsis";
  if (process.platform === "darwin") return "dmg";
  return "appimage,deb";
}

function platformInfo() {
  if (process.platform === "win32") return { platform: "windows", arch: "x86_64" };
  if (process.platform === "darwin") return { platform: "macos", arch: "universal" };
  return { platform: "linux", arch: process.arch === "arm64" ? "aarch64" : "x86_64" };
}

const version = preflight();
const bundles = String(arg("bundles") ?? defaultBundles());
const outDir = String(arg("out") ?? "artifacts");
const { platform, arch } = platformInfo();

// 1. 前端
run("pnpm", ["--filter", "@openshell/frontend", "build"]);

// 2. 桌面安装包（tauri CLI 在各平台都能自动定位 backend/desktop 配置）
run("pnpm", ["tauri", "build", "--bundles", bundles]);

// 3. 规整产物命名
// 只读取本次请求的 bundle 目录，不能把 target 内旧的便携包、测试程序混入发布。
const bundleRoots = (bundles === "all" ? defaultBundles() : bundles)
  .split(",")
  .map((bundle) => join("target", "release", "bundle", bundle.trim() === "app" ? "macos" : bundle.trim()))
  .join(",");
run(process.execPath, [
  join(root, "scripts/release.mjs"),
  "assets",
  "--root",
  bundleRoots,
  "--version",
  version,
  "--platform",
  platform,
  "--arch",
  arch,
  "--out",
  outDir,
]);

// 4. 隐私体检：产物里不能有本机主机 / 账号 / 密钥
run(process.execPath, [join(root, "scripts/check-package.mjs"), outDir]);

// 5. 校验和与升级清单
run(process.execPath, [
  join(root, "scripts/release.mjs"),
  "manifest",
  "--dir",
  outDir,
  "--version",
  version,
  "--tag",
  `v${version}`,
]);

console.log(`\n\u2714 干净安装包已生成：${outDir}/（只包含安装包与清单，不含任何本机连接信息）`);
console.log(`  上传命令示例：gh release upload v${version} ${outDir}/* --clobber`);
