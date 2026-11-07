# Task 6 Feedback

> 只局部修改自己的小节并重读确认。当前为待下发骨架，不是验收结果。

## 员工1：gpt

状态：S02/S08 本轮定向修复及门禁通过；S01 静默凭据损坏已修，但完整恢复仍有 P1，不能判整个 S01 或 Task6 通过。未暂存、未提交、未推送。

开工基线：`Fce/task6-integration@9b05523777b38d5f1e1653abf9b57449f88c18cc`。开工已有 `aiSettingsStore.ts`、`syncStore.ts`、`updater/AboutUpdateTab.test.tsx`、`updater/store.test.ts` 修改，均保留；后续 gemini/trae 源码和回执也保留。只记录相对该基线新增 diff，没有恢复旧 patch/stash、reset/切回旧远端，没有改依赖、锁文件、schema、共享 IPC/DTO 或已推送的 importer/serial/AI/SFTP 实现。

改动清单：

- `backend/crates/app-core/src/network_secrets.rs`：SOCKS 只验证有效秘密引用；缺 marker 不再作为明文证据，缺失/软删除/来源不明时报错并保留原值；标记探测也排除 tombstone。代理明确的 `password` 字段仍事务迁移。
- `backend/crates/app-core/tests/network_recovery_test.rs`：真实创建引用后删除 marker/secret 的启动、恢复回归；覆盖硬删除、tombstone、混合代理明文、schema1 已引用快照、错主密码、明确补录及事务失败重试。原普通/26字母/ULID 口令解密一致、快照无秘密断言保留，改为明确补录后验证，不伪装自动来源识别。
- `backend/crates/app-core/src/sync_service.rs`、`sync_codec.rs`、`tests/sync_lifecycle_test.rs`：认证全部历史后按最高 revision 成对选 record/envelope，补逐条元数据校验；graph/conflict/dirty/revision/tombstone 和 cursor 同事务。公开函数签名、依赖校验和冲突恢复保持。
- `backend/crates/app-core/src/app_services.rs`：来源注释修正；同一个 `backup_retention_tests` 模块原样移到生产项之后，两项测试未删改。
- `backend/crates/forward/tests/lifecycle.rs`：保留4秒释放阈值，等 closed 信号并用重新 bind 确认监听释放，再断言真实 connect 拒绝；保留 pending EOF、其他规则隔离和远端既有 relay EOF。未改 forward/ssh 生产代码。
- `scripts/check-package.mjs`、`scripts/check-package.test.mjs`：复用已声明的 TypeScript parser，修正正则引号造成的递归边界误报；保留 YAML 连字符键、注释、转义/序列化真秘密和私钥/文件/指纹检测；未增加依赖。

关键实现说明：

- **S01**：主密码只能解锁保险库，不能证明旧 `socks_password_ref` 是明文。没有可靠来源时保留并拒绝，不能把真实 ref 加密为错误密码。现有 `prepare_forward` 密码输入可明确补录三类口令；恢复遇到不确定 SOCKS 旧值时，同事务内代理转换也回滚。补录成功证据在 API 层，不能据此宣称 UI 已可恢复。
- **S02**：真实服务返回 `record_history`；旧客户端累计全部版本却按 ID 覆盖 envelope，并应用旧 forward 导致删除秘密引用失败。现改为每条解密认证、核对 ID/type/revision/schema/device/deleted/时间/size/cursor 等后，按最高 revision 同时选记录和 envelope，不依赖客户端时间，也不因存在新版本而接受旧版篡改。复查发现的游标后置提交也已移入同事务。
- **S08**：原 Task5 失败没有原样重现，原单例和整个 forward 在本机均通过；合成探针明确证明监听约0.025秒释放、约0.040秒可重新 bind，旧 connect 混合采样仍可因 Windows 拒绝耗时触发4秒假超时。只修释放观测，不声称发现产品监听泄漏；没有扩大超时或去掉真实拒连/EOF断言。

自测结果（命令/退出码/证据）：

以下 Cargo 均为 `cargo +stable-x86_64-pc-windows-msvc`，统一带 `--locked --offline --jobs 2`；HTTP 回环只在测试子进程设置 `NO_PROXY/no_proxy=127.0.0.1,localhost`。证据位于 `audit/remediation-task6/gpt/`；完整命令见各 summary 和 `forward-verification.json`。

