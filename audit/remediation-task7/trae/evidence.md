# Task 7 · trae 证据摘要（2026-11-07）

身份：员工3 trae。分支 `Fce/task7-integration`，完整 HEAD `1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`。
开工 `git status` 干净；收尾时索引为空，未 add / commit / push / 切分支，未 reset / restore / stash pop，未套旧 patch。
他人本轮并行增量（`sessionStore.ts`、`syncStore.ts`、`vaultStore.ts` 及两个新测试）原样保留。

## 1. 本人白名单增量（7 文件）

`git diff --stat -- <以下 7 文件>` = `7 files changed, 640 insertions(+), 64 deletions(-)`（已含 rdp_process.rs 格式微调后的复跑数值）。
`git diff --check -- <以下 7 文件>` 退出 0。

| 文件 | 内容 |
|---|---|
| `frontend/src/stores/terminalStore.ts` | 发送链统一代次归属、广播目标冻结、closeTab 同步失效、RDP 清理所有权与重试 |
| `frontend/src/stores/serialStore.ts` | timer 归属、旧拒绝归一、`expireSerialSendEpoch` 导出 |
| `frontend/src/components/TerminalTabs.tsx` | 清理失败可见错误与重试按钮 |
| `frontend/src/stores/terminalStore.test.ts` | R06–R09 共 11 项回归 |
| `frontend/src/stores/serialStore.test.ts` | 3 项旧拒绝 / 真实失败用例 |
| `frontend/src/components/XtermView.test.tsx` | 1 项真实 IPC 边界用例 + mock 导出补齐 |
| `backend/desktop/src/rdp_process.rs` | `close_with_kill` 参数化 + native kill 失败边界测试 |

未改 `XtermView.tsx` / `RdpSessionView.tsx`（归一在 store 层即可，最小修复）；未改共享 `types/ipc.ts`、`lib/ipc.ts`、`commands.rs`、依赖/锁、公共 UI、scripts。

## 2. 先复现（红测）

工作目录 `frontend`：
`pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/components/XtermView.test.tsx --reporter=dot --maxWorkers=2 --minWorkers=1`
**退出 1**；3 文件 / 11 失败 / 46 通过。日志 `r06-r09-red.log`，退出码 `r06-r09-red.exitcode`。

11 项失败全部指向真实根因（无夹具错误）：
- R06：旧 `terminalEncode` / `writeTerminal` 拒绝未归一（2 项），Xterm 把重连后的新连接 `markDisconnected`（1 项）。
- R06/R07 serial：旧 encode / send 拒绝写旧 `sendError` 并停 timer（2 项）、新 `timerCardId` 缺失（1 项）、deferred `closeCard` 期间旧编码 resolve 仍发送（1 项）。
- R09：A 等待期间 B 重连，B 收到旧广播（1 项）。
- R08：首次打开 late launch / 重启 late launch / `closeTab.closeRdp` 的 `rdpClose` 拒绝均无清理所有权记录（3 项）。

中途夹具修正（不删断言、不放宽）：补 `closeCard` 导入、补 XtermView 真实发送链所需 mock 导出、把 XtermView 用例改为先等 `writeTerminal` 发起再触发重连。修正后 11 项仍全红。

## 3. 修复后定向检查

| 命令（工作目录） | 退出码 | 结果 | 证据 |
|---|---|---|---|
| 上述 vitest 定向集合（绿测） | 0 | 3 文件 / 57 通过 | `r06-r09-green.log`、`r06-r09-green.exitcode` |
| `pnpm exec eslint <本人 6 个前端文件>` | 0 | 0 errors / 0 warnings | `eslint-targeted.log`、`eslint-targeted.exitcode` |
| `pnpm exec tsc --noEmit` | **2** | 14 项语法错误全部来自他人进行中 `syncStore.ts`；本人 7 文件零错误 | `typecheck.log`、`typecheck.exitcode` |
| `pnpm exec vitest run src/lib/terminal-actions.test.ts src/stores/monitorStore.test.ts src/components/ServerSidebar.test.tsx --reporter=dot --maxWorkers=2 --minWorkers=1` | 0 | 3 文件通过 | `callers-targeted.log`、`callers-targeted.exitcode` |
| `cargo test -p openshell-desktop --lib rdp_process::tests`（默认 GNU host） | **101** | 链接器 `x86_64-w64-mingw32-gcc` 缺 `-lgcc_eh` / `-lgcc`，环境工具链问题 | `rdp-process-gnu-failure.log`、`rdp-process-gnu-failure.exitcode` |
| `cargo +stable-x86_64-pc-windows-msvc test -p openshell-desktop --lib rdp_process::tests` | 0 | 4 通过 / 0 失败 / 26 filtered，含新增 `failed_kill_retains_the_child_and_status_file_until_retry_succeeds` | `rdp-process-tests.log`、`rdp-process-tests.exitcode` |
| `cargo +stable-x86_64-pc-windows-msvc fmt --check -p openshell-desktop` | 0 | 格式一致（首次为 1，仅本人新增断言换行，已按 rustfmt 修正后复跑） | `rustfmt-check.log`、`rustfmt-check.exitcode` |
| `git diff --check -- <本人 7 文件>` | 0 | 无空白错误 | 命令输出 |

