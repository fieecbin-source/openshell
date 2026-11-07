# Task9 trae evidence（2026-11-07）

## 基线与范围

- 开工核对：`codex/task9-closeout`，HEAD `7b3007a13c839857f19d89ce931c7d8b273a9eee`，`git status --short` 无输出。已读 Task9 main/trae3、Task8 BASELINE。Task9 BASELINE 与 Task8 review 在开工时缺失，依 CEO 已授权冻结基线继续。
- 修改仅为本线白名单的七个文件：ImportExportModal.test.tsx、SnippetBar.tsx/.test.tsx、PortForwardModal.tsx/.test.tsx、snippetStore.test.ts、forwardStore.test.ts。ImportExportModal、两个 store 的生产代码保持原样；保留 Task8 refreshing / archive_token / statusGeneration 修复。
- 未 add/commit/push/切分支、未安装依赖、未改共享契约、未新增 skip/timeout/allow、未删除已有断言。共用 Feedback 由 CEO 集中更新；本回执不写他人小节。

## 已证明缺口与最小修复

1. **SnippetBar 保存成功后的读取失败无用户错误或只读重试。** 真实 createSnippet → snippetCreate 成功 → loadSnippets → snippetList 失败，store 正确保留格式化 error，但组件未消费它。红测看到弹窗关闭、快捷栏只有空列表引导，缺少“本地文件读写失败…”与重试。现在消费既有 loading/error，在现有快捷栏内显示错误和重试；保存后读取失败向真实 toastStore 发 warning。重试只调用 loadSnippets，保持当前 group，不重复 create。没有新页面、公共样式或依赖。
2. **PortForwardModal 会话换页后旧本地 readError 残留。** session A 真正 forwardListStatuses 失败，经组件格式化；切到 session B，真实 loadRules 已成功更新 B 列表并清 store.loadError，但组件 readError 仍保留 A 的错误与重试按钮。红测展示“Current forward”和 A 错误并存。最小修复只在读取 effect 起始 `setReadError(null)`；原 mounted 归属与 store generation 保持。

## 实际覆盖矩阵

| 矩阵 | 实际覆盖 / 可见断言 |
| --- | --- |
| JSON file.text × tab/close/unmount × late resolve/reject | 6 格。切 tab 用真实 Segmented；close 用真实“关闭”控件及 parent 移除回调；unmount 单独调用。重新进入并选 B 后才结算 A。断言 B filename + 读取中、按钮 disabled、完整格式化 IO 错误与“操作未完成”均缺席、A 文件不见、无预览/commit；B 读取后 loading 消失，唯一 JSON preview IPC 的文本为 B，并以 B token 唯一提交。 |
| osvault file.arrayBuffer × tab/close/unmount × late resolve/reject | 同样 6 格，实际预览 IPC 严格为 B `Uint8Array([8,9])`、独立密码、skip；JSON 分支无调用。不是仅断言英文旧错误或“不崩溃”。 |
| commit A pending → B preview pending → A resolve/reject | 新 2 格保留 B 分析中、抑制格式化旧错误、A 不重提；成功仍真实读取 sessions/groups/snippets，失败回收 A token；B 完成后保留 B token，确认 B 时传 B candidates/token。已有 strategy/tab、晚成功/晚失败、unmount 后成功仍全局刷新回归全部保留。 |
| Restore A refresh failed → retry pending → select B file pending → retry resolve/reject | 新 2 格：B reader 保持 ownership，旧 retry 的 catch/finally 不覆盖 B，旧 warning/格式化 IO/retry 按钮不返场；B 完成后 preview 可用。真实 snippetList 共 2 次，commit 共 1 次，preview A 共 1 次。保留已有“刷新失败后直接选 B 隐藏旧 retry”测试。 |
| snippetList sibling failure → retry pending/finished → old resolve/reject | 新 4 格：B 失败真实抛出，并保留现有数据、格式化 IO error、loading=false；启动 B retry 后旧 resolve/reject 不改变当前数据/error/loading；retry 最终恢复，第三次 IPC group 为 current-group。已有直接读取失败与旧 resolve/new success 保留。 |
| SnippetBar real create/list 与 toast/用户重试 | 新 1 个端到端场景：create 成功 + list 失败时表单关闭、快捷栏显示格式化错误、真实 toastStore warning；只读 retry pending 时 loading=true 且尚无新片段，resolve 后显示当前 canonical multiline body/kind，create 仍 1 次，list 3 次；点击走统一 sendTextToTab，execute 只追加一个换行，真实 success toast。增强原 create IPC 失败测试，检查真实 error toast、保留名称/内容并用实际保存按钮成功重试。 |
| forward 双状态入口旧完成 | 将既有 `loadRules/loadStatuses` 双入口 resolve 矩阵扩展为 resolve/reject 共 4 格。新状态结果保留，规则数据保留，loading/filter 不错。失败 fixture 预置真实既有规则，验证失败保留数据；未把失败读取伪造为成功读。 |
| forward 双状态入口 sibling failure → retry → late reject | 新 2 格：真实 IPC 当前失败抛出，loadRules 路径保留 loadError；retry pending 时旧 reject 不清 loading、不改 status/filter；retry 后清当前错误并显示新规则/Stopped，未 create。 |
| PortForwardModal session change / real close+reopen | 新 3 格：session A 格式化错误在 B 成功后消失；真实 close 控件触发 parent 移除，B reopen 的真实 status 失败显示格式化错误，“重试”实际只读成功；A status resolve/reject 晚到后不出现旧规则/超时/重试，B filter/status/loading 保持。 |

