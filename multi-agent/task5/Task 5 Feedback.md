# Task 5 Feedback

> 仅局部patch自己的小节并重读确认；这是待下发骨架，不是完成报告。

## 员工1：gpt

状态：已完成本轮 R01/R02/R03/R12后端/R14 的定向修复与回归；未提交、未推送、未改索引，工作区保留 Task 4 全部未提交交付。不作上线通过结论。

开工核对：HEAD `10a989e7e5597d1300c8ad8af1412b4ecb03ca3f`，索引为空，未恢复旧 baseline、未格式化、未改 Cargo 依赖/锁文件、未改前端与共享 IPC 契约。

改动清单：

- `backend/crates/app-core/src/network_secrets.rs`：新增 `app_meta['network_secrets.store']` 迁移来源标记与旧明文证据判定；`migrate_socks_rule` 改为「有标记→缺失即报错，无标记→按旧明文加密」；`migrate_legacy` 同事务落标记；`forwards()` 全量迁移后补标记；新增 5 项单测（含根因重现）。
- `backend/crates/app-core/src/app_services.rs`：`init_with_store` 在证明库内无旧明文时写来源标记（`app_meta` 缺失容错，失败只 warn）。
- `backend/crates/app-core/tests/network_recovery_test.rs`：旧库样例扩为普通明文/26 位纯字母/ULID 形状三类口令，断言全部可解密、快照不含口令、迁移后缺失 ref 报错。
- `backend/crates/app-core/tests/network_secrets_test.rs`：新增 FinalShell 认证隧道端到端断言（会话 JSON/导出/新备份/db/wal 不含口令、规则未生成）。
- `backend/crates/importer/src/finalshell.rs`：`sanitize_embedded_forwards` 剥除认证字段并写 `import_blocked`；`extract_embedded_forwards` 跳过被阻断或仍带认证的条目；新增 2 项测试。
- `backend/crates/importer/src/preview.rs`：把 `port_forwarding_warnings` 汇入既有 `warnings`，不改 `import_blocked`/去重语义。
- `backend/crates/serial/src/native.rs`：worker 去掉两处 `blocking_send`，改为「控制优先 + try_send + 队列满停止 read」的反压循环；抽 `SerialDevice` 适配层；新增 2 项反压/关停测试。
- `backend/crates/serial/src/service.rs`：会话表改每卡 `Arc<Mutex<SessionEntry>>`，全局锁只取条目；`close` 先摘除再关停；新增 `#[doc(hidden)] open_with_backend` 与 2 项多卡隔离测试。
- `backend/crates/ssh/src/handler.rs`：`RemoteRoute { dest, cancel }`、`cancel_all_remote_routes`，forwarded-tcpip relay 以 `select!` 响应取消。
- `backend/crates/ssh/src/connection.rs`：start/stop/close/健康检查失联统一创建或广播取消；stop 先取消 relay 再撤销服务端监听。
- `backend/crates/forward/tests/lifecycle.rs`：夹具在取消后保留既有子通道（与真实 OpenSSH 一致）；新增「远端 echo 停止后 EOF + 其他规则不受影响」用例。
- `backend/crates/app-core/tests/m3_integration_and_load_test.rs`：按 BUG016 现行语义重写（2 有效 + 1 阻断），保留阻断断言与加密归档回环。

关键实现说明：

