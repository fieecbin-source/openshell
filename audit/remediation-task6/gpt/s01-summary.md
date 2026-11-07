# Task 6 gpt S01 — safe rejection and recovery boundary

Baseline: `Fce/task6-integration@9b05523777b38d5f1e1653abf9b57449f88c18cc`. Initial unrelated changes were `frontend/src/stores/aiSettingsStore.ts`, `frontend/src/stores/syncStore.ts`, `frontend/src/updater/AboutUpdateTab.test.tsx`, `frontend/src/updater/store.test.ts`; all were preserved. No staging, commit, push, reset, stash restoration, schema, IPC or dependency changes.

## Evidence and implementation

`cargo +stable-x86_64-pc-windows-msvc test -p openshell-app-core --test network_recovery_test pre_marker_missing --locked --offline --jobs 2` failed with exit 101 before the source fix (`s01-red.log`). The fixture creates an actual encrypted SOCKS secret through `prepare_forward`, creates its rule, removes the newer marker and hard-deletes the secret. Startup's locked `forwards` call fails, but the master-password recovery call wrongly succeeds by encrypting the reference text as a new password.

The shared SOCKS path now only validates an active `socks_password` row. A missing/tombstoned reference is preserved and rejected regardless of marker or string shape. Missing marker, schema version and a correct vault master password do not prove that the old column contains a plaintext SOCKS password. Marker probing also treats tombstones as unresolved. Proxy migration remains supported because its explicitly named `password` field is unambiguous; a later unresolved SOCKS value rolls back that proxy migration in the same transaction.

The existing explicit `prepare_forward` password input still encrypts ordinary, 26-letter and ULID-shaped passwords correctly. Unit tests retain the original decrypt-and-compare assertions after explicit reentry. Schema-1 fixtures explicitly reenter known synthetic passwords through existing app-core APIs before upgrading; the resulting snapshot remains secret-free. They do not pretend that startup's current master-password prompt supplies this confirmation.

First full verification: `cargo +stable-x86_64-pc-windows-msvc test -p openshell-app-core --locked --offline --jobs 2`, exit 0, 77 passed, 0 failed, 0 ignored (`app-core-tests.log`). The new recovery target passes 4 tests covering hard deletion/tombstone, pre-marker startup and recovery, mixed proxy/plaintext state, schema-1 already-referenced snapshots, wrong master password, preserved original values, explicit password repair and proxy-transaction failure/retry. Existing modern-marker, locked-vault, unaffected password-input, clear-password, database/WAL/export/backup tests also pass.

The final complete app-core rerun after the S02 cursor transaction fix also exits 0 with 77 passed, 0 failed and 0 ignored (`app-core-tests-final.log`).

## S01 remains open for CEO acceptance

Safe rejection fixes silent credential corruption, but the existing UI cannot complete every repair. `forward_list` calls `forwards(None)`, and `forward_start` also calls this whole-store check before starting one rule. One missing reference therefore blocks the list and can block another valid forward. A schema-1 database that cannot create a safe pre-migration snapshot also cannot reach the normal editor. The verified reentry route is currently an app-core API route, not a verified user-facing recovery flow. These limitations are explicit; no complete S01 acceptance or release claim is made.

Smallest proposed follow-up: CEO coordinates separating redacted metadata listing from single-rule runtime secret validation and exposing explicit per-rule password reentry (using the existing password-save contract), plus an explicit schema-1 recovery confirmation/reentry flow. The list must not return an unresolved raw `socks_password_ref`, since that value might itself be a legacy plaintext password. No automatic inference from absence or string shape is safe. Any broader UI/desktop or recovery-contract change needs CEO scope allocation, so this task does not edit those files.

Independent S01 group: `backend/crates/app-core/src/network_secrets.rs`, `backend/crates/app-core/tests/network_recovery_test.rs`, plus the related provenance comment hunk in `app_services.rs`. The separate `backup_retention_tests` relocation in `app_services.rs` is a gate-only hunk and preserves both tests verbatim.

Not verified: real user legacy databases, real backup restoration through the UI, physical protocols, cross-OS behavior or workspace-wide gates. Only isolated synthetic profiles and secrets were used; existing user configuration/backups were not read or deleted.
