# Task 7 · gpt 红测复现证据（2026-11-07）

身份：员工1 gpt。基线 `Fce/task7-integration@1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`。
工作区已有 gemini/trae 增量，全部保留，未 reset/restore/stash/add/commit/push。

## 真实根因复现（修复前，全部为断言失败，非编译失败、非 skip/allow/timeout）

| 命令 | 退出码 | 失败内容 | 日志 |
|---|---:|---|---|
| `cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-app-core --locked --offline --jobs 2 --test network_recovery_test -- --nocapture` | **101** | 6 项中 2 failed / 4 passed：`broken_reference_no_longer_hides_healthy_forwards_or_blocks_metadata_export` 因 `forwards(None)` 返回 `DomainError{Validation,"SOCKS 密码引用不存在或旧值来源不明…"}` 整表失败；`startup_recovery_offers_only_safe_per_rule_reentry_metadata` 因恢复错误 `details: None` 无逐条补录元数据。既有 4 项安全回归 ok | `red-app-core-network.log` / `.exitcode` |
| `cargo.exe ... --test sync_lifecycle_test broken_forward_reference_does_not_block_sync -- --exact --nocapture` | **101** | `sync_now()` 被与操作无关的 `forwards(None)` 全库预检阻断，返回同一 Validation 错误 | `red-app-core-sync.log` / `.exitcode` |
| `pnpm exec vitest run src/stores/forwardStore.test.ts src/components/PortForwardModal.test.tsx --reporter=dot` | **1** | 2 文件 / 4 failed / 4 passed：`loadRules` 吞掉真实 IPC 读失败、`loadStatuses` 吞错、mutation 后刷新失败无独立 `refreshError`/`retryRefresh`、UI 对 `credential_state=needs_reentry` 无"需补录"提示且不强制显式输入 | `red-frontend.log` / `.exitcode` |

复现覆盖四类根因：整表失败阻断列表与元数据导出；sync 全库预检；启动恢复仅主密码无逐条补录；前端吞错 + 补录入口不可达。

注：首次 `network_recovery_test` 红测曾因 `expect_err` 触发 `AppServices: Debug` 约束而编译失败（退出码 101，已覆盖日志），已改为 `match` 后重跑，上述为真实断言失败结果。未删任何既有断言。