- R01 不能用字符串形态判断：`SecretId::from_string` 只校验 26 位 ASCII 字母数字，`abcdefghijklmnopqrstuvwxyz` 与 ULID 形状口令都会通过，已用断言固化。改用「已持久化迁移来源」：只有证明库内无旧明文（明文代理口令，或 `socks_password_ref` 无对应 `socks_password` secret 行）才写标记；标记与迁移同事务，失败整体回滚、可重试；已引用化的库缺失 ref 一律报错，绝不把引用文本当口令加密。未新增 schema 版本、未新增 IPC。
- R02 采条目级阻断：认证字段值在解析阶段即删除（不进入会话 JSON/同步/导出/备份），条目保留非秘密字段并附 `import_blocked` 原因，预览经既有 warnings 通道提示；被阻断条目不生成规则，避免「认证隧道被降级成无认证」。未实现「经 Vault 提取认证」。
- R03 用反压而非丢弃：RX 队列满时停止继续 read，字节留在驱动缓冲，worker 每轮优先处理控制消息，close 因此有界；service 每卡独立锁消除跨卡阻塞。
- R14 认定「停止」应结束该规则包含已建立 relay：stop 先广播取消（两端 EOF）再 cancel-tcpip-forward；连接断开/失联同样先取消。此为 BUG014 之外的新增边界，未替换 BUG014 既有验收。

自测结果（命令/退出码/证据）：全部使用 `cargo +stable-x86_64-pc-windows-msvc ... --locked --offline --jobs 2`，回环测试 `NO_PROXY=127.0.0.1,localhost`；日志在 `audit/remediation-task5/gpt/`，摘要见 `summary.md`。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `test -p openshell-app-core` | 0 | 13 目标 74 项通过 0 失败（含 m3 全绿） |
| `test -p openshell-importer` | 0 | 17 项通过 0 失败 |
| `test -p openshell-serial` | 0 | 14 项通过 0 失败 |
| `test -p openshell-ssh` | 0 | 13 项通过 0 失败 |
| `test -p openshell-forward` | 0 | 16 项通过 0 失败 |

验证范围（逐R编号）：

- R01：26 位纯字母口令、合法 ULID 形状口令、普通明文口令均一次迁移且解密后与原值一致；真实缺失现代 ref 报错且行保持原样；错主密码失败后 `secret` 仍为空、旧值不丢、可重试成功；触发器强制失败整体回滚并可重试；完整恢复启动路径（含 secret-free 快照）通过。
- R02：合成 JSON 含 `socks_auth/socks_username/socks_password/socks_password_ref`；序列化 SessionInput、`export_json`、新备份、db/wal 均不含测试口令；被阻断条目未生成规则，未带认证的条目仍生成规则；预览出现「已跳过」警告。
- R03：容量 1 RX 队列填满且设备仍有数据时 `write`/`GetModem` 2s 内有界返回；反压期间字节按序完整；`is_open=false` 后 worker 有界退出；一卡 mock 阻塞时另一卡读写/控制线/close 有界完成，被摘除卡立即 `NotConnected`。
- R12：m3 导入测试保留「ProxyJump 被阻断且带原因」断言，新增独立有效第三会话，断言被阻断会话未被直连导入；有效会话 `.osvault` 加密回环与错口令失败保留；`-p openshell-app-core` 全量 0 失败。
- R14：远端 echo 建立后 `stop_rule` → 已建立 socket 读到 EOF，另一条本地规则连接仍可回环；既有取消拒绝/重试、监听释放、BUG014 断连释放用例全部保留通过。

未验证部分：

- 真实串口硬件（热插拔、真实 RX 反压、DTR/RTS 电平）：仅假设备/mock 证据。
- 真实 RDP 成功登录、真实 X Server、真实第三方 SSH 服务器：仅进程内 russh 夹具。
- 真实 FinalShell 导出文件与真实用户旧库升级：仅合成 JSON / 合成 schema 1 库。
- 前端、`backend/desktop` 命令层、workspace 全量 test/clippy/fmt/build 未执行（按任务书由 CEO 集中跑）。

验收对照：

- R01/R02/R03 的修复均落在既有 IPC 与既有函数内，未改共享契约、未新增依赖、未新增 schema。
- R12 门禁由红转绿：`-p openshell-app-core` exit 0，不再停在 m3 导入测试。
- R14 有明确停止语义与真实回环证据，并标明属新增边界。
- 未使用 any、未新增 skip、未靠吞错/重试/加 timeout 让测试通过；未删除任何既有安全/功能断言。