## 实际命令与退出码

以下命令除单独说明均在 `E:\Projects\openshell\frontend` 执行，使用已有依赖；所有 Vitest 都 `--maxWorkers=1 --minWorkers=1`。

| 时间（本地） / 命令 | 退出码 / 结果 |
| --- | --- |
| 22:43:09 `./node_modules/.bin/vitest.cmd run src/components/SnippetBar.test.tsx --maxWorkers=1 --minWorkers=1` | 1；目标用户错误缺失红测，另有跨测试 mockOnce fixture 污染。 |
| 22:43:28 同上（只修正 mockReset 隔离，无生产变更） | **1；7 pass/1 fail，目标红测：快捷栏缺格式化 IO 错误。** |
| 22:43:49 同上（初版最小修复） | 1；错误/retry/warning 已通过，发送 success toast 被既有 3 秒 dedupe fixture 干扰。 |
| 22:44:16 同上 | 1；Date fixture 清理使用 restoreAllMocks 影响原 serial encode mock，非生产红测。改为仅恢复 Date.now，保留所有原串口断言。 |
| 22:44:36 同上 | **0；8/8。** |
| 22:45:38 `./node_modules/.bin/vitest.cmd run src/components/PortForwardModal.test.tsx src/stores/snippetStore.test.ts --maxWorkers=1 --minWorkers=1` | **1；18 pass/1 fail，目标红测：B 成功后 A 格式化 IO/readError/重试残留。** |
| 22:45:58 同上（加读取起始清 readError） | **0；19/19。** |
| 22:46:58 `./node_modules/.bin/vitest.cmd run src/stores/forwardStore.test.ts src/components/SnippetBar.test.tsx --maxWorkers=1 --minWorkers=1` | 1；扩展 reject fixture 未预置“失败时保留”的既有列表，期望误把失败读取当成功读；补完整既有规则 fixture，无生产修改/断言删除。 |
| 22:47:24 `./node_modules/.bin/vitest.cmd run src/stores/forwardStore.test.ts --maxWorkers=1 --minWorkers=1` | 0；12/12。 |
| 22:48:11 `./node_modules/.bin/vitest.cmd run src/components/ImportExportModal.test.tsx --maxWorkers=1 --minWorkers=1` | 1；Vitest 2 不支持 `toHaveBeenCalledExactlyOnceWith`，12 个 fixture matcher 错误；改为等价的次数+参数两个断言，无生产改动。 |
| 22:48:25 同上 | 0；43/43。 |
| 22:49:04 / 最终 22:50:10 `./node_modules/.bin/vitest.cmd run src/components/ImportExportModal.test.tsx src/components/SnippetBar.test.tsx src/components/PortForwardModal.test.tsx src/stores/snippetStore.test.ts src/stores/forwardStore.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot` | **0；5 files，84/84**（ImportExport 45、SnippetBar 8、PortForwardModal 7、snippetStore 12、forwardStore 12）。新测试不把期望的 failure fixture console.warn 当未处理拒绝。 |
| 错误 cwd 初次 ESLint：repo root `./frontend/node_modules/.bin/eslint.cmd frontend/src/...` | 1；root 无 eslint.config，未执行 lint。 |
| 最终 `./node_modules/.bin/eslint.cmd src/components/SnippetBar.tsx src/components/SnippetBar.test.tsx src/components/PortForwardModal.tsx src/components/PortForwardModal.test.tsx src/components/ImportExportModal.test.tsx src/stores/snippetStore.test.ts src/stores/forwardStore.test.ts` | **0；无输出/无 warning。** |
| repo root `git diff --check -- frontend/src/components/ImportExportModal.test.tsx frontend/src/components/SnippetBar.tsx frontend/src/components/SnippetBar.test.tsx frontend/src/components/PortForwardModal.tsx frontend/src/components/PortForwardModal.test.tsx frontend/src/stores/snippetStore.test.ts frontend/src/stores/forwardStore.test.ts` | 0；本人文件无空白错误。 |

