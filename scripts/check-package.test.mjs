import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function scan(content, name = "bundle.js", marker = "") {
  const directory = mkdtempSync(join(tmpdir(), "openshell-package-test-"));
  try {
    const file = join(directory, name);
    writeFileSync(file, content);
    return spawnSync(process.execPath, [resolve("scripts/check-package.mjs"), file], {
      encoding: "utf8",
      env: { ...process.env, APPDATA: directory, HOME: directory, USERPROFILE: directory, OPENSHELL_PRIVATE_MARKERS: marker },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Telnet Password prompt cannot match across minified JS strings", () => {
  const result = scan('const p="Password: ";someLongMinifiedFunctionName("test");');
  assert.equal(result.status, 0, result.stderr);
});

test("quoted and unquoted secret assignments remain blocked", () => {
  for (const content of [
    'const password="synthetic-password-123456";',
    'const config={"api_key":"synthetic-api-key-123456"};',
    "const config={'secret':'synthetic-secret-123456'};",
    'const config={password: "synthetic-password-123456"};',
    'const password = `synthetic-password-123456`;',
    'const config={password: /* note */ "synthetic-password-123456"};',
    'const password /* note */ = "synthetic-password-123456";',
    'const config={password /* key */ : /* value */ "synthetic-password-123456"};',
    'const serialized="password=\'synthetic-password-123456\'";',
    'const serialized="{\\"password\\":\\"synthetic-password-123456\\"}";',
  ]) {
    const result = scan(content);
    assert.equal(result.status, 1, content);
    assert.match(result.stderr, /疑似包含密钥或私钥/);
  }
});

test("private keys, forbidden files, and private fingerprints remain blocked", () => {
  assert.equal(scan("-----BEGIN OPENSSH PRIVATE KEY-----").status, 1);
  assert.equal(scan("safe", ".env").status, 1);
  assert.equal(scan("/home/synthetic-person/secret", "bundle.js", "/home/synthetic-person").status, 1);
});

test("legal password labels and empty configuration pass", () => {
  assert.equal(scan('const labels={password:"",api_key:""};const label="Password:";').status, 0);
});

test("regex quotes cannot turn state and object code into nested secrets", () => {
  for (const content of [
    `const quotes=/["']/;const input={type:"password",value:""};const [password,setPassword]=useState("");const title="Password: ";const next={className:"a-long-css-class-name"};`,
    `const quotes=/["']/g;const label="Password:";const state={password:"",secret:""};`,
    `const regex=/password:"[^"]+"/;const state={password:"",className:"a-long-css-class-name"};`,
  ]) {
    const result = scan(content);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("escaped and nested serialized secrets and code-like values remain blocked", () => {
  for (const content of [
    'const config={"pass\\u0077ord":"synthetic-password-123456"};',
    'const password="synthetic\\u002dpassword\\u002d123456";',
    `const config={password:'),useState(""),{className:"long-class"}'};`,
    JSON.stringify(JSON.stringify({ password: "synthetic-password-123456" })),
    'const config={};config.api_key="synthetic-api-key-123456";',
    'password: "synthetic-password-123456"',
    '"password": "synthetic-password-123456"',
    'api-key: "synthetic-secret-123456"',
    'name: safe\napi-key: "synthetic-secret-123456"',
    JSON.stringify('api-key: "synthetic-secret-123456"'),
  ]) {
    const result = scan(content);
    assert.equal(result.status, 1, content);
    assert.match(result.stderr, /疑似包含密钥或私钥/);
  }
  for (const kind of ["RSA", "EC"]) {
    assert.equal(scan(`-----BEGIN ${kind} PRIVATE KEY-----`).status, 1);
  }
  assert.equal(scan("synthetic-private-host.example", "app.exe", "synthetic-private-host.example").status, 1);
});

test("secrets in line, block and trailing comments remain blocked", () => {
  for (const content of [
    '// password="synthetic-password-123456"',
    '/* password="synthetic-password-123456" */',
    '{"unused":1}// password="synthetic-password-123456"',
    'const safe="";/* api-key: "synthetic-secret-123456" */',
    JSON.stringify('// password="synthetic-password-123456"'),
  ]) {
    const result = scan(content);
    assert.equal(result.status, 1, content);
    assert.match(result.stderr, /疑似包含密钥或私钥/);
  }
});