范围外发现（未处理）：

- 增量构建缓存：`cargo test -p openshell-ssh` 曾因 `openshell-core-domain` 旧指纹（文件 mtime 早于缓存）编译失败（`ProxyServerConfig` 无 `password_ref/has_password`），刷新源文件时间戳后正常；CEO 全量构建若遇同类报错，同样先刷新时间戳/清理该 crate 缓存，而不是改代码。
- R02 的条目级阻断提示只在预览 `warnings` 暴露；`importer_commit` 返回值仍是创建会话数，前端尚无「该隧道被跳过」的专门提示（前端不在本轮范围）。
- R01 若某调用方在 `forwards()` 之前直接 `prepare_forward` 编辑未迁移旧库的规则，仍会得到「引用无效」；正常 UI 流程先列表后编辑，风险低，但未加防护。

遗留问题与风险：

- 旧库首启若保险库未解锁，R01 的迁移只能失败为「引用不存在/保险库未解锁」，需用户走既有恢复入口；提示文案未与前端联调。
- R02 若将来确证 FinalShell 真实认证字段，需要经 Vault 的安全提取方案，当前实现会持续阻断这类隧道（安全但需手工重建）。

需要决策者决定的事：

- R02 是否排期实现「经 Vault 提取并保持认证」的完整方案（需新 IPC 与前端补录入口，超出本轮 L2）。
- R14 的停止语义按「停止即结束已建立 relay」实现，若产品希望保留既有连接需回退该批（`ssh/handler.rs` + `ssh/connection.rs`）。
- 是否要求每个修复项都补「先红后绿」的临时回退构建证据；本轮新增测试与修复同批编写，只有 R01 提供了可执行的根因重现断言（其余为先描述缺陷机制再验证修复后行为）。

建议独立提交批次及依赖：

1. 安全存储/旧库迁移：`app-core/src/network_secrets.rs`、`app-core/src/app_services.rs`、`app-core/tests/network_recovery_test.rs`、`app-core/tests/network_secrets_test.rs`。
2. 导入防线：`importer/src/finalshell.rs`、`importer/src/preview.rs`（其中 R02 落库/导出/备份断言位于批次 1 的测试文件，两批需一起验证）。
3. 串口与终端：`serial/src/native.rs`、`serial/src/service.rs`（无调用者签名变化，可独立评审）。
4. 远端转发：`ssh/src/handler.rs`、`ssh/src/connection.rs`、`forward/tests/lifecycle.rs`（依赖批次 3 之后的测试基线）。
5. 门禁修正：`app-core/tests/m3_integration_and_load_test.rs`（依赖批次 1、2 的语义）。

## 员工2：gemini

状态：已完成（R05/R06/R07/R08/R09/R12/R13）；开工核对 HEAD 为 `10a989e`，未执行 git commit 或 git push。