## 依赖、限制与 concerns

- 两处最小生产修复可独立集成；仅复用现有 store 错误/读取与 toastStore，无 backend/IPC/types 发布依赖。archive_token、canonical body/kind、统一发送、可选 throwOnError 未改。
- 本轮边界测试使用真实 store/组件与隔离 IPC fixture；未读取用户浏览器或数据库。真实 Tauri WebView、真实文件系统读错误、真实 JSON/osvault 归档与主保险库并未执行。快捷栏错误文字/按钮复用原尺度，未做真实 WebView 视觉验收。
- 全量 frontend、typecheck/build、Cargo/fmt/Clippy、dist 扫描由 CEO 集中执行；本线没有运行。真实 RDP/NLA、CredUI、实体串口、外部 SSH/X11/agent、非 Windows、安装/升级继续未验证，84 个测试不能替代。
- `loadStatuses()` 单独读取失败仍以 rejected Promise 提交给调用者；本轮未引入通用取消/事务框架或新增共享错误字段。已保留现有错误传播行为。

## 集中 typecheck 反馈修复

- CEO 集中 `pnpm --filter @openshell/frontend typecheck` 实际失败（`audit/task9-typecheck.log`）：tsc exit 2、外层 pnpm exit 1；本线 PortForwardModal.test.tsx 三处 TS2322。新真实 forwardList fixture 声明为 PortForwardRule，导致可选 credential_state 不能赋给 IPC 返回 ForwardRuleView 的必填字段。此前 Vitest 84/84 未证明编译通过，这次门禁失败归本线 fixture。
- 仅修改本白名单 PortForwardModal.test.tsx：所有规则 fixture 显式声明现有 ForwardRuleView；已有用户名密码规则补 has_socks_password=true / credential_state=ready，坏引用保留 needs_reentry，新无凭据本地规则补 has_socks_password=false / credential_state=none。移除原两处 socks_auth 的 `as any`，不增加 any、断言或降低真实类型，不改生产契约。
- 22:54:50 / 最终 22:55:20 定向命令：`./node_modules/.bin/vitest.cmd run src/components/PortForwardModal.test.tsx src/stores/forwardStore.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot`，exit 0，2 files / 19/19。最终限定 `./node_modules/.bin/eslint.cmd src/components/PortForwardModal.test.tsx` exit 0；该文件 `git diff --check` exit 0。
- 本线未重跑集中 typecheck；CEO 负责重跑并记录最终编译门禁，不能用 19 个 Vitest 代替。
