#!/usr/bin/env node
/**
 * 构建产物体检：确保发布包里不夹带环境变量文件、服务端源码、密钥，
 * 也**不夹带本机已经连接过的主机 / 账号信息**。
 *
 * 用法：
 *   node scripts/check-package.mjs                # 默认检查 frontend/dist 与 artifacts
 *   node scripts/check-package.mjs <目录或文件...>
 *
 * 三类检查：
 *   1. 路径黑名单：.env / target / backend/server / .git / node_modules 等
 *   2. 内容黑名单：私钥、签名私钥、CI token、password/api_key 字面量
 *   3. 本机信息指纹：把「这台机器上真实存在的」连接数据（本地数据库里的主机地址、
 *      邮箱、账号，以及本机用户名路径）当成黑名单去扫。
 *      —— 安装包是压缩的，所以对二进制产物会先抽取可打印字符串再匹配。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_DIRS = ["frontend/dist", "artifacts"];
const FORBIDDEN_PATH = [
  /(^|[\\/])\.env(\..*)?$/,
  /(^|[\\/])target[\\/]/,
  /(^|[\\/])backend[\\/]server[\\/]/,
  /(^|[\\/])\.git[\\/]/,
  /(^|[\\/])node_modules[\\/]/,
  /(^|[\\/])data[\\/]openshell\.db/,
  /(^|[\\/])openshell\.db(-wal|-shm)?$/,
  /(^|[\\/])(?:\.cache|cache|caches|logs|backups|local storage|session storage|indexeddb|webview2|ebwebview|user data)(?:[\\/]|$)/i,
  /(^|[\\/])(?:vault|key[_-]?slot|updater[_-]?state)\.json$/i,
  /\.(?:sqlite3?|osvault|pem|key|log|har|pcap|map)$/i,
];
const FORBIDDEN_CONTENT = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /TAURI_SIGNING_PRIVATE_KEY\s*=/,
  /CLOUDFLARE_API_TOKEN\s*=/,
  /(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{16,}["']/i,
];

/** 这些文件天然是二进制，跳过文本正则扫描（仍会检查路径，并额外抽字符串查指纹）。 */
const SKIP_CONTENT = /\.(exe|msi|dmg|AppImage|deb|png|ico|icns|woff2?|ttf|zip|gz|rpm)$/i;
const BINARY_ASSET = /\.(exe|msi|dmg|AppImage|deb|zip|rpm)$/i;

/** 单文件扫描上限：超过就不做指纹扫描（安装包一般 10-100MB，这里放到 128MB）。 */
const MAX_SCAN_BYTES = 128 * 1024 * 1024;

function walk(path, acc = []) {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    acc.push(path);
    return acc;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) walk(child, acc);
    else acc.push(child);
  }
  return acc;
}

function printableStrings(buffer) {
  // 抽 6 字节以上的可打印串（含 UTF-16LE 形态），压缩包里的明文都会命中
  return buffer.toString("latin1").replace(/[^\x20-\x7e]+/g, "\n");
}

/**
 * 汇总「本机私有指纹」：这些字符串一旦出现在发布产物里，说明把本地数据带出去了。
 * 只收集足够长、区分度高的片段，避免把 `root` / `22` 这种通用词当黑名单。
 */
function collectLocalMarkers() {
  const markers = new Map(); // marker -> 来源说明
  const add = (value, source) => {
    const text = String(value ?? "").trim();
    if (text.length < 8) return;
    if (/^(127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255)$/.test(text)) return;
    if (!markers.has(text)) markers.set(text, source);
  };

  // 1) 本机用户名路径（只匹配带路径的形态，避免误伤普通单词）
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "";
    }
  })();
  if (user && user.length >= 3) {
    add(`Users\\${user}`, "本机用户名路径");
    add(`Users/${user}`, "本机用户名路径");
    add(`/home/${user}`, "本机用户名路径");
  }

  // 2) 本地数据库里的真实连接信息（app_data_dir 下的 openshell.db）
  const candidates = [
    join(
      process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming"),
      "dev.openshell.desktop",
      "openshell.db"
    ),
    join(os.homedir(), ".local", "share", "dev.openshell.desktop", "openshell.db"),
    join(os.homedir(), "Library", "Application Support", "dev.openshell.desktop", "openshell.db"),
  ];
  for (const dbPath of candidates) {
    // WAL 里往往才是最新写入的数据（主库可能只有一个空页），必须一起读
    const parts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((file) => existsSync(file));
    if (parts.length === 0) continue;
    try {
      const text = parts.map((file) => printableStrings(readFileSync(file))).join("\n");
      // 主机地址 / 域名 / 邮箱 / ssh 公钥注释，这些都是「我的服务器」级别的东西
      for (const hit of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) add(hit[0], "本地数据库主机");
      for (const hit of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g)) add(hit[0], "本地数据库账号");
      for (const hit of text.matchAll(/\bssh-(?:rsa|ed25519)\s+AAAA[\w+/=]{40,}/g)) {
        add(hit[0], "本地数据库 SSH 公钥");
      }
    } catch {
      // 数据库读不了就当没有指纹，不影响其它检查
    }
  }

  return markers;
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DIRS;
const problems = [];
let scanned = 0;
let fingerprinted = 0;

const localMarkers = collectLocalMarkers();
if (localMarkers.size > 0) {
  console.log(`- 本机指纹库：${localMarkers.size} 条（本地数据库 / 用户名路径）`);
}

for (const target of targets) {
  const full = resolve(root, target);
  if (!existsSync(full)) {
    console.log(`- 跳过（不存在）：${target}`);
    continue;
  }
  for (const file of walk(full)) {
    scanned += 1;
    const rel = relative(root, file).replace(/\\/g, "/");
    if (FORBIDDEN_PATH.some((rule) => rule.test(rel))) {
      problems.push(`${rel}：不应出现在发布产物中`);
      continue;
    }

    const size = statSync(file).size;
    if (size > MAX_SCAN_BYTES) continue;

    const isBinaryAsset = BINARY_ASSET.test(file);
    const skipText = SKIP_CONTENT.test(file);

    if (!skipText) {
      const text = readFileSync(file, "utf8");
      for (const rule of FORBIDDEN_CONTENT) {
        if (rule.test(text)) {
          problems.push(`${rel}：疑似包含密钥或私钥内容`);
          break;
        }
      }
      if (localMarkers.size > 0) {
        for (const [marker, source] of localMarkers) {
          if (text.includes(marker)) {
            problems.push(`${rel}：包含${source}「${marker}」`);
            break;
          }
        }
      }
    }

    // 二进制安装包：抽可打印串再比对本机指纹（安装包内容多为压缩流，
    // 但只要壳里混进了明文数据库/配置/命令行参数，这里就能抓到）
    if (isBinaryAsset && localMarkers.size > 0) {
      fingerprinted += 1;
      const strings = printableStrings(readFileSync(file));
      for (const [marker, source] of localMarkers) {
        if (strings.includes(marker)) {
          problems.push(`${rel}：二进制产物里出现${source}「${marker}」`);
          break;
        }
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`\u2716 ${problem}`);
  console.error(`\n共 ${problems.length} 处问题：发布包里不能有本机数据 / 密钥，请先清理再上传。`);
  process.exit(1);
}
console.log(
  `\u2714 产物检查通过（扫描 ${scanned} 个文件，其中 ${fingerprinted} 个二进制产物做了指纹比对）`
);