改动清单：
- `frontend/src/stores/syncStore.ts` & `syncStore.test.ts`：R06 移除 mock proxy fallback 与二次 invoke，直调 IPC 包装；包装 reject 立即向上抛出原错误，防重复状态在 finally 正确收口；`loadConflicts` 失败保留原有冲突列表并呈现失败；R13 冲突解决后刷新 snippetStore。
- `frontend/src/stores/sftpStore.ts` & `sftpStore.test.ts`：R06 具名导入 `sftpResumeTransfer`，移除 `(ipcModule as any)` 与 catch 后的 raw invoke 重试，reject 立即向外传播。
- `frontend/src/components/ImportExportModal.tsx` & `ImportExportModal.test.tsx`：R07 允许 archive_token 存在且 session candidates 为空时确认恢复，适配仅片段/仅密钥归档；R08 集中清理预览生命周期（切策略/关窗/切tab/重选文件均 discard 当前 token 并清空报告，generation/unmount 校验丢弃迟到 token，重预览失败阻断提交失效旧 token）；R13 归档提交成功后刷新 snippetStore，并区分提交成功与刷新失败。
- `frontend/src/components/SftpView.tsx`：R05 传输统计统一为 `running`，删除已废弃的 `transferring` 分支。
- `frontend/src/components/TransferQueueDrawer.tsx`：R05 传输任务状态过滤、测速展示与控制按钮统一为 `running`，移除 `transferring` 分支与 `(t.state as string)` 强转。
- `frontend/src/stores/snippetStore.ts` & `snippetStore.test.ts`：R05 彻底删除历史遗留 `command_template` 兼容字段，正文/body 与 kind/snippet 完全按共享类型对齐；测试补充 `deleted_at: null` fixture。
- `frontend/src/components/SnippetBar.tsx` & `SnippetBar.test.tsx`：R05 移除 `command_template` 属性引用；R09 废弃直接 `TextEncoder` 写 PTY，接入 trae 维护的共享入口 `sendTextToTab(activeTabId, text)`，保留 execute 模式 `\n` 与 insert 模式原样写入规则；测试补充变量展开、参数弹窗、GB18030 编码会话以及串口 `sendSerial` 通道调度的全链路集成验证。
- `frontend/src/stores/aiSettingsStore.ts` & `aiSettingsStore.test.ts`：R05 修复测试连接失败时 `failedResult.model` 误赋为 `null`（类型为 `string`）的契约错误，从对应 profile 获取或回退空串；测试 fixture 规范对齐。
- `frontend/src/updater/AboutUpdateTab.test.tsx`：R05 补齐 UpdateConfig 缺失字段（`owner`, `repo`, `proxy`, `allow_downgrade`）以及 BackupInfo 缺失字段（`size_bytes`, `app_version`），移除无用 React 导入。
- `frontend/src/updater/store.test.ts`：R05 补齐 BackupInfo 缺失字段（`size_bytes`, `app_version`）。

关键实现说明：
- R06 彻底清理吞错与重试机制：`syncStore.ts` 和 `sftpStore.ts` 不再使用 `(ipcModule as any)` 与 `catch { // mock proxy fallback }` 进行二次 invoke 重试。每个业务动作只调用一次包装函数；包装函数若 reject 则立即向上抛出原始错误。`resolvingConflictId` 与 active 状态统一在 `finally` 块中收口清理。`loadConflicts` 失败时不再伪造空列表，保留已有列表并呈现失败友好提示。
- R07/R08 归档仅配置导入与生命周期严密收口：`ImportExportModal.tsx` 解除了 `candidates.length === 0` 时阻断提交的限制，只要存在 `archive_token` 即允许提交，且在界面中将提交按钮切换为“确认恢复”，展示仅含片段/密钥/分组等归档配置的针对性提示。引入 `generationRef` 与 `activeTokenRef`，在用户切换冲突策略（skip/overwrite/keep_both）、切换标签页、关闭弹窗、重新选择文件以及组件卸载（unmount hook）时，集中调用 `importerDiscardPreview` 释放当前 token 并重置预览报告；新预览发起时同步使旧 token 与旧报告失效，校验异步返回时的 generation 一致性以丢弃迟到 token，杜绝旧失效 token 被误提交。
- R05 严格契约对齐与 fixture 补全：消除 Gemini 责任范围内所有 `tsc` 错误。`TransferState` 废弃 `transferring`，统一收敛为 `"running"`；`Snippet` 与 `SnippetInput` 剥离无必要的 `command_template` 兼容映射，读写统一按标准字段 `body` 与 `kind: "snippet"`；`aiSettingsStore.ts` 修复 `ProviderTestResult.model` 强转/赋 `null` 导致的 TS2322 错误；补全测试中 `deleted_at: null`、`BackupInfo`（`size_bytes`, `app_version`）及 `UpdateConfig`（`owner`, `repo`, `proxy`, `allow_downgrade`）字段，清理无用导入。
- R09 终端编码与协议发送统一委托：`SnippetBar.tsx` 不再在组件层通过 `TextEncoder` 将文本硬编码为 UTF-8 字节并直接调用 `writeTerminal`，而是复用 trae 维护的 `terminalStore.getState().sendTextToTab(activeTabId, text)`。`SnippetBar` 仅负责其既有职责：变量占位符展开、execute 模式附加 `\n`、insert 模式不附加换行，真正的会话编码转换（如 GB18030）与协议路由（串口走 `sendSerial`，其他走 `writeTerminal`）完全下沉由 store 统一调度。
- R13 归档恢复与冲突解决后快捷命令刷新：在 `ImportExportModal` 的 `handleCommit` 成功后，以及 `syncStore` 的 `resolveConflict` 成功后，均触发 `useSnippetStore.getState().loadSnippets()` 重新拉取片段；同时通过独立的 `try...catch` 隔离“提交成功但刷新失败”，记录警告日志而不重新抛出错误，避免调用方误判失败而重复提交已生效的 token 或冲突。