| 命令/目标 | 退出码 | 结果与证据 |
|---|---:|---|
| `test -p openshell-app-core --test network_recovery_test pre_marker_missing`，修复前 | 101 | 真实 ref 缺失后恢复仍成功，静默存错密码；`s01-red.log` |
| `test -p openshell-app-core --test sync_lifecycle_test history_catch_up_keeps_latest_forward_and_matching_conflict_envelope`，两次红例 | 101 / 101 | 旧 forward 依赖失败、旧时间元数据篡改被接受；`sync-history-red.log`、`sync-history-metadata-red.log` |
| 同一 history 目标，cursor 触发器红例 | 未回收 | `sync-cursor-red.log` 为0过1失败：错误后已保存 `latest`，而非 `offline-local`。worker 中断前未回收进程退出码，不虚构退出码 |
| `test -p openshell-app-core`，最终版 | 0 | **77通过、0失败、0 ignored**，含游标 INSERT/UPDATE 回滚、history 与恢复/归档；`app-core-tests-final.log`。前一轮完整目标也77过，见 `app-core-tests.log` |
| `test -p openshell-forward --test lifecycle server_disconnect_releases_all_rule_types_and_pending_handshakes -- --nocapture` | 0 | 1通过；`forward-green-single.log` |
| `test -p openshell-forward -- --nocapture` | 0 | 16通过；`forward-green-full.log` |
| `test -p openshell-forward -p openshell-ssh -- --nocapture` | 0 | 正常并行组合29通过，0失败/ignored；`forward-green-ssh-parallel.log` |
| `clippy -p openshell-app-core --all-targets -- -D warnings` | 0 | `app-core-clippy-final.log` |
| `clippy -p openshell-forward -p openshell-ssh --all-targets -- -D warnings` | 0 | 两crate相关完整目标；`forward-clippy.log` |
| `node --test scripts/check-package.test.mjs`，最终版 | 0 | 7通过、0失败/skip；`package-review-green.log`。原误报/转义键以及 review 的 YAML/注释漏检红例日志保留 |
| `node scripts/check-package.mjs frontend/dist` | 0 | 隔离 APPDATA/HOME/USERPROFILE，真实当前 dist 35文件；`package-review-dist.log`。未读用户库或输出候选秘密 |
| 7个改动Rust文件 `rustfmt --edition 2021 --check`；两脚本 `node --check`；白名单 `git diff --check` | 0 / 0 / 0 | Rust格式见 `rustfmt-final.log`；无全仓格式化 |

完整细节见 `s01-summary.md`、`sync-summary.md`、`forward-summary.md`、`package-summary.md`、`review-summary.md`；9个白名单源码文件的本轮 diff 为 `task6-gpt.diff`。

验证范围（逐S编号）：

- **S01**：真实 pre-marker 引用库、现代 marker、混合库、schema1 引用快照缺 secret 均拒绝，不增错秘密、不改原 ref；三种形状口令明确补录后解密一致，正确主密码恢复可继续；锁库/错密码/触发器失败不丢旧值、可重试。后端补录通过，完整 S01 未关闭。
- **S02**：真实 HTTP 服务和数据库保留 **509条 history、501个填充会话、3版 forward**，跨500项分页；两次换密并删除旧 secret，客户端时间 `1→20→10` 仍选 revision3。验证两条 tombstone、唯一最新冲突及对应 envelope、本地副本、dirty/revision、游标/冲突故障原子回滚、冲突恢复、不重复上传；11种旧历史篡改均拒绝，恢复原记录后普通同步成功。
- **S08**：单例、完整 forward、正常并行 SSH 组合及两组 all-targets Clippy 通过；监听隔离、远端取消拒绝/重试和既有 relay EOF 保持。包扫描保留原4组断言，新增安全JS边界、真秘密/转义/序列化/YAML/注释/私钥/指纹覆盖，真实当前 dist 通过。

未验证部分：

- workspace 全量 test/check/clippy/fmt 和全前端门禁由 CEO 集中执行；没有用本轮定向结果覆盖 Task5 旧失败报告。
- 真实用户旧库/备份的 UI 恢复、外部 SSH 断链、真实串口/RDP/X Server、跨OS、安装升级未验证；未重建 dist、未扫描安装包。

验收对照：

- 本轮9个源码/测试文件均属 gpt 白名单，无共享 IPC/DTO、依赖/锁文件、schema 变更，保留其他员工源码和回执。
- 无 skip/allow、删除既有安全断言、吞错、重复提交或扩大超时；来源不明时明确拒绝，不把恢复限制伪称通过。
- 独立复查的扫描器漏检与游标事务缺口已修并补回归，没有把中断 worker 或单元数量当作协议/发布验收。

范围外发现（未处理）：

- **S01/P1**：`forward_list` 全量调用 `forwards(None)`，`forward_start` 也先校验全库。一条缺 ref 会挡住列表/编辑入口和其他完好规则启动。`prepare_forward` 修复证据仅在 API 层，用户未必能从界面进入；schema1 安全快照失败时也进不了普通编辑页。desktop/前端不在本员工白名单，未跨界修改。