未使用 timeout / skip / allow / 删断言 / 吞错制造通过；未加 `any`、未新增依赖、未改 IPC 签名。

## 4. 实现要点

- `sendTextToTab(tabId, text): Promise<void>` 签名不变。入口冻结代次 + `protocol/connectionId/cardId`；import、编码、写入每个 await 的 **resolve 与 reject** 都按归属复核；旧代次/旧身份的结果统一抛 `StaleTargetError`，当前代次的真实失败原样上报。XtermView 既有 `err.name === "StaleTargetError"` 分支因此不再误标新连接，无需改组件。
- `sendCommandToTabs` 进入时一次性 map 出完整目标快照（含各自 epoch 与身份），循环前和 catch 写回前都用同一 `matches(target)` 复核；不扩大目标集、不改变 `"\r"` payload、`allTabs/activeTabId` 选择集与历史行为。
- `closeTab` 在 `await pendingTeardown` 之前同步调 `expireSerialSendEpoch(cardId || tabId)`，`closeCard` deferred 期间旧编码结果即被 `assertCurrentSerialSendEpoch` 拦下；`teardownSerialSession` 仍按原顺序清理。
- 串口 `failSerialSend` 统一处理 encode/send 的旧拒绝：代次变化一律归一为 `StaleSerialSendError`，不写 `sendError`、不动 timer；当前代次真实失败仍写 `sendError` 并停自己归属的 timer（`timerCardId` 为空表示旧式全局 timer，保持既有语义；明确属于其他 card 的 timer 不受影响）。
- RDP：`recordRdpCleanupFailure` 把失败的 launch_id + 可见错误写入 `rdpCleanupFailures`（不写回 `tab.error`，避免污染已接管的新连接界面）；`retryRdpCleanups()` 对同一 launch_id 重新发真实 `rdpClose`；`TerminalTabs` 条件渲染错误条与重试按钮。首次打开迟到 launch、重启迟到 launch、`closeTab.closeRdp` 三处不再 `.catch(() => {})` 丢所有权。后端 `rdp_close`（只读核对 `commands.rs:2535-2541`）失败时保留 `rdp_launches()` 中的 entry，故同一 launch_id 可重试。
- `rdp_process::close_with_kill` 参数化 kill，生产行为不变；新增测试注入 kill 失败，验证 close 如实返回 Err、child 所有权与临时 .rdp 状态文件都保留，随后真实重试成功并全部释放。

## 5. 未验证 / 范围外

- 全量前端 test / lint / build、Rust workspace 全量 test / check / clippy：按 main.md 交 CEO；本轮只跑定向。
- `tsc --noEmit` 退出 2 完全阻塞于他人进行中 `syncStore.ts`（第 110 行多余的 `}`），未修改；需其收口后 CEO 全量复跑。
- 真实 RDP / NLA 成功登录、实体串口与编码回环、外部 SSH / X11、真实旧库图形恢复、安装/升级：无环境；mock 只证明时序契约。
- `TerminalTabs` 新增告警条及 `MultiExecBar` / `CommandInputBar` / `SerialSendBar` / `RdpSessionView` 无独立组件测试，仅静态 / 类型 / lint 核对。
- 真实 OS kill 持续失败场景下 `rdp_close` 的释放只验证了 `rdp_process::close` 边界与前端重试契约，未做真实 mstsc 权限受限场景。
- 默认 GNU 工具链链接失败（101），未修改环境；Rust 门禁改用 MSVC 工具链。
