# Task 6 · trae 证据摘要（2026-11-07）

身份：员工3 trae。分支 `Fce/task6-integration`，HEAD/开工基线 `9b05523777b38d5f1e1653abf9b57449f88c18cc`，全程未 commit/push、未 apply 旧 patch、未 stash pop、未 checkout/reset/restore。

## 1. 相对基线的本人增量

`git diff --name-only 9b05523` 当前共 22 个文件，其中本人白名单只有 6 个（其余为 gpt / gemini / 其他员工的增量，原样保留）：

| 文件 | 相对 9b05523 |
|---|---|
| `frontend/src/stores/terminalStore.ts` | 修改（S05 + S06 主改） |
| `frontend/src/stores/terminalStore.test.ts` | 修改（S05/S06 回归） |
| `frontend/src/stores/serialStore.ts` | 修改（串口独立发送链 S06） |
| `frontend/src/stores/serialStore.test.ts` | 修改（串口竞态回归） |
| `frontend/src/components/XtermView.tsx` | 修改（键盘发送复用统一入口） |
| `frontend/src/components/XtermView.test.tsx` | 修改（键盘定向用例） |

`git diff --stat 9b05523 -- <上述 6 文件>`：`6 files changed, 413 insertions(+), 26 deletions(-)`（见 `diff-check.log`）。
未改共享 `types/ipc.ts` / `lib/ipc.ts` / `lib/ai/aiIpc.ts`，未改依赖/锁文件/后端/公共 UI，未改 `RdpSessionView.tsx`（理由见 §4），未改 gemini 的 SnippetBar / snippetStore / ImportExportModal，未还原已移出 public 的壁纸。

## 2. 先复现（红测，均为真实退出码）

| 命令（工作目录 `frontend`） | 日志 | 退出码 | 结果 |
|---|---|---|---|
| `pnpm exec vitest run src/stores/terminalStore.test.ts --reporter=dot` | `s05-s06-red.log` | **1** | 26 项 / 5 失败 / 21 通过 |
| `pnpm exec vitest run src/stores/serialStore.test.ts --reporter=dot` | `serial-red.log` | **1** | 9 项 / 2 失败 / 7 通过 |

S05 红测失败点（未修复实现）：
- `expected 'launched' not to be 'launched'`：`reconnectTab` 在 `await rdpClose` 之前仍为 `rdpPhase: "launched"`，`RdpSessionView` 的 `busy` 恒 false，快速双击可并发启动。
- `expected "spy" to not be called at all, but actually been called 1 times`：`rdpClose` 失败被 `.catch(console.warn)` 吞掉后仍调用 `launchRdp`，旧实例泄漏、失败不可见。

S06 红测失败点：三项均为 `promise resolved "undefined" instead of rejecting` —— 延迟 `terminalEncode` 期间 SSH `connectionId` 变更、标签关闭、串口同 cardId 重开，旧 `sendTextToTab` 仍写入 `writeTerminal` / `sendSerial`。
串口独立链红测：`sendCurrent` / `sendSnippet` 编码期间重开或 teardown，`sendSerial` 仍被调用。

## 3. 修复后（绿测与定向门禁）

| 命令 | 日志 | 退出码 | 结果 |
|---|---|---|---|
| `pnpm exec vitest run src/stores/terminalStore.test.ts --reporter=dot` | `s05-s06-green-step2.log` | 0 | 26/26 通过 |
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/components/XtermView.test.tsx --reporter=dot` | `s05-s06-green-step3.log` | 0 | 2 文件 / 34 项通过 |
| `pnpm exec vitest run src/stores/serialStore.test.ts --reporter=dot` | `serial-green.log` | 0 | 9/9 通过 |
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/lib/terminal-actions.test.ts src/components/XtermView.test.tsx src/components/ServerSidebar.test.tsx --reporter=dot` | `vitest-targeted-final.log` | **0** | 6 文件 / 60 项全通过 |
| `pnpm exec eslint src/stores/terminalStore.ts src/stores/terminalStore.test.ts src/stores/serialStore.ts src/stores/serialStore.test.ts src/components/XtermView.tsx src/components/XtermView.test.tsx` | `eslint-targeted.log` | 0 | 0 errors / 0 warnings |
| `git diff --check 9b05523 -- <本人 6 文件>` | `diff-check.log` | 0 | 无空白错误 |