遗留问题与风险：

- 来源不明的旧 SOCKS 值会保留并报错，需后续明确补录/秘密备份恢复入口。**S01 保持 P1，不能按完整迁移修复通过推送。**
- 包扫描需要仓库已有 TypeScript 开发依赖；未声明能识别任意混淆或压缩安装包内容。

需要CEO决定的事：

- 单独安排 S01 desktop/前端范围：分开脱敏元数据列表和单规则运行校验，利用已有密码保存接口按规则补录，并提供 schema1 明确确认/补录入口。列表不可返回来源不明的原 `socks_password_ref`，它可能是旧明文。涉及恢复契约的部分按 main.md 另排 L3，不以主密码或字符串形状推断来源。
- 停止并行编辑后集中门禁，按独立暂存内容验收；本地保全基线及本回执均不代表上线或发布通过。

可独立提交组和依赖：

1. **S01安全组（P1未关闭）**：`network_secrets.rs`、`tests/network_recovery_test.rs`、`app_services.rs` 来源注释 hunk；与 S02 无新增依赖，须连同恢复限制审查。
2. **S02历史/事务组**：`sync_service.rs`、`sync_codec.rs`、`tests/sync_lifecycle_test.rs`，三者同批验证；依赖既有基线同步实现。
3. **Clippy门禁组**：`app_services.rs` 测试模块移动 hunk，可与来源注释分开暂存；两测试原样保留。
4. **转发门禁组**：`backend/crates/forward/tests/lifecycle.rs`，无 S01/S02 新增依赖，不改生产协议。
5. **包扫描组**：`scripts/check-package.mjs`、`scripts/check-package.test.mjs`，同批验证，使用已有前端 TypeScript 环境。

## 员工2：gemini

状态：已完成自测（待CEO集中验收）

改动清单：
- `frontend/src/components/ImportExportModal.tsx`:
  - 提取统一失效动作 `invalidatePendingOperations`（切tab、切策略、关闭模态框时递增 `generationRef`，自动释放活跃 `activeToken`，清空 `previewReport`，复位 `loading = false` 与 `readingFile = false`，解决 S03 永久禁用与迟到请求污染状态）。
  - 增加 `readingFile` 状态与文件读取代次归属校验（S04）：在 `handleRestoreFileChange` 中校验 `generationRef` 与组件挂载，确保文件名与内容绝对同源；保护读取中状态，禁用预检按钮并在读取中显示状态；读取失败时完整清空旧文件状态并友好提示。
  - 捕获提交后的刷新错误（S07）：`handleCommit` 成功后若视图刷新（`loadAll` 或 `loadSnippets`）失败，展示“操作已成功、刷新失败”提示及“重试刷新”动作按钮，支持只重试刷新而不重复提交 `importerCommit`。
- `frontend/src/components/ImportExportModal.test.tsx`:
  - 替换旧 mock 接入真实 `useSnippetStore` 与 mock IPC `snippetList`；
  - 新增 S03 deferred promise 覆盖切 tab / 切策略清理 loading 与旧 token 释放用例；
  - 新增 S04 A/B 文件读取乱序（JSON 与 .osvault 双分支）同源断言与读取失败保护用例；
  - 新增 S07 导入成功后真实 store 刷新失败提示与单次重试刷新断言用例。
- `frontend/src/stores/snippetStore.ts`:
  - `loadSnippets` 在 `snippetList` IPC 失败时重置 `loading = false`、不清空原列表，并正确 `throw e` 向调用方暴露失败（保持 `Promise<void>` 签名不变）；
  - `createSnippet` / `updateSnippet` / `deleteSnippet` / `setActiveGroupId` 等内部重新加载增加 catch 保护，不把刷新异常作为修改失败重试。
- `frontend/src/stores/snippetStore.test.ts`:
  - 新增测试断言 `loadSnippets` 在 IPC 失败时 reject，且原有 `snippets` 列表不被清空。
- `frontend/src/components/SnippetBar.tsx`:
  - `useEffect` 中通过 `Promise.resolve(loadSnippets()).catch(...)` 捕获异常，防止未捕获 rejection；
  - `handleCreateSnippet` 与 `deleteSnippet` 增加 try/catch 保护并给出轻量错误提示。
- `frontend/src/components/SnippetBar.test.tsx`:
  - 新增真实调用链路测试，验证 `loadSnippets` 失败时无未捕获 rejection 且列表保留。
- `frontend/src/stores/syncStore.ts`:
  - 增加 `refreshError` 与 `refreshingViews` 状态以及 `retryRefreshViews` 操作；
  - `resolveConflict` 在 `syncResolveConflict` 成功后若后续视图刷新失败，记录 `refreshError`，不抛错混淆冲突解决状态。
