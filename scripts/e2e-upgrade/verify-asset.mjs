#!/usr/bin/env node
/**
 * 升级演练 · 下载侧自检（断点续传 + 哈希校验，可自动化）。
 *
 * 行为与客户端下载器一致：
 *   - 写入 `<out>.part`，中断后再次运行会带 `Range: bytes=<n>-` 续传；
 *   - 服务端忽略 Range（回 200）时从头覆盖；
 *   - 完成后计算 sha256，与期望值不符则**删除**临时文件并退出码 1。
 *
 * 用法：
 *   node scripts/e2e-upgrade/verify-asset.mjs \
 *     --url https://github.com/own/repo/releases/download/v1.0.2-rc.1/OpenShell-...exe \
 *     --sha256 <清单中的值> \
 *     --out .e2e/downloads
 *
 * 演示「中途取消再继续」：
 *   先跑一次并在中途 Ctrl+C（或用 --abort-after 300000 模拟），再跑同一条命令。
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const url = arg("url");
const expected = String(arg("sha256") ?? "").toLowerCase();
const outDir = String(arg("out") ?? ".e2e/downloads");
const abortAfter = Number(arg("abort-after", 0));
if (!url) {
  console.error("用法：node scripts/e2e-upgrade/verify-asset.mjs --url <安装包直链> --sha256 <64位hex>");
  process.exit(2);
}

const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "installer.bin");
const partPath = join(outDir, `${fileName}.part`);
const finalPath = join(outDir, fileName);
mkdirSync(dirname(partPath), { recursive: true });

const offset = existsSync(partPath) ? statSync(partPath).size : 0;
if (offset > 0) console.log(`续传：已存在 ${offset} 字节，发送 Range 请求`);

const headers = { "user-agent": "openshell-e2e-verify" };
if (offset > 0) headers.range = `bytes=${offset}-`;

const response = await fetch(url, { headers, redirect: "follow" });
if (!response.ok && response.status !== 206) {
  console.error(`下载失败：HTTP ${response.status}`);
  process.exit(2);
}
const resumed = response.status === 206 && offset > 0;
if (offset > 0 && !resumed) {
  console.log("服务端忽略了 Range（200），从头重新下载");
  rmSync(partPath, { force: true });
}
const total = resumed
  ? offset + Number(response.headers.get("content-length") ?? 0)
  : Number(response.headers.get("content-length") ?? 0);
console.log(`响应 ${response.status}，预计总大小 ${total} 字节`);

// 模拟「中途取消」：达到阈值就主动断开，留下 .part 供下一次续传
const limiter = abortAfter > 0
  ? new Transform({
      transform(chunk, _enc, callback) {
        if (this.received === undefined) this.received = 0;
        this.received += chunk.length;
        if (this.received > abortAfter) {
          callback(new Error("模拟用户取消（abort-after 触发）"));
          return;
        }
        callback(null, chunk);
      },
    })
  : null;

const out = createWriteStream(partPath, { flags: resumed ? "a" : "w" });
try {
  if (limiter) {
    await pipeline(Readable.fromWeb(response.body), limiter, out);
  } else {
    await pipeline(Readable.fromWeb(response.body), out);
  }
} catch (err) {
  console.error(`下载中断：${err.message}`);
  console.error(`已保留 ${statSync(partPath).size} 字节的 .part，下次运行会自动续传`);
  process.exit(3);
}

const digest = createHash("sha256").update(readFileSync(partPath)).digest("hex");
if (!expected) {
  console.log(`未提供 --sha256，仅报告实际哈希：${digest}`);
} else if (digest !== expected) {
  rmSync(partPath, { force: true });
  console.error(`✖ sha256 不匹配：期望 ${expected}，实际 ${digest}（已删除临时文件，符合客户端行为）`);
  process.exit(1);
}

renameSync(partPath, finalPath);
console.log(`✔ 下载并校验通过：${finalPath}`);
console.log(`  sha256 = ${digest}`);