自测结果（命令/退出码/证据）：
- 日志证据存放于：`audit/remediation-task5/gemini/`
- 定向单元测试日志：`audit/remediation-task5/gemini/vitest-targeted.log`
- 类型检查日志：`audit/remediation-task5/gemini/tsc-check.log`
- 代码风格检查日志：`audit/remediation-task5/gemini/eslint-targeted.log`

| 检查命令 | 退出码 | 结果说明 | 证据路径 |
|---|---|---|---|
| `npx vitest run src/stores/syncStore.test.ts src/stores/sftpStore.test.ts src/stores/snippetStore.test.ts src/stores/aiSettingsStore.test.ts src/components/ImportExportModal.test.tsx src/components/SnippetBar.test.tsx src/components/SyncSettingsModal.test.tsx src/components/SftpView.test.tsx src/components/TransferQueueDrawer.test.tsx src/updater/` | 0 | 14 个测试文件全部通过，84 项用例全绿，0 失败 | `audit/remediation-task5/gemini/vitest-targeted.log` |
| `npx tsc --noEmit` | 2 | Gemini 负责模块 0 类型错误；剩余错误仅为 trae 独占的 `monitorStore.test.ts`/`terminalStore.test.ts` | `audit/remediation-task5/gemini/tsc-check.log` |
| `npx eslint src/stores/syncStore.ts ...` | 0 | 0 errors, 2 warnings（仅为 SftpView 既有 Hook 依赖警告，无新增 lint 问题） | `audit/remediation-task5/gemini/eslint-targeted.log` |

验证范围（逐R编号）：
- R05：`TransferState` 在 `SftpView` 与 `TransferQueueDrawer` 中统一为 `running`；`Snippet` 移除 `command_template` 且多行/变量/保存不丢内容；`aiSettingsStore` 的 `model` 赋值契约错误修复；补全 `snippetStore`/`updater` 相关缺失测试 fixture 与未使用导入清理；Gemini 文件编译 0 报错。
- R06：`syncStore` 的 `resolveConflict` 失败立即 reject（`Database locked` 原样抛出，不再 resolve 为 undefined），`loadConflicts` 失败保留现有冲突列表并呈现失败友好提示；`sftpStore.resumeTransfer` 失败立即抛出，不再回退调用 raw invoke。
- R07：`ImportExportModal` 在 session candidates 为空但 `archive_token` 存在时成功提交，支持仅片段 JSON 归档恢复与仅密钥 `.osvault` 加密包恢复；界面显示“确认恢复”按钮与专属提示。
- R08：`ImportExportModal` 在切换策略、切换标签页、重新选择文件、关闭弹窗、组件卸载时均通过 `importerDiscardPreview` 释放旧 token；迟到异步响应与重新校验失败均清理旧报告，阻断失效 token 提交。
- R09：`SnippetBar` 接入 `sendTextToTab` 共享契约；execute 模式带 `\n`、insert 模式不带 `\n`、变量占位符展开正常；GB18030 会话与串口 `sendSerial` 通道调度有端到端测试覆盖，未直接写 PTY。
- R12：修复 CEO 门禁测试中 `syncStore.test.ts` 的 1 处失败，全量 14 个测试文件 84 项测试全部通过；私有凭据不落 localStorage、不回显、留空保留/显式清除语义完好。
- R13：归档 commit 与同步冲突 resolve 成功后均自动触发 `loadSnippets` 刷新，挂载中的 `SnippetBar` 可立即看到新片段；刷新失败不导致重试已成功的 commit/resolve。