- `frontend/src/stores/syncStore.test.ts`:
  - 新增测试验证冲突解决成功但视图刷新失败时，`refreshError` 被正确记录且 `retryRefreshViews` 不重复执行 `sync_resolve_conflict`。
- `frontend/src/components/SyncSettingsModal.tsx`:
  - 在冲突处理面板呈现“操作已成功、刷新失败”友好提示与“重试刷新”按钮，重试仅刷新视图不重复提交冲突解决方案。
- `frontend/src/components/SyncSettingsModal.test.tsx`:
  - 补充 `useSyncStore.getState()` 模拟支持，新增解决冲突成功但刷新失败时的提示与“重试刷新”按钮定向测试。

关键实现说明：
- S03 时序：统一 `invalidatePendingOperations` 清理动作，切 tab / 切策略立即递增代次并清空 loading 与迟到 token，迟到 promise（无论 resolve 还是 reject）均因代次过期而直接返回或丢弃 token，不覆盖新 tab / 新策略的交互与 loading。
- S04 时序：`handleRestoreFileChange` 增加 `readingFile` 标记与当前代次 `currentGen` 闭包。文件 A 较慢、文件 B 较快时，A 迟到被代次拦截直接 return，绝不覆盖 B 的二进制 / 文本；读取期间按钮禁用防抢跑，读取失败完整重置文件名和内容。
- S07 链路：`snippetStore.loadSnippets` 移除吞错静默 resolve，改为重抛。上层 `ImportExportModal` 与 `syncStore` 严格区分“业务提交成功”与“后续列表刷新失败”，UI 呈现明确的“操作已成功、刷新失败”，且提供“重试刷新”单独触发刷新动作，杜绝重复调用 commit 或 resolveConflict。同时 `SnippetBar` 对初始化与变更安全捕获，消除全局 unhandled rejection。

自测结果（命令/退出码/证据）：
- 红灯复现阶段：
  - `npm --prefix frontend test -- src/components/ImportExportModal.test.tsx --run`（退出码 1，5 failed / 7 passed，复现 S03 loading 残留、S04 A/B 覆盖与读取未就绪抢跑）
  - `npm --prefix frontend test -- src/stores/snippetStore.test.ts --run`（退出码 1，1 failed / 6 passed，复现 loadSnippets 吞错返回 undefined）
- 绿灯验证阶段：
  - 定向测试：`npm --prefix frontend test -- src/components/ImportExportModal.test.tsx src/components/SnippetBar.test.tsx src/components/SyncSettingsModal.test.tsx src/stores/snippetStore.test.ts src/stores/syncStore.test.ts --run`（退出码 0，5 test files passed，40/40 tests passed）
  - 定向 Lint：`cd frontend; npx eslint src/components/ImportExportModal.tsx src/components/ImportExportModal.test.tsx src/components/SnippetBar.tsx src/components/SnippetBar.test.tsx src/components/SyncSettingsModal.tsx src/components/SyncSettingsModal.test.tsx src/stores/snippetStore.ts src/stores/snippetStore.test.ts src/stores/syncStore.ts src/stores/syncStore.test.ts`（退出码 0，0 errors, 0 warnings）
  - 本地证据归档：
    - `audit/remediation-task6/gemini/test.log`（vitest 40 项全绿日志）
    - `audit/remediation-task6/gemini/eslint.log`（eslint 0 错误日志）

验证范围（逐S编号）：
- S03：已完全覆盖。延迟 Promise 模拟切 tab、切策略，验证 loading 重置、新操作可用、迟到 token discard、无污染。
- S04：已完全覆盖。JSON 与 .osvault 双分支乱序并发读取、读取中防点、读取失败清理状态及切 tab/关闭防写。
- S07：已完全覆盖。真实 snippetStore 抛错验证、ImportExportModal 识别“操作已成功、刷新失败”并单次重试刷新、SyncSettingsModal / syncStore 冲突解决成功后刷新失败识别与单次重试刷新、SnippetBar 无未捕获 rejection 且保留列表。

未验证部分：
- 真实的 Tauri 物理跨进程 IPC 链路（测试基于 Vitest JSDOM 与 IPC Mock，未在真实编译桌面环境下启动全量 Tauri WebView）。
- 后端 Rust 历史版本同步与网络加密逻辑（属 gpt 职责范围）。
- 终端编码与真实串口硬件（属 trae 职责范围）。

验收对照：
- 文件白名单与接口契约：严格限定在 ImportExportModal、syncStore、snippetStore、SnippetBar、SyncSettingsModal 及对应测试 10 个文件，未修改任何共享 IPC / DTO / types 或其他员工文件。
- `loadSnippets` 签名：保持 `(groupId?: string) => Promise<void>` 不变，所有调用处均已同步处理失败语义。
- 状态保护：无任何 skip / allow / 放宽 timeout 操作，保留空 session 归档恢复与 token discard。