中途记录：`s05-s06-green-step1.log` 曾为 exit 1（25/26）。原因是 S06 串口红测用 `connected` 态直接调 `reconnectTab`，而现有实现对「非 RDP + connected」本就早退，不是真实重开路径；已把用例改为真实的「markDisconnected → reconnectTab（同 cardId closeSerial+openSerial）」并加 `closeSerial`/`openSerial` 断言，修正后 `s05-s06-green-step2.log` exit 0。未通过放宽断言/删断言/skip 让它变绿。

日志中的 `sendCommandToTabs: 写入 b-1 失败` 是既有用例 `:456` 故意 mock 的写入失败被 `console.warn` 记录，属预期 stderr，不是失败。

## 4. 实现说明（最小修复）

**共享根因**：`terminalStore.ts` 模块级 `connectionEpochs: Map<tabId, number>` + 三个不导出辅助函数 + `StaleTargetError`。不进 store state（避免被局部 `setState` 覆盖）、不改 `TerminalTab` 结构、不改共享 DTO；未经任何 action 的静态测试 fixture 缺省按 0 处理，无需测试复位点。串口与 RDP 的 `connectionId` 恒为 null，同 cardId 重开只能靠代次区分。

**S05**：`reconnectTab` 在早退判断之后、第一个 await 之前同步 `bumpConnectionEpoch` 并把 `rdpPhase` 置 `"starting"`；`RdpSessionView` 现有 `launched`/`busy` 派生因此自动给出 busy=true，同 tab 第二次点击被既有早退挡住（串行、不产生第二个实例），故 `RdpSessionView.tsx` 无需改动。`rdpClose` 失败不再吞错：写 `status:"error"` / `rdpPhase:"failed"` / 可读 `error`，并**保留旧 `rdpInfo.launch_id`**，使重试与 `closeTab` 仍能释放旧实例，且不启动新实例。每个 await（`rdpClose`、串口动态 import、`pendingTeardown`、`releaseTab`、`launchRdp`、`closeSerial`/`openSerial`、`connectSession`、串口 resume）后按 `isCurrent()`（代次 + tab 仍存在）复核；迟到/被替代的 launch 结果 `rdpClose` 释放；catch 分支旧代次不覆盖新状态。`closeTab` 与 `markDisconnected` 递增代次。真实 `connected` 仍只来自 `applyRdpRuntimeStatus` 的 `connected`（native OnLoginComplete），未改轮询/launch_id 接口。

**S06**：`sendTextToTab(tabId, text): Promise<void>` 签名不变。入口捕获代次与身份（`connectionId`/`cardId`/`protocol`），`await import` + `await encodeTextForSession` 后重读 live tab 复核存在性、`status`、`protocol`、代次与身份；任一不符抛 `StaleTargetError`，零 `writeTerminal`/`sendSerial` 调用，写参改用 live 身份。`sendCommandToTabs` 逐目标捕获代次，旧失败不再写到新连接的 `error`。`XtermView.tsx` 键盘 `onData` 改走 `sendTextToTab` 复用同一守卫，取消错误不触发 `markDisconnected`；删除因此不再使用的 `encodeTextForSession`/`sendSerial` 导入与 `encodingRef`。

**串口独立链（条件项，已复现并最小修补）**：`serialStore.ts` 模块级 `serialSendEpochs`；只在既有「身份变化」动作 `pauseSerialRead`（断开/重连）与 `teardownSerialSession`（主动关闭）递增，不新增跨模块导出、不改 terminalStore 调用。`sendCurrent`/`sendSnippet` 在编码 await 后复核，变更时以 `StaleSerialSendError` reject 且不调用 `sendSerial`；该取消不误停定时器、不写 `sendError`。

