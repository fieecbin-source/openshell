# Task 8 · trae 证据摘要（2026-11-07）

身份：员工3 trae。分支 `Fce/task8-integration`，完整 HEAD `d7bbd25c6c3f296f82e4514d3037601921da8fd3`
（开工与收尾均未变）。开工 `git status --short --branch` 干净；收尾时另有 gpt/gemini 并行白名单增量，
按 BASELINE.md 第 9 条原样保留，未触碰、未清理。未 add / commit / push / 切分支，
未 reset / restore / 套旧 patch / stash pop。

## 1. 先复现（红测，源码未改）

命令（工作目录为仓库内 `frontend/`）：

```
pnpm exec vitest run src/stores/serialStore.test.ts src/stores/terminalStore.test.ts src/components/TerminalHost.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1
```

**退出 1**（`t8-red.exitcode`＝1，日志 `t8-red.log`）：3 文件 / 9 failed / 48 passed（共 57）。
9 项全部指向真实根因，无夹具错误：

| 用例 | 失败现象 | 对应缺口 |
|---|---|---|
| T8-1 | `closeCard` pending 期间推进 timer，`sendSerial` 被调用 4 次 | T7-08：首个 await 前未停 owned timer |
| T8-2 | 旧 `sendCurrent` write 晚 resolve 记为 `resolved`，history 被旧快照覆盖、stats 被刷新 | T7-09 |
| T8-3 | 旧 `sendSnippet` write 晚 resolve 记为 `resolved` 且刷新 stats | T7-09 |
| T8-4 | A/B 逆序完成，最终 history `['A']`（B 丢失） | 任务书 4：await 前旧快照覆盖 |
| T8-5 | `teardownSerialSession(A)` 把 B 的 timer 停掉 | T7-10 |
| T8-6 | `markDisconnected(A)` 把 B 的 timer 停掉 | T7-10 |
| T8-7 | `closeTab(A)` 把 B 的 timer 停掉 | T7-10 |
| T8-8 | `reconnectTab(A)` 把 B 的 timer 停掉 | T7-10 |
| T8-9 | 真实 `TerminalHost` 链路（A 失败→sendError→markDisconnected）后 B timer 为 false | T7-10 |

## 2. 最小修复（本人白名单 6 文件）

生产源码 2 个：

- `frontend/src/stores/serialStore.ts`
  - 新增 `timerOwnedBy(timerCardId, cardId?)`；`stopTimer(cardId?)` 与 `stopSerialSendTimer(cardId?)`
    按归属停止，无参仍为全局（用户显式停止原意）。`failSerialSend` 复用同一 helper，语义不变。
  - `sendCurrent` / `sendSnippet` 在 `await sendSerial` 成功后 `assertCurrentSerialSendEpoch`；
    旧完成经既有 `failSerialSend` 归一为主动取消，不写 history/stats/sendError、不停 timer。
  - `history` 改为 `set((s) => …)` 读完成时最新状态合并，保留去重与 `slice(0, 50)`；
    `fetchStats` 仅在当代次成功分支触发。`teardownSerialSession` 传 `cardId` 停止。
- `frontend/src/stores/terminalStore.ts`
  - 静态引入 `stopSerialSendTimer`；`closeTab` 在首个 `await pendingTeardown.get(tabId)` 之前
    同步 `stopSerialSendTimer(cardId)` + `expireSerialSendEpoch(cardId)`（既停 timer 又失效代次）。
  - `markDisconnected`、`reconnectTab` 的动态引入调用改传 `tab.cardId || tab.tabId`。
  - `SerialSendBar.tsx:222` 用户显式 `stopTimer()` 无参调用保持不变（只读核对）。

测试 4 个：`serialStore.test.ts`（+5 用例）、`terminalStore.test.ts`（+4 用例）、
`TerminalHost.test.tsx`（新建，+1）、`TerminalTabs.test.tsx`（新建，+3）。

**核对过的全部停止调用点（修复后实测行号）**：`serialStore.ts:98`（failSerialSend 归属判定）、
`429`（stopSerialSendTimer→stopTimer）、`439`（teardownSerialSession）、
`terminalStore.ts:858`（reconnectTab）、`1065`（markDisconnected）、`1171`（closeTab）、
`SerialSendBar.tsx:222`（用户显式无参全局停止）。IPC/types、DTO、
`commands.rs`、`sessionStore`/`vaultStore`、依赖锁、scripts 未改。

## 3. 修复后定向检查（全部单 worker / 限定范围）