范围外发现（未处理）：
- 无。其他员工修改的文件保持原样，未触碰。

遗留问题与风险：
- 无已知缺陷。

需要CEO决定的事：
- 无。

可独立提交组和依赖：
- 组1（片段状态与加载失败处理，无上层依赖）：
  - `frontend/src/stores/snippetStore.ts`
  - `frontend/src/stores/snippetStore.test.ts`
  - `frontend/src/components/SnippetBar.tsx`
  - `frontend/src/components/SnippetBar.test.tsx`
- 组2（同步冲突解决与刷新重试机制，依赖组1）：
  - `frontend/src/stores/syncStore.ts`
  - `frontend/src/stores/syncStore.test.ts`
  - `frontend/src/components/SyncSettingsModal.tsx`
  - `frontend/src/components/SyncSettingsModal.test.tsx`
- 组3（导入导出模态框代次与刷新重试修复，依赖组1）：
  - `frontend/src/components/ImportExportModal.tsx`
  - `frontend/src/components/ImportExportModal.test.tsx`

## 员工3：trae

状态：已完成本人 S05 / S06 与协议联验的先复现、最小修复和定向回归；未 commit / push / git add，未改索引，未动他人增量。不作上线通过结论，交 CEO 集中验收与分批推送。

开工核对：`git branch --show-current` = `Fce/task6-integration`，`git rev-parse HEAD` = `9b05523777b38d5f1e1653abf9b57449f88c18cc`；相对基线初始已有 12 个他人文件增量，收尾时共 22 个，其中本人白名单 6 个。未 apply 旧 patch、未 stash pop、未 checkout/reset/restore 到 `7f89324`，未改写保全提交。

改动清单：

- `frontend/src/stores/terminalStore.ts`：新增模块级 `connectionEpochs` 代次 Map / 三个不导出辅助函数 / `StaleTargetError`；`reconnectTab` 在首个 await 前同步领取代次并置 `rdpPhase:"starting"`、`rdpClose` 失败改为可见可重试且不启动新实例、各 await 后按代次复核并释放迟到实例；`closeTab` / `markDisconnected` 递增代次；`sendTextToTab` 编码 await 后复核代次与身份；`sendCommandToTabs` 逐目标复核避免旧失败污染新连接。
- `frontend/src/stores/terminalStore.test.ts`：新增 7 项竞态回归（S05 四项、S06 三项），保留全部既有断言。
- `frontend/src/stores/serialStore.ts`：新增模块级 `serialSendEpochs`，在既有 `pauseSerialRead`（断开/重连）与 `teardownSerialSession`（主动关闭）递增；`sendCurrent` / `sendSnippet` 编码后复核，变更时以 `StaleSerialSendError` reject 且不写 `sendSerial`。
- `frontend/src/stores/serialStore.test.ts`：新增 2 项串口竞态回归。
- `frontend/src/components/XtermView.tsx`：键盘 `onData` 改走 `sendTextToTab` 复用守卫，取消错误不误标 `markDisconnected`；移除不再使用的 `encodeTextForSession` / `sendSerial` 导入与 `encodingRef`。
- `frontend/src/components/XtermView.test.tsx`：`onData` mock 捕获 handler，新增 1 项键盘发送定向用例。
- 证据：`audit/remediation-task6/trae/`（baseline.md、红/绿 vitest 日志、eslint 日志、diff-check 日志、SnippetBar 联验日志、evidence.md）。
- 本人增量：`git diff --stat 9b05523 -- <上述 6 文件>` = `6 files changed, 413 insertions(+), 26 deletions(-)`。`RdpSessionView.tsx` 经复现确认无需改动（详见关键实现说明），未改共享 IPC/types/依赖/后端/公共 UI/gemini 文件。
- 说明：`multi-agent/` 与 `audit/` 均被 git 忽略（`.gitignore:96:/multi-agent/`），本回执与 `audit/remediation-task6/trae/` 证据是已保存的本地文件，不出现在 `git status` / `git diff` 中，请 CEO 直接读文件验收；`git diff --cached --name-only` 为空，索引未被改动。

关键实现说明：

