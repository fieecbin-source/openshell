# Task 6 S02 — gpt internal history subtask

Baseline: `9b05523777b38d5f1e1653abf9b57449f88c18cc`. No staging, commit, push, dependency/schema/IPC changes. Only these source files changed:

- `backend/crates/app-core/src/sync_service.rs`
- `backend/crates/app-core/src/sync_codec.rs`
- `backend/crates/app-core/tests/sync_lifecycle_test.rs`

## Root cause and implementation

The real server `get_changes_v2` returns `record_history`, including obsolete entity versions. The client accumulated all decrypted versions but kept only the last envelope per ID. The codec then ordered by type/client timestamp, deleted superseded secrets and tried to restore an obsolete forward referencing a deleted secret. The same duplicate incoming entities also produced multiple conflict backups with mismatched latest envelopes.

The service now decrypts/authenticates and checks every historical envelope before choosing the highest revision for each entity. It replaces the record and envelope together. Client clock order is irrelevant. Existing dependency validation, conflict snapshot capture and tombstone handling remain. Additional per-history checks cover page schema, nonempty ID/checksum, revision range, precise encrypted/client timestamp agreement, valid deletion timestamp/presence, size and cursor bounds. No obsolete ciphertext or metadata is trusted merely because a newer revision exists.

Independent review also found that the service saved the pull cursor after the codec had committed the graph. A `sync_meta` trigger therefore returned an error after the new forward and conflict had already been committed. `sync-cursor-red.log` records 0 passed/1 failed (`latest` persisted instead of `offline-local`); the worker turn was interrupted before its process exit code was collected, so no observed exit code is claimed for that red run. The fixture now checks both BEFORE INSERT and BEFORE UPDATE OF last_cursor failures. The cursor UPSERT is moved into the same codec transaction as the graph/conflicts/dirty/revision/tombstones. The existing public codec function signatures remain; only a crate-private batch entry point accepts the optional cursor, and the service's now-unused private save_cursor is removed.

## Reproduction and verification

Every Cargo invocation used the absolute `C:/Users/fiee1/.cargo/bin/cargo.exe`, `+stable-x86_64-pc-windows-msvc`, `--locked --offline --jobs 2`, with process-only `NO_PROXY/no_proxy=127.0.0.1,localhost`. Exact target:

`& 'C:/Users/fiee1/.cargo/bin/cargo.exe' +stable-x86_64-pc-windows-msvc test -p openshell-app-core --test sync_lifecycle_test history_catch_up_keeps_latest_forward_and_matching_conflict_envelope --locked --offline --jobs 2`

| Evidence | Exit | Result |
| --- | --- | --- |
| `sync-history-red.log` | 101 | Original service: new-device login/catch-up rejects the old forward with `SOCKS 密码必须引用保险库秘密`; 0 passed, 1 failed. |
| `sync-history-metadata-red.log` | 101 | Highest-revision selection alone lets the main catch-up and conflict/rollback checks pass, but obsolete `client_updated_at` tampering is accepted as `Ok`; expected rejection fails. |
| `sync-history-green.log` | 0 | History selection/metadata fix: 1 passed, 0 failed, 0 ignored; runtime 24.24s, before the subsequent cursor-atomicity fix. |
| `app-core-tests-final.log` after cursor fix | 0 | Complete app-core target: 77 passed, 0 failed, 0 ignored; includes both cursor-write failure triggers, conflict-trigger rollback and the full history/tampering fixture. |
| `cargo +stable-x86_64-pc-windows-msvc clippy -p openshell-app-core --all-targets --locked --offline --jobs 2 -- -D warnings` | 0 | Final related all-targets lint passes; `app-core-clippy-final.log`. |
| `& 'C:/Users/fiee1/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin/rustfmt.exe' --edition 2021 --check backend/crates/app-core/src/sync_service.rs backend/crates/app-core/tests/sync_lifecycle_test.rs` | 0 | No formatting errors. |
| `git diff --check -- backend/crates/app-core/src/sync_service.rs backend/crates/app-core/tests/sync_lifecycle_test.rs` | 0 | No whitespace errors. |

The fixture uses the actual local HTTP router and server database, with 509 retained history rows, 501 filler sessions crossing the 500-item page boundary, three versions of a forward, two password rotations/deletions, client timestamps `1 -> 20 -> 10`, a new device and a device with an offline dirty edit. It checks final secret resolution, both secret tombstones (`revision=2, deleted=true`), latest forward/revision, one matching latest conflict envelope, original local snapshot, failed-conflict-trigger rollback of data/dirty/revision/cursor, remote conflict resolution and zero duplicate uploads.

After the valid control, eleven old-history corruptions are individually rejected while existing data and cursor remain unchanged: ciphertext, empty checksum, client timestamp, device ID, record ID, record type, revision, deleted flag, schema version, key version and size. Each corruption is restored, and a final ordinary sync succeeds.

## Submission boundary and limits

The three source files form one independent S02 group on the Task 6 baseline. Final verification after the cursor fix is recorded in `app-core-tests-final.log`; the complete target passes with both cursor trigger failures rolling back the graph/conflict/dirty/revision/cursor. Related all-targets lint evidence is kept in `app-core-clippy-final.log` and must also be read before acceptance. No workspace-wide gates, real remote devices or deployment were run. Server ciphertext/history corruption is synthetic and limited to isolated fixture databases; no real profile or secret was read.