未使用 any / skip / allow / 放宽 timeout / 吞错；未删任何既有断言；未新增依赖。

## 5. 协议联验（只读核对 + 定向回归）

| 契约 | 证据 | 结论 |
|---|---|---|
| 广播选中子集 | `MultiExecBar.tsx:83-84` 选中集 ∩ 存活标签 | 未改 |
| 每目标编码 | `sendTextToTab` 内 `encodeTextForSession` 按 session.encoding | 保持 |
| 串口 CRLF / 其他 LF | `MultiExecBar.tsx:92` `cmd + "\r\n"` / `cmd + "\n"` | 未改 |
| SnippetBar 只调统一入口 | `SnippetBar.tsx:89` `sendTextToTab(activeTabId, finalCmd)`，无 TextEncoder | 未改（gemini 范围） |
| 命令栏目标集/换行 | `CommandInputBar.tsx:79,346` `sendCommandToTabs(command,{allTabs,appendCr})` | 未改 |
| ASCII/HEX 单接收源 | `HexDumpView.tsx:33`、`XtermView.tsx:547` 单 `subscribeSerial` | 未改 |
| 定时发送 teardown | `serialStore.ts` `stopSerialSendTimer`/`teardownSerialSession`；`serialStore.test.ts:141` 通过 | 保持 |
| unavailable_fields / 合法 0 | `MonitorDashboard.tsx:51`；`monitorStore.test.ts` 7 项、`ServerSidebar.test.tsx` 4 项通过 | 保持 |
| 编码入口 | `terminal-actions.test.ts` 6 项通过 | 保持 |

MultiExecBar / CommandInputBar / HexDumpView / MonitorDashboard 无独立测试文件，仅静态核对，未重新设计布局。

## 6. 只读联验发现（范围外，未处理）

`pnpm exec vitest run src/components/SnippetBar.test.tsx --reporter=dot` → `snippetbar-joint-verification.log`，**EXITCODE=1**，4 项全失败，均在组件挂载时抛 `TypeError: Cannot read properties of undefined (reading 'catch')`，位置 `SnippetBar.tsx:36` 的 `void loadSnippets().catch(...)`。

`git diff --stat 9b05523 -- SnippetBar.tsx snippetStore.ts snippetStore.test.ts` = `3 files changed, 74 insertions(+), 16 deletions(-)`，属 gemini 正在进行的 S07 范围；`SnippetBar.test.tsx` 本身相对基线未修改。该失败与本人 6 个文件及 `sendTextToTab` 改动无关（错误发生在 useEffect 的刷新调用，早于任何发送）。本人未修改该文件，交 gemini/CEO 收口。含该文件的 7 文件集合曾为 exit 1（60 通过 / 4 失败）；去掉它后的 6 文件集合 exit 0。

另：四条发送路径换行规则仍不一致（`sendCommandToTabs` `\r`、`SnippetBar` `\n`、`MultiExecBar` `\r\n`、`serialStore` 按 newlineMode），属既有语义，联验要求保持，本轮未统一。

## 7. 未验证部分

- 全量前端 `test` / `typecheck` / `lint` / `build`、Rust workspace 门禁：按 main.md 由 CEO 在停止编辑后集中跑，本轮只跑定向检查。
- 真实 RDP / NLA 成功登录与真实桌面、真实串口硬件热插拔与设备错误、跨 OS、真实后端 `unavailable_fields` 形态：无环境，Mock 只证明时序契约，不证明成功桌面。
- `SnippetBar.test.tsx` 联验当前失败（他人进行中工作），未在绿状态下复验统一入口的 UI 层调用。
- MultiExecBar / CommandInputBar / HexDumpView 无独立测试文件，仅静态核对。