- 共享根因按项目既有 generation 范式（`containerStore.ts` 的 `isCurrent()`、`ImportExportModal` 的 gen + 迟到资源清理）落地为按 tabId 的模块级 Map，不进 store state（避免被局部 `setState` 覆盖）、不改 `TerminalTab` 结构、不改共享 DTO、不新增导出/通用取消框架/消息总线/可配置超时；静态注入的测试 fixture 缺省代次 0，无需测试复位点。串口与 RDP 的 `connectionId` 恒为 null，同 cardId 重开只能靠代次区分。
- S05 选「同步阶段标记 + 既有早退串行」：`rdpPhase:"starting"` 后 `RdpSessionView` 现有 `launched=false`、`busy=true` 自动生效，同 tab 第二次点击被既有 `if (!rdpRestartable && status === "connecting") return` 挡住，因此该组件无需新增 busy 判断。`rdpClose` 失败不再 `.catch(console.warn)` 继续启动，而是写 `error`/`failed` 并**保留旧 `rdpInfo.launch_id`**，让重试与 `closeTab` 仍能释放旧实例，避免静默遗留孤立实例；失败态按钮可再次点击重试。真实 `connected` 仍只来自 `rdpGetStatus` 的 `connected`（native OnLoginComplete），RDP launch_id/status/close 接口未动。
- S06 保持 `sendTextToTab(tabId: string, text: string): Promise<void>` 签名；入口捕获代次 + `connectionId`/`cardId`/`protocol`，`await import` 与 `await encodeTextForSession` 后重读 live tab 全部复核，不符即 reject 且绝不调用 `writeTerminal`/`sendSerial`，写参改用 live 身份。XtermView 键盘输入统一走该入口，避免另一套发送链绕过守卫。
- 串口独立发送链（`sendCurrent`/`sendSnippet`，不经过 `sendTextToTab`）先复现确有真实误发，再用另一套最小代次修补；递增点复用既有 `pauseSerialRead`/`teardownSerialSession`，未新增跨模块导出、未改 terminalStore 调用。主动取消不当作写入失败：不停定时器、不写 `sendError`。
- 未使用 any / skip / allow / 放宽 timeout / 吞错，未删任何既有断言，未新增依赖。

自测结果（命令/退出码/证据）：

证据均在 `audit/remediation-task6/trae/`，命令工作目录 `E:\projects\openshell\frontend`（diff 命令在仓库根）。

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `pnpm exec vitest run src/stores/terminalStore.test.ts --reporter=dot`（红测） | **1** | 26 项 / 5 失败 / 21 通过，复现 S05×2 + S06×3 | `s05-s06-red.log` |
| `pnpm exec vitest run src/stores/serialStore.test.ts --reporter=dot`（红测） | **1** | 9 项 / 2 失败 / 7 通过，复现串口独立链误发 | `serial-red.log` |
| `pnpm exec vitest run src/stores/terminalStore.test.ts --reporter=dot` | 0 | 26/26 通过 | `s05-s06-green-step2.log` |
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/components/XtermView.test.tsx --reporter=dot` | 0 | 2 文件 / 34 项通过 | `s05-s06-green-step3.log` |
| `pnpm exec vitest run src/stores/serialStore.test.ts --reporter=dot` | 0 | 9/9 通过 | `serial-green.log` |
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/lib/terminal-actions.test.ts src/components/XtermView.test.tsx src/components/ServerSidebar.test.tsx --reporter=dot` | **0** | 6 文件 / 60 项全通过 | `vitest-targeted-final.log` |
| `pnpm exec eslint <本人 6 文件>` | 0 | 0 errors / 0 warnings | `eslint-targeted.log` |
| `git diff --check 9b05523 -- <本人 6 文件>` | 0 | 无空白错误 | `diff-check.log` |
| `pnpm exec vitest run src/components/SnippetBar.test.tsx --reporter=dot`（只读联验） | **1** | 4 项全失败，他人进行中范围，见范围外发现 | `snippetbar-joint-verification.log` |

中途 `s05-s06-green-step1.log` 为 exit 1（25/26）：S06 串口红测误用 `connected` 态直接调 `reconnectTab`（现有实现对非 RDP + connected 本就早退），非真实重开路径；已改为真实的 `markDisconnected → reconnectTab` 并补 `closeSerial`/`openSerial` 断言，`s05-s06-green-step2.log` 转 exit 0，未通过放宽断言或删断言变绿。日志中 `sendCommandToTabs: 写入 b-1 失败` 为既有用例故意 mock 的写入失败，属预期 stderr。

验证范围（逐S编号）：