未验证部分：
- 真实物理串口硬件连接（仅通过进程内 mock 及假数据流验证数据路由与 GB18030 编码调用）。
- 真实远程多设备同步服务及冲突并发网络场景（仅通过本地状态机与 IPC mock 验证 resolve 语义）。
- trae 独占范围文件（`AppLayout.tsx`、`terminalStore.ts`、`MultiExecBar.tsx`、`monitorStore.test.ts` 等），未跨越权限边界进行修改。

验收对照：
- 严格遵循最小修复原则，未修改共享契约 `types/ipc.ts`、`lib/ipc.ts`、`lib/ai/aiIpc.ts`。
- 未使用 any 掩盖类型问题，未增加任何 skip，未调大超时掩盖竞态，未通过吞错假冒通过。
- 所有改动保留已有断言，测试完全从红转绿，证据完整记录。
- 未执行 git add、git commit 或 git push，不恢复旧 baseline，保持工作区独立。

范围外发现（未处理）：
- 前端全量 typecheck 剩余 4 处错误均在 trae 独占的 `src/stores/monitorStore.test.ts` 与 `src/stores/terminalStore.test.ts`，需等待 trae 按照其任务书收尾。
- `frontend/src/components/SftpView.tsx` 存在 2 条既有的 React Hook exhaustive-deps 警告，未在本轮做无必要的重构改动。

遗留问题与风险：
- 仅片段归档若在无连接标签页下恢复，`SnippetBar` 会更新列表但按钮保持禁用状态（符合产品预期：必须在连接终端后方可发送）。

需要决策者决定的事：
- 无阻塞性技术问题需 CEO 决策。相关接口契约均已在 CEO 裁决中锁定并严格遵守。

建议独立提交批次及依赖：
1. 归档与备份恢复防线（R07/R08/R13 部分）：`frontend/src/components/ImportExportModal.tsx`, `frontend/src/components/ImportExportModal.test.tsx`（依赖已推送的 SFTP/归档后端）。
2. 同步与 SFTP 包装及错误传播（R06/R12/R13 部分）：`frontend/src/stores/syncStore.ts`, `frontend/src/stores/syncStore.test.ts`, `frontend/src/stores/sftpStore.ts`, `frontend/src/stores/sftpStore.test.ts`（无额外依赖，可独立审查）。
3. 片段契约与终端编码调度（R05/R09/R13 部分）：`frontend/src/stores/snippetStore.ts`, `frontend/src/stores/snippetStore.test.ts`, `frontend/src/components/SnippetBar.tsx`, `frontend/src/components/SnippetBar.test.tsx`（依赖 trae 交付的 `terminalStore.sendTextToTab`）。
4. 类型契约与更新器测试修补（R05 部分）：`frontend/src/stores/aiSettingsStore.ts`, `frontend/src/stores/aiSettingsStore.test.ts`, `frontend/src/components/SftpView.tsx`, `frontend/src/components/TransferQueueDrawer.tsx`, `frontend/src/updater/AboutUpdateTab.test.tsx`, `frontend/src/updater/store.test.ts`（可独立提交）。

## 员工3：trae

状态：已完成可独立验证部分（R09/R04/R10/R11/R05/R12）；R15 仅隔离核对未发布；真实硬件/成功 RDP 未验证。开工 HEAD `10a989e`，未 commit/push。

