# Employee 1 continuation evidence — 2026-11-06

Workspace: 仓库根目录（绝对路径已省略）; branch `Fce/terminal-workspace-ux`; baseline HEAD `1f746c27b3b189072719f49d6284f1452187633d`. `baseline.diff` and `baseline-status.txt` preserve the already dirty starting state. Existing changes and older evidence are not attributed to this continuation. No commit or push is authorized or performed.

The user approved a compatible encrypted archive extension. New `.osvault` payloads retain schema 1 and add `recovery_version: 1`, credentials, SSH key metadata and secret contents inside the encrypted package. Target Vault secrets are encrypted again under the target key and IDs. Old packages without recovery_version remain readable, with missing-secret references cleared and warnings. Plain JSON contains metadata only. Preview secrets stay in backend memory; commit verifies the exact candidates and current target records, uses one transaction and consumes the token only on success.

## Commands and evidence

All Cargo commands use `C:/Users/fiee1/.cargo/bin/cargo.exe +stable-x86_64-pc-windows-msvc`, with `--locked --offline --jobs 2`; only one Cargo process runs at a time. No workspace-wide check is part of this work.

| Check | Exit / evidence |
| --- | --- |
| `test -p openshell-ai` | 0; `ai-green.log`: 72 unit tests and 6 real loopback HTTP tests across all three wire formats |
| AI pre-fix controlled HTTP tests | 101; `ai-direct-red.log`: 1 passed, 5 failed; `ai-red.log` is an invalid proxy-contaminated baseline and is NOT acceptance evidence |
| `test -p openshell-importer` | 0; `importer-final.log`: 15 tests; additional repeated KeepBoth regression failed with exit 101 in `importer-keepboth-red.log` before the fix |
| Importer pre-fix | 101; `importer-red.log`: missing OpenSSH dependencies and batch duplicate policy |
| `test -p openshell-store` | 0; `store-green.log`: 12 unit + 7 migration/backup integration tests |
| Backup pre-fix | 101; `backup-red.log` and `migration-red.log`: canonical 20 ignored, retained only default 5 |
| Archive first implementation | 101; `archive-first.log`: 4 passed, KeepBoth commit failed UNIQUE session name constraint |
| Network secret pre-fix | 101; `network-red.log`: missing SecretId treated as a literal legacy password |
| `test -p openshell-app-core --lib --test archive_roundtrip_test --test network_secrets_test --test sync_lifecycle_test --no-fail-fast` | 0; `app-core-green.log`: 25 unit + 9 archive + 1 disk-secret scan + 4 local-server sync tests. `app-core-first.log` exit 101 reproduced restoring a session with a soft-deleted credential before dependency revalidation was added |
| `test -p openshell-desktop` | 0; `desktop-first.log`: 24 tests, including shared serialized wire values and command registration compilation; no native UI acceptance |
| `rustc --edition 2021 --test backend/desktop/src/terminal_encoding.rs -o audit/remediation-task4/gpt/continuation-20261106/encoding-tests.exe` and run output | 0; `encoding.log`: 3 tests (UTF-8/control bytes, Latin1, Windows GBK/GB18030) |
| `node --test scripts/check-package.test.mjs` | 0; `package.log`: 4 tests; legitimate Telnet password prompt vs synthetic actual secrets/private keys/user paths |
| `pnpm --dir frontend exec vitest run src/lib/ipc.test.ts` | 0; `ipc-green.log`: 4 invoke-contract tests, not real Tauri acceptance |
| `pnpm --dir frontend exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib 'ES2022,DOM' --skipLibCheck src/types/ipc.ts src/lib/ipc.ts src/lib/ai/aiIpc.ts` | 0; `shared-types-fixed-command.log`; first unquoted comma command failed argument parsing (`shared-types.log`), not a code defect |
| `rustfmt +stable-x86_64-pc-windows-msvc --edition 2021 --config skip_children=true --check <fmt-files.txt paths>` | 1 before formatting, 0 afterward; `fmt-before.log`, `fmt-final.log`; only 45 changed backend Rust files, no recursive child module formatting |

HTTP tests clear HTTP_PROXY, HTTPS_PROXY and ALL_PROXY only in their own process, and set NO_PROXY to localhost/loopback. A normal successful response is tested alongside failures so a proxy refusal cannot make all negative checks appear green.

Other employee1 subtask evidence: `../continuation-transfer/README.md`, `../continuation-protocols/`, `../continuation-ai-monitor/`. These are internal partitions of the gpt assignment, not employee2/employee3 work.

Final protocol results: monitor 12/12 (exit 0), serial 3 unit + 7 integration (exit 0), SSH 7 unit + 2 integration (exit 0). The initial SSH failure was a fixture comparing public-key comments, corrected to compare key data while retaining real signature verification. G04 isolated normal test exited 0, unconditional-Trust mutation exited 101 at the real handshake assertion, restored test exited 0; shared SHA and restored bytes match (`../continuation-protocols/g04-result.json`). Isolated dependency setup failures are separately retained and are not counted as behavioral red tests.

## Boundaries requiring explicit handoff

- X11 remains unsupported: no local display/Xauthority policy or inbound channel proxy exists. A saved flag or explicit rejection does not close BUG-008.
- mstsc provides process state, not reliable authentication evidence. RDP only reports launched/disconnected/failed/closed. Shared TERMSRV credential writes are removed; the native client prompts for credentials. ActiveX event integration or an approved FreeRDP integration needs CEO architecture/platform approval.
- Older backups may already contain plaintext. No user backups were deleted or claimed sanitized. An old-schema database with unmigrated plaintext cannot create a safe pre-migration snapshot before Vault unlock; this upgrade path remains blocked rather than silently losing the rollback copy.
- Terminal profile IDs have no archived backing entity in the existing format. Legacy imports warn and clear the reference; new complete encrypted export refuses unsupported dependencies rather than claiming recovery.
- Real hardware serial, external SSH/Agent/X11/RDP servers, native UI IPC, production sync, packaged artifact scanning, other OSes and final workspace/three-team checks remain CEO acceptance work.