- S05：延迟 `rdpClose` 期间连续两次重启 → 首个 await 前 `rdpPhase` 已非 launched、`rdpClose("L-old")` 仅 1 次、`launchRdp` 仅 1 次、最终仅 `L-new`；`rdpClose` reject → `launchRdp` 0 次、`status:error`/`rdpPhase:failed`/`error` 非空，重试可再次关闭旧实例并只启动 1 个新实例；`launchRdp` 迟到且标签已关闭 → `rdpClose("L-late-new")`、标签不复活、`getTimerCount()===0`；同 session 两 tab 重启互不误杀；`connected` 仍只由 `rdp_get_status` 产生（既有 `:271` 用例保留通过）。
- S06：延迟 `terminalEncode` 期间 SSH `connectionId` 变更、标签 `closeTab`、串口「断开→同 cardId 重开」三种场景均 `rejects.toThrow()` 且 `writeTerminal`/`sendSerial` 零调用；正常 GB18030 单目标编码、串口路由、广播逐目标失败可见、activeTabId/历史不变（既有 `:396/:417/:445` 用例保留通过）；XtermView 键盘输入经 `sendTextToTab`，连接变更取消后不 `markDisconnected`、不自行写 PTY；`serialStore.sendCurrent`/`sendSnippet` 在重开/teardown 期间不写 `sendSerial`。
- 联验：`MultiExecBar.tsx:83-84,92` 选中子集与串口 CRLF/其余 LF、`CommandInputBar.tsx:79,346` 目标集与 appendCr、`SnippetBar.tsx:89` 只调统一入口（不在组件重新 TextEncoder 编码）、`HexDumpView.tsx:33` 与 `XtermView.tsx:547` 单 `subscribeSerial`、`MonitorDashboard.tsx:51` unavailable_fields 与合法 0、`serialStore` 定时发送 teardown 均静态核对未回归；`monitorStore.test.ts` 7 项、`ServerSidebar.test.tsx` 4 项、`terminal-actions.test.ts` 6 项、`serialStore.test.ts:141` teardown 用例通过。

未验证部分：

- 全量前端 `test` / `typecheck` / `lint` / `build`、Rust workspace 全量门禁：按 main.md 由 CEO 在停止编辑后集中跑，本轮只跑定向检查；不拿旧门禁数字（217 通过等）覆盖新增竞态。
- 真实 RDP / NLA 成功登录与真实桌面、真实串口硬件热插拔与设备错误形态、跨 OS、真实后端 `unavailable_fields` 形态：无环境；Mock 只证明时序契约，不证明成功桌面。
- `SnippetBar.test.tsx` 当前 4 项为红（他人进行中工作），UI 层统一入口调用未在绿状态复验。
- MultiExecBar / CommandInputBar / HexDumpView / MonitorDashboard 无独立测试文件，仅静态核对。

验收对照：

- 所有修改落在 main.md 的 trae 白名单及对应测试内；`sendTextToTab` 签名、RDP launch_id/status/close IPC、广播选中子集与换行规则、共享 `types/ipc.ts`/`lib/ipc.ts`/`lib/ai/aiIpc.ts`、依赖/锁文件、公共 UI、后端均未改。
- 红→绿有配对证据与真实退出码；未用 any/skip/allow/放宽 timeout/吞错，未删既有断言，未新增依赖或通用框架；`git diff --check` 与限定 eslint 均 exit 0。
- 未 `git add`/`commit`/`push`，未恢复旧基线或旧 patch，未把已隔离的 5 张壁纸放回 public，未读取真实秘密。

范围外发现（未处理）：

- `SnippetBar.test.tsx` 4 项在挂载时抛 `TypeError: Cannot read properties of undefined (reading 'catch')`，位置 `SnippetBar.tsx:36` 的 `void loadSnippets().catch(...)`；`SnippetBar.tsx`/`snippetStore.ts`/`snippetStore.test.ts` 相对基线已有 `3 files changed, 74 insertions(+), 16 deletions(-)`，属 gemini 进行中的 S07 范围，`SnippetBar.test.tsx` 本身未修改。错误早于任何发送，与本人 `sendTextToTab` 改动无关，未修改该文件，交 gemini/CEO 收口。含该文件的 7 文件集合 exit 1（60 通过 / 4 失败），去掉后的 6 文件集合 exit 0。
- 四条发送路径换行规则仍不一致（`sendCommandToTabs` `\r`、`SnippetBar` `\n`、`MultiExecBar` `\r\n`、`serialStore` 按 newlineMode），属既有语义；联验要求保持既有规则，本轮未统一、未重新设计布局。

遗留问题与风险：

- 代次是模块级内存态：页面刷新后归零，但刷新也会重建所有连接，不影响归属判断；`closeTab` 保留 tombstone 以防同 tabId 复用时旧操作复活。
- `sendTextToTab` 的取消以 `reject` 表达，`MultiExecBar` 的 `Promise.allSettled` 会对这类取消计入失败 toast；语义上「本次确实未发送」，但未做专门 UI 区分（不改 gemini/公共组件范围）。
- StaleTargetError 通过 `name` 字符串在 `terminalStore.ts` 与 `XtermView.tsx` 两侧约定，未导出常量（避免新增共享面）；若后续重构需同步两处。
- RDP `connected` 之后仍低频轮询感知退出；若后端状态延迟，标签可能短暂停留 connected（Task5 既有风险，本轮未改）。