| 命令（frontend 目录，除注明外） | 退出码 | 结果 / 证据 |
|---|---:|---|
| `pnpm exec vitest run src/stores/serialStore.test.ts src/stores/terminalStore.test.ts src/components/TerminalHost.test.tsx src/components/TerminalTabs.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` | **0** | 4 文件 / **61 passed** / 0 failed（`t8-green.log`） |
| `pnpm exec vitest run src/lib/terminal-actions.test.ts src/stores/monitorStore.test.ts src/components/ServerSidebar.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` | **0** | 3 文件 / 17 passed（调用者联验，`callers-targeted.log`） |
| `pnpm exec vitest run src/components/XtermView.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` | **0** | 1 文件 / 9 passed（含 R06，`xterm-targeted.log`） |
| `pnpm exec eslint <本人 6 文件>` | **0** | 0 errors / 0 warnings（`eslint-targeted.log`，空输出） |
| `pnpm exec tsc --noEmit` | **0** | 无类型错误（`typecheck.log`，空输出） |
| `cargo +stable-x86_64-pc-windows-msvc test -p openshell-desktop --lib rdp_process::tests --locked --offline`（仓库根） | **0** | 4 passed / 0 failed / 0 ignored（`rdp-process-msvc.log`）。helper 未改，仅回归确认 |
| `git diff --check -- <本人 4 个已跟踪文件>` | **0** | 无空白错误 |

中间状态记录：首次 eslint / tsc 各报 1 个 `stopSerialSendTimer` 未使用（本人红测期导入已用尽），
随即补上 T8-12 用例实际覆盖该导入，重跑两者均 0；未删除导入、未加 allow/ignore。
本人 `tsc --noEmit` 最终为 0，与员工2 回执记录的「并行中途 `serialStore.test.ts` 2 处未用变量致 tsc 退出 1」
属不同时间点，该问题已由本人闭环。

未使用 timeout / skip / allow / 删断言 / 吞当前失败制造通过；未并行全仓 test/build；
未改 IPC 签名、未新增依赖、未装驱动、未启停服务、未动真实数据库或隔离图片。

## 4. 实际覆盖与未覆盖

覆盖：T7-08（pending closeCard 期间零写入 + 旧编码失效）、T7-09（两入口 write 晚 resolve 作为
过时完成，当前连接真实失败仍报错由既有 R06 用例保持）、T7-10（markDisconnected/closeTab/
reconnectTab/teardownSerialSession 及真实 `TerminalHost` 组件链均按 card 归属；用户显式全局停止
由 T8-12 单独断言）、任务书 4（A/B 逆序完成用最新状态合并、保留去重与长度限制）、任务书 5
（`TerminalTabs` 告警条 title/aria-label 含 launch_id、重试失败保留、重试成功消失，且 T8-13
经真实 `closeTab`→`rdpClose` 失败产生记录再重试）。

先红后绿 9 项：T8-1..T8-9。修复后补的证据/契约断言 4 项（T8-10/11/12/13）验证的是既有正常行为
与新增组件证据，不是本轮失败点，未单独构造红测。

未覆盖（交 CEO）：全仓前端单 worker 全量、全量 lint/build、真实 dist 扫描与依赖副本验证、
MSVC Rust workspace test/check/clippy/fmt、脚本测试；真实 RDP/NLA 成功登录、实体串口与编码回环、
外部 SSH/X11、真实旧库图形恢复、安装/升级、真实 Tauri WebView2 IPC 并发。
`rdp_process` helper 4 项只证明 native kill 边界，**不代替**命令注册表 `rdp_close` 失败保留 entry 的验证。

## 5. 交 CEO 的最小 hunk 提案

`commands-rs-minimal-hunk.md`：在 `backend/desktop/src/commands.rs` 的
`#[cfg(test)] mod protocol_command_tests` 内新增 1 个 `#[tokio::test]`，用一个目录路径让
`rdp_process::cleanup` 失败，断言 `rdp_close` 返回 Err 时 `rdp_launches()` 仍保留该 entry 且
`state == "failed"`，移除阻塞后对同一 `launch_id` 重试成功且 `state == "closed"`。
本人未改 `commands.rs`（CEO 保留的共享入口）。提案内已列出全局 `RDP_LAUNCHES` 与既有
`shutdown_rdp_launches()` drain 用例的并行冲突风险，请 CEO 决定串行化方式，不要用
`#[ignore]` / skip / allow 绕过。

## 6. 发布依赖

当前分支含未验收保全（本地 `92f4d3e8…`）与三员工并行 WIP，**禁止整支推送或宣告上线**。
本人未 add / commit / push。发布前须：CEO 集中联验（前端单 worker 全量、typecheck/lint/build、
MSVC Rust workspace test/check/clippy/fmt、脚本测试、真实 dist 扫描、依赖副本验证）、独立评审、
按独立功能分支分批推送；真实协议/安装仍单列未验证，定向通过数不代表上线。