改动清单：
- `frontend/src/stores/terminalStore.ts`、`terminalStore.test.ts`：R09 共享发送入口，R04 RDP launch_id 轮询与生命周期，R10 串口 pause/resume 接入。
- `frontend/src/stores/serialStore.ts`、`serialStore.test.ts`：R10 故障保留订阅、`resumeSerialRead/pauseSerialRead/stopSerialSendTimer/teardownSerialSession`。
- `frontend/src/stores/monitorStore.ts`、`monitorStore.test.ts`：R11 `isFieldUnavailable/readAvailableMetric`。
- `frontend/src/stores/settingsStore.ts`、`settingsStore.test.ts`：R12 默认可发布化与迁移语义、显式自定义值保留。
- `frontend/src/components/MultiExecBar.tsx`：R09 按目标会话编码发送、失败 toast 汇总。
- `frontend/src/components/RdpSessionView.tsx`、`TerminalTabs.tsx`：R04 launched/connected 正确呈现。
- `frontend/src/components/HexDumpView.tsx`：R10 恢复数据后清除读取错误。
- `frontend/src/components/MonitorDashboard.tsx`、`ServerSidebar.tsx`：R11 “不可用”字段展示与历史假 0 过滤。
- `frontend/src/components/AppLayout.tsx`：R05 `transferring`→`running`。
- 证据：`audit/remediation-task5/trae/`（spec/tasks/evidence + vitest/eslint 日志）。

关键实现说明：
- R09：`sendTextToTab(tabId,text)` 按 Session.encoding 编码，串口 `sendSerial(cardId||tabId)`，其余 `writeTerminal`；不增删换行/历史/activeTabId，目标不可用或失败 reject。`sendCommandToTabs` 参数与换行不变，逐目标复用并记录 error；MultiExecBar 串口 CRLF、其余 LF，失败 toast 不吞错。SnippetBar 联调待 gemini。
- R04：按 `tabId+launch_id` 轮询 `rdpGetStatus`；`launched/starting` 不写 connectedAt，只有 `connected`（native OnLoginComplete）才 connected；failed/closed 映射并停轮询；close/reconnect 先停轮询并 `rdpClose` 自有 launch；迟到 launch 在标签已关时关闭返回实例；同 session 多标签按 launch_id 隔离；launched 状态重启按钮放行；关闭后轮询不复活。
- R10：读失败不再删除订阅（HEX effect 仅依赖 cardId），停轮询并通知 onError；重连成功 resume，断开 pause；teardown 同时停定时发送/轮询/订阅/错误。主动 close 不自动重连，重连不恢复旧定时发送。
- R11：`unavailable_fields` 命中或缺字段返回 null，UI 显示“不可用”；合法 0 保留（首采样→第二采样用例覆盖）；CPU 历史过滤不可用点；沿用 timestamp 陈旧/失败状态。
- R12：默认恢复为可发布组合 `clean_light/14px/backgroundId="" / opacity 50 / blur 0`（`finalshell` 深色被 `allThemes` 浅色规则过滤，且 `fs_bg1` 依赖无授权素材）；保留一次性 `daylight_v1` 迁移与用户已存设置，新增显式自定义值跨重载测试。
- R15：只核对不发布。5 张 `frontend/public/fs-bg*.jpg` 共 6,312,278 字节仍在本地未跟踪；默认值已去掉引用；未改 `lib/wallpapers.ts`（非 trae 白名单）。

自测结果（命令/退出码/证据）：
- `pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/stores/settingsStore.test.ts` → 退出码 0，4 files / 48 tests passed（19/7/7/15）。
- `pnpm exec eslint <上述 15 个 trae 文件>` → 退出码 0，0 errors，2 warnings（AppLayout 既有 hooks deps）。
- `git diff --check` → 退出码 0（仅 CRLF 提示）。
- 日志：`audit/remediation-task5/trae/vitest-task5.log`、`eslint-task5.log`。

