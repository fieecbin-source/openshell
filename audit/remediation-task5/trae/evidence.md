# Task 5 · trae 执行证据

日期：2026-11-06
工作区：本地仓库根目录（绝对路径已省略），分支 `Fce/terminal-workspace-ux`
开工 HEAD：`10a989e7e5597d1300c8ad8af1412b4ecb03ca3f`（与远程功能分支一致；索引为空，工作区保留 137 条跨员工改动）
本轮未 commit、未 push、未执行 `git add -A`、未恢复旧 baseline、未改动共享 IPC/类型/依赖/全局样式，未改 gpt/gemini 白名单文件。

## 基线/复现

- R12 基线失败来自 CEO 全量日志 `audit/ceo-frontend-test.log`：`settingsStore.test.ts (14 tests | 2 failed)`，断言 `expected 45 to be 50`（backgroundOpacity）与 `expected 13 to be 14`（fontSize 迁移），并由默认 `theme=finalshell`（深色，被 `allThemes` 浅色过滤排除）造成 store 与 resolveTheme 不一致。本轮未回退旧 baseline，只修正 trae 所有的默认值与迁移语义。
- R04/R09/R10/R11 的缺口以当前源码核对：`terminalStore` 无 `rdpGetStatus` 调用者、`reconnectTab` 对 launched 早退、`closeTab` 不 `rdpClose`；串口读失败删除订阅导致 HEX 永久冻结；`MultiExecBar` 直接 `TextEncoder` 写 PTY；监控组件忽略 `unavailable_fields`。修复后由新增/既有定向测试覆盖。

## 命令与退出码

| 命令（cwd=frontend） | 退出码 | 结果 |
|---|---|---|
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/stores/settingsStore.test.ts --reporter=dot` | 0 | 4 files / 48 tests passed（terminalStore 19、serialStore 7、monitorStore 7、settingsStore 15） |
| `pnpm exec eslint <trae 改动 15 个文件>` | 0 | 0 errors，2 warnings（AppLayout 既有 `react-hooks/exhaustive-deps`，非本轮引入） |
| `git diff --check` | 0 | 仅 CRLF 提示，无空白错误 |

原始日志：`vitest-task5.log`、`eslint-task5.log`。

未运行（按分工留 CEO）：全量 frontend test/typecheck/build、eslint 全仓、Rust 全量。因此本轮不声称 typecheck/build 通过；单文件 lint 与定向 vitest 不能替代全量门禁。

## 改动文件（仅 trae 白名单）

- `frontend/src/stores/terminalStore.ts` 及 `terminalStore.test.ts`：R09 `sendTextToTab`、R04 RDP 轮询/生命周期、串口暂停/恢复接入。
- `frontend/src/stores/serialStore.ts` 及 `serialStore.test.ts`：R10 故障保留订阅、resume/pause/teardown。
- `frontend/src/stores/monitorStore.ts` 及 `monitorStore.test.ts`：R11 `isFieldUnavailable`/`readAvailableMetric`。
- `frontend/src/stores/settingsStore.ts` 及 `settingsStore.test.ts`：R12 默认与迁移、显式自定义值保留。
- `frontend/src/components/MultiExecBar.tsx`：R09 统一编码发送与失败 toast。
- `frontend/src/components/RdpSessionView.tsx`、`TerminalTabs.tsx`：R04 launched/connected 呈现。
- `frontend/src/components/HexDumpView.tsx`：R10 恢复后清除读取错误。
- `frontend/src/components/MonitorDashboard.tsx`、`ServerSidebar.tsx`：R11 不可用字段展示。
- `frontend/src/components/AppLayout.tsx`：R05 `transferring`→`running`。
- 本目录：`spec.md`、`tasks.md`、`evidence.md`、日志。

## 逐项验证范围

- R09：`sendTextToTab` 按 Session.encoding 编码（GB18030 用例）、串口走 `sendSerial`、目标不可用 reject、不改变 activeTabId/历史；`sendCommandToTabs` 多目标逐项容错且失败写入标签 error；MultiExecBar 串口 CRLF/其余 LF。SnippetBar 仍归 gemini，真实联调未做。
- R04：launch 后仅 `launched`；`rdpGetStatus` 报 `connected` 才写 connectedAt；failed/closed 映射并停轮询；close-during-launch 迟到实例 `rdpClose`；launched 重置；同 session 双实例互不误杀；关闭标签后轮询不复活。真实 mstsc 登录/NLA 未验证。
- R10：读失败保留订阅并可 resume；pause 后不读、resume 后继续收；teardown 同时停定时发送/轮询/订阅/sendError；既有单消费者完整广播测试仍通过。真实串口热插拔未验证。
- R11：首个采样 `unavailable_fields` 命中返回 null（UI 显示“不可用”），第二采样合法 0 保留，缺字段显示不可用；CPU 历史过滤不可用点；ServerSidebar CPU/负载/核心同样处理。未做视觉回归。
- R05：仅 AppLayout 比较值修正；typecheck 全量由 CEO 复核。
- R12：默认值改为可发布组合（clean_light/14px/空壁纸/50%/blur 0），一次性迁移与显式自定义值保留；settingsStore 15/15 通过。
- R15：5 张 `frontend/public/fs-bg*.jpg` 仍在本地（共 6,312,278 字节，未跟踪），未复制/发布；默认 `backgroundId` 改为空，`wallpapers.ts` 仍为非 trae 文件且被工作区改动，未触碰。外观/壁纸批次建议单独隔离，不随行为修复提交。

## 未验证与阻塞

- 无真实 RDP 成功登录、无 NLA/其他 OS 环境：R04 仅后端状态契约层验证。
- 无真实串口设备热插拔/故障注入：R10 仅 store 与 mock IPC 层验证。
- 监控不可用字段依赖后端字段名；本轮按已交付契约 `cpu_percent/net_rx_bps/net_tx_bps/memory_cached_bytes/cpu_cores/top_processes/load_1` 消费，真实采样形态未回归。
- 未跑全量 typecheck/build/test；R05 的“前端 typecheck 门禁解除”需 CEO 全量确认。
- SnippetBar 调用 `sendTextToTab` 的联调依赖 gemini 交付。
