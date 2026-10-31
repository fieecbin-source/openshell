#!/usr/bin/env node
// Validate build inputs without reading or copying the developer's app data.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateMarkers } from "./private-markers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
const privateFile = /(^|\/)\.env(?:\.(?!example$)[^/]+)?$|\.(?:env|db(?:-wal|-shm)?|sqlite3?|osvault|pem|key|log|har|pcap)$/i;
const markers = privateMarkers().flatMap((marker) => [Buffer.from(marker), Buffer.from(marker, "utf16le")]);
for (const file of tracked) {
  if (privateFile.test(file)) problems.push(`Private data must not be tracked: ${file}`);
  const path = join(root, file);
  if (file && existsSync(path) && markers.length) {
    const content = readFileSync(path);
    if (markers.some((marker) => content.includes(marker))) {
      problems.push(`Deployment-private information found in tracked file: ${file}`);
    }
  }
}
for (const directory of [root, join(root, "frontend")]) {
  for (const file of readdirSync(directory)) {
    if (/^\.env(?:\.|$)/.test(file) && file !== ".env.example") {
      problems.push(`Remove local environment input before release: ${join(directory, file)}`);
    }
  }
}
const config = JSON.parse(readFileSync(join(root, "backend/desktop/tauri.conf.json"), "utf8"));
const resources = config.bundle?.resources;
if (!resources || Array.isArray(resources) || Object.keys(resources).length !== 1 ||
    resources["../../THIRD_PARTY_NOTICES.md"] !== "THIRD_PARTY_NOTICES.md") {
  problems.push("Bundle resources must contain only the explicit THIRD_PARTY_NOTICES.md mapping.");
}
const publicDir = join(root, "frontend/public");
if (existsSync(publicDir)) {
  execFileSync(process.execPath, [join(root, "scripts/check-package.mjs"), publicDir], { cwd: root, stdio: "inherit" });
}
if (problems.length) {
  problems.forEach((problem) => console.error(problem));
  process.exit(1);
}
console.log("Release inputs verified: no local data or environment files; bundle resources are allowlisted.");