验证范围（逐R编号）：
- R09：GB18030 单/多目标编码、串口路由、不可用目标 reject、activeTabId/历史不变、逐目标失败可见。
- R04：启动→launched、轮询 connected 才成功、失败/关闭映射、close-during-launch、launched 重启、双实例隔离、关标签不复活。
- R10：故障保留订阅并恢复轮询、pause/resume、统一 teardown、既有单消费者完整广播不丢字节。
- R11：首采样不可用→第二采样合法 0；缺字段不可用；监控/侧栏消费。
- R05：仅 AppLayout 比较值；typecheck 未跑。
- R12：默认与迁移、显式自定义值保留。
- R15：素材字节数与本地保留；未发布。

未验证部分：
- 真实 RDP 成功登录、NLA、其他 OS：R04 仅契约层验证。
- 真实串口热插拔/故障注入：R10 仅 store + mock IPC。
- 真实监控采样中 unavailable_fields 的后端实际形态与 UI 视觉未回归。
- 全量 frontend test/typecheck/build 未跑（CEO 收尾），故不声称 R05 门禁已解除。
- SnippetBar 使用 `sendTextToTab` 的真实联调依赖 gemini。

验收对照：
- R04/R09/R10/R11/R12 有最小回归与真实调用者；R05 仅本文件范围修复；R15 未混入发布素材。真实环境项按 main.md 保持未验证，不作上线结论。

范围外发现（未处理）：
- `settingsStore.ts` 仍保留深色 `finalshell` 主题条目（被 `allThemes` 浅色过滤，属外观批次），本轮未删以免回退他人未提交外观工作。
- `frontend/src/lib/wallpapers.ts` 仍引用未跟踪 fs-bg 素材；该文件不在 trae 白名单，未修改。

遗留问题与风险：
- RDP 在 connected 后仍低频轮询以感知退出；若后端状态延迟/不报 closed，标签会停留在 connected 直到进程事件。
- 串口轮询恢复依赖 `terminalStore` 重连路径与 XtermView 的按状态重订阅；真实设备错误形态可能需再补。
- R05 的 typecheck 门禁仍需全量确认；共享 IPC 未改，`sendTextToTab` 签名已按 CEO 锁定。

需要决策者决定的事：
- 外观/壁纸批次是否继续保留 `finalshell` 主题条目与 `wallpapers.ts`，以及 5 张素材的再分发授权结论。
- 全量门禁与 R05 typecheck 的最终确认。

建议独立提交批次及依赖：
1. 行为修复批次（可独立、依赖已交付共享 IPC）：`terminalStore/serialStore/monitorStore` 及其测试、`MultiExecBar`、`RdpSessionView`、`TerminalTabs`、`HexDumpView`、`MonitorDashboard`、`ServerSidebar`、`AppLayout`。
2. 设置批次（可独立）：`settingsStore.ts` 与 `settingsStore.test.ts`；与外观/壁纸批次分离。
3. 外观/壁纸批次（暂缓推送）：`lib/wallpapers.ts`、`fs-bg*.jpg`、`finalshell` 主题条目；无授权前不提交。
4. 共享 IPC/类型无本轮 hunk；SnippetBar 改动属 gemini 批次。

## CEO审查记录

待实际回执和代码复核。员工不得改动本节。

派工前核验：用户确认仍为员工1 gpt、员工2 gemini、员工3 trae；六份任务文件已读回，身份分流及回执小节存在。当前HEAD为10a989e，索引为空，远程同步，137条待处理状态。共同发送契约、先后顺序与提交批次已在main.md的“CEO 派工前审查与对接裁决”锁定，员工执行前共同读取；任务仍待用户向外部员工下发，未启动或代替操作三人的工具。本轮仅核验及完善派工文档，没有修改产品代码、运行产品测试或提交推送。