需要CEO决定的事：

- `SnippetBar` 联验 4 项失败的归属与收口顺序（gemini S07 进行中），以及是否需要在其绿后由 CEO 补一次跨员工统一入口联验。
- 是否接受「`RdpSessionView.tsx` 不改、靠 `rdpPhase:"starting"` 使现有 busy 派生自动生效」这一最小取舍；若要求界面显式显示「重启中」文案，需另开外观批次。
- 全量门禁与按 main.md 顺序（安全/同步→归档→协议 UI→外观）的分批推送安排。

可独立提交组和依赖：

1. **S05 组**（RDP 生命周期）：`terminalStore.ts` 的 `connectionEpochs` 原语 + `reconnectTab` RDP 段 + `closeTab`/`markDisconnected` bump hunk，`terminalStore.test.ts` 的 S05 四项用例 hunk。无跨员工依赖，可独立暂存验证。
2. **S06 组**（发送归属）：`terminalStore.ts` 的 `sendTextToTab`/`sendCommandToTabs` hunk、`terminalStore.test.ts` 的 S06 三项用例 hunk、`XtermView.tsx` 与 `XtermView.test.tsx`。与组 1 同改两个文件，hunk 可分但**必须同批一起验证**（共享代次原语）；无共享契约变化，gemini 的 SnippetBar 只调用不改。
3. **串口独立组**：`serialStore.ts` 与 `serialStore.test.ts`。代码与测试可独立通过，但「同 cardId 重开」的完整端到端覆盖依赖组 1 中 `reconnectTab` 串口分支的 `pauseSerialRead` 调用（该调用本身是既有代码，未改动），建议紧随组 1/2 验证。
4. 联验与回执无源码 hunk；`RdpSessionView.tsx` 无 hunk。所有组均不含 `git add`/`commit`/`push`，由 CEO 验证暂存树后分批推送。

## CEO审查记录

2026-11-07：三份回执已读并对照实际28项增量，三路独立只读评审完成。gpt S02源代码改进成立但S01仍P1；gemini S03/S04/S07与trae S05/S06均部分完成，不能按员工“完成”字样判整批通过。具体R01–R10、触发顺序、缺失测试与发布依赖见docs/bug/2026-11-07-TASK6_REVIEW.md；返工进入新Task7，员工历史回执不覆盖。

CEO修补扫描器注释分隔漏检，先红再绿，独立副本7/7，提交7b0b57e已推功能分支。独立首页选择器候选19/19，保留Field hint契约并修正显式ID/已填值兼容，AppLayout仅两处接线，无未批准后端。Rust工作区511通过/0失败/1既有ignored；fmt通过；真实35个dist文件包扫描通过。最终集中检查和推送SHA见评审报告收尾记录。

前端并发全量有SessionModal原5秒边界超时（主工作区236过/1超时，批准副本125过/1超时）；单独9/9通过，失败用例813ms，不增加timeout。正在单worker最终复核。全量Clippy另暴露已提交AI夹具忽略read长度，CEO最小修成读完整请求头，独立审查通过；最终测试/Clippy仍以报告收尾为准。源码恢复/竞态缺口不会因测试绿而被改写为通过。

2026-11-07 开工基线调整：已验证远端保持Fce/terminal-workspace-ux@7f89324；118项待审源码已保存在本地Fce/task6-integration@9b05523777b38d5f1e1653abf9b57449f88c18cc。逐文件SHA256确认内容未变，Git工作区与索引均为空；不是验收通过、没有推送本地保全提交。后续员工增量相对9b05523记录，禁止旧patch/stash恢复覆盖。详细本地保全清单在ignored audit/task6-clean-baseline.json。

最终收尾：四批已推Fce/terminal-workspace-ux@0fafbba（扫描器、首页、AI/SFTP夹具、串口测试模块原样搬移）。最终主前端239/239、批准副本126/126；build/typecheck、Clippy all-targets -D warnings、fmt、diff及两套真实dist扫描均通过，lint均0错误/12既有warning。Rust workspace511过/0失败/1原有ignored；测试小修后批准副本AI/SFTP88及serial --lib7另通过。其余缺口转Task7，完整SHA/证据/依赖见CEO评审报告。

未通过源码仅本地保全637fd47，合入批准提交后Task7分支1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98；749个跟踪文件逐个SHA256无变化，两个工作区Git干净，旧stash保留。Task7三份互斥任务书及统一提示词已写好，等待用户下发，不能推WIP或宣告上线。
