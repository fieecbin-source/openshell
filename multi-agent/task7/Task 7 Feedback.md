# Task 7 Feedback

各员工仅编辑自己的小节，保留其他段落，写完重读确认。

## 员工1：gpt
【回执 | 员工:gpt | Task 7】
状态：本人 R01/S01「凭据恢复闭环」已完成先复现、最小修复与定向回归；未 add / commit / push / 切分支，未恢复旧基线或旧补丁，未 stash pop，未动他人增量。**当前不宣告上线**，交 CEO 集中联验、独立评审与分批推送。
开工与收尾核对：`git branch --show-current` = `Fce/task7-integration`，`git rev-parse HEAD` = `1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`，`git diff --cached --name-only` 为空；他人本轮并行的 `rdp_process.rs` / `terminalStore.*` / `serialStore.*` / `sessionStore.*` / `syncStore.*` / `vaultStore.*` / `ImportExportModal.*` / `SyncSettingsModal.*` / `TerminalTabs.tsx` / `XtermView.test.tsx` 原样保留。
改动清单（本人白名单，16 个文件修改（含 6 个测试文件）+ 1 个新增测试，另有回执与证据目录）：
- `backend/crates/app-core/src/network_secrets.rs`：新增 `ForwardCredentialState` / `ForwardRuleView` / `LegacyRecoveryItem` / `LegacyRecoveryEntry`；`unresolved_forward_items()` 单遍安全元数据列举；`forwards()` 改为脱敏单遍分类（坏行 `socks_password_ref` 置空、附状态、不写坏原行），`forwards_strict()` 保留整表严格校验给含秘密导出；抽出 `migrate_legacy_in_transaction()`，`reenter_legacy_socks()` 要求逐条覆盖并在同一 Immediate 事务内完成补录＋凭据迁移＋标记；错误文案统一为「引用不存在或来源不明，请重新保存密码」，不带原值。
- `backend/crates/app-core/src/sync_service.rs`：`sync_inner` 删除与操作无关的全库 SOCKS 预检，保留 `proxies()`、Vault 解锁、认证、history、图/游标/冲突事务断言。
- `backend/crates/app-core/src/archive_service.rs`：`export(with_secrets=true)` 走 `forwards_strict` 保持完整性拒绝；metadata 导出走脱敏 `forwards` 且不携带未知 ref 原值。
- `backend/crates/app-core/src/app_services.rs`：新增 `unlock_legacy_store()` / `inspect_legacy_recovery()` / `cancel_legacy_recovery()` / `recover_legacy_network_secrets_with_reentry()`；`recover_legacy_network_secrets()` 在存在待补录项时返回带 `requires_reentry` + `recovery_items`（仅 rule_id/name/bind_port）的 `DomainError`，不再只反复问主密码。
- `backend/crates/app-core/tests/network_recovery_test.rs`：保留原 4 项安全断言并更新为新契约，新增 4 项（主密码校验、逐条补录升级、取消重试、混合失败回滚）及 2 项前序红测，共 10 项。`sync_lifecycle_test.rs` +1（坏引用不阻断同步）、`archive_roundtrip_test.rs` +1（metadata 导出不卡死）；`network_secrets_test.rs` 未改（基线 2 项已覆盖明文不入 db/WAL/backup/json）。
- `backend/desktop/src/commands.rs`：`forward_list` 返回 `Vec<ForwardRuleView>` 并抽出 `forward_list_impl`；`forward_start` 去掉 `forwards(None)` 全库预检、改 `forward_start_credentials()` 目标级校验；抽出 `forward_update_impl` 供显式补录复用；新增 2 项路由级集成测试（坏行可见＋A 启动、真实 `forward_update` 补录后重读与启动）。
- `backend/desktop/src/lib.rs`：启动分支改走 `vault_recovery::recover_with_reentry(...)`；抽出可测的 `needs_legacy_recovery()` 判定并新增 1 项内联用例。`generate_handler!` 注册列表未变。
- `backend/desktop/src/vault_recovery.rs`：新增 `RecoveryDecision` / `recovery_prompt_labels()` / 可注入 `recover_with_reentry()`；Windows 走 `CredUIPromptForCredentialsW` 逐条输入与取消，口令缓冲区与临时值均 `Zeroizing`；非 Windows 返回明确 `Unsupported` 可操作路径；共 7 项内联测试（本轮新增 4 项真实库编排用例，并保留原 UTF-16 解码用例）。
- `frontend/src/types/ipc.ts`：新增 `ForwardCredentialState`、`ForwardRuleView extends PortForwardRule`（超集），`PortForwardRule` 增可选 `credential_state?` 保持他人消费方兼容；`frontend/src/lib/ipc.ts` 仅改 `forwardList` 返回类型。
- `frontend/src/stores/forwardStore.ts`：`loadRules` / `loadStatuses` 不再吞错，新增 `loadError` / `refreshError` / `retryRefresh` 与 `loadGeneration` 防旧异步污染；mutation 成功与刷新失败分离，重试只重读。`frontend/src/stores/forwardStore.test.ts`（新增，4 项，从真实 IPC 边界注入读失败）。
- `frontend/src/components/PortForwardModal.tsx`：「需补录」状态提示、强制显式输入新密码、仅布尔回显、读/刷新错误条与仅重读重试；`PortForwardModal.test.tsx` +1 项（共 4 项）、`ProxyManagerModal.test.tsx` +1 项代理补录不倒退（共 8 项）。`ProxyManagerModal.tsx` 只读核对未改。
- 未改：`core-domain/entities.rs` / `value_objects.rs`、`frontend/src/lib/errors.ts`、公共 Field、全局样式、scripts、依赖/锁、`backend/crates/store/*`（只读核对 backup / migrator / repo）、他人白名单文件与回执。
关键实现说明：
- **安全枚举与运行校验分离**：`forwards()` 在单次 `with_conn` 内用一条预编译语句对所有引用分类（O(n)、消除原逐行 Immediate 事务的 N+1），未知/软删/类型不符/来源不明一律置空并标 `needs_reentry`；`forwards_strict()` 保留给必须完整性的边界，未靠移除依赖校验接受不完整状态。`forward_start` 只校验目标，坏 B 不阻断好 A、B 自身仍拒绝运行。
- **恢复入口（现代库）**：`PortForwardModal` → `forwardStore` → IPC `forwardUpdate` → `forward_update_impl` → `prepare_forward(existing=Some(id))` 的显式 `socks_password` 分支 → vault secret；UI 仅回显布尔状态，补录后 `forward_list` / `forward_start` 可用（路由级测试证明）。未新增 Tauri command。
- **恢复入口（schema1 启动前）**：`lib.rs` setup 中 `needs_legacy_recovery` 命中 `requires_network_secret_migration` details → `vault_recovery::recover_with_reentry(data_dir, prompt, prompt_reentries)` → `AppServices::inspect_legacy_recovery`（主密码解锁，仅安全元数据）→ Windows CredUI 逐条输入或取消 → `AppServices::recover_legacy_network_secrets_with_reentry` → `NetworkSecrets::reenter_legacy_socks`（单事务逐条补录＋代理迁移＋来源标记、任一失败整事务回滚）→ `Self::new` 升级 → 解锁。取消经 `RecoveryDecision::Cancel` → `AppServices::cancel_legacy_recovery()` 返回明确可重试错误，不写库、不覆盖备份。`webview` 在 services 之后创建，故不依赖前端页面。
- **IPC / 契约变动**：仅 `forward_list` 的返回类型由 `Vec<PortForwardRule>` 变为 `Vec<ForwardRuleView>`（`PortForwardRule` 的超集，坏行 `socks_password_ref` 为 `null` 并附 `credential_state`）；`forward_start` / `forward_update` / `forward_create` 等签名与 `generate_handler!` 注册不变；`types/ipc.ts` 新增类型不改其他 DTO。`sendTextToTab`、serial、rdp、archive token 等冻结契约未变。错误经既有 `IpcError.details` 透传，日志/报错/details 与 `tracing::warn` 均不含未知 ref 原值、口令或 ULID/长度等来源证据。
- **不吞错与重试**：`loadRules` 读失败 `set(loadError)` 并原样抛出；mutation 提交成功后刷新失败单独记 `refreshError`，`retryRefresh()` 只重新读取，不重复提交/同步/解决冲突；代次机制阻止旧异步结果覆盖新列表与界面。
自测结果（命令/退出码，证据在 `audit/remediation-task7/gpt/`，详见 `green-evidence.md`）：
| 命令（工作目录） | 退出码 | 结果 |
|---|---:|---|
| `git branch --show-current` / `git rev-parse HEAD` / `git status --short`（根） | 0 | 分支与完整 HEAD 同基线，无暂存，他人增量保留 |
| 红测：`cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-app-core ... --test network_recovery_test` | **101** | 6 项中 2 failed：`forwards(None)` 整表失败、恢复 `details: None` 无逐条补录元数据 |
| 红测：同上 `--test sync_lifecycle_test broken_forward_reference_does_not_block_sync -- --exact` | **101** | `sync_now()` 被无关全库预检阻断 |
| 红测：`pnpm exec vitest run src/stores/forwardStore.test.ts src/components/PortForwardModal.test.tsx --reporter=dot`（frontend） | **1** | 2 文件 / 4 failed：吞错、刷新失败无独立状态、需补录提示缺失 |
| `cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-app-core --locked --offline --jobs 2 --lib --test network_recovery_test --test network_secrets_test --test sync_lifecycle_test --test archive_roundtrip_test` | 0 | 60 passed / 0 failed（29 + 10 + 2 + 10 + 9） |
| `cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-desktop --locked --offline --jobs 2 --lib` | 0 | 39 passed / 0 failed |
| `pnpm exec vitest run src/stores/forwardStore.test.ts src/components/PortForwardModal.test.tsx src/components/ProxyManagerModal.test.tsx --reporter=dot`（frontend） | 0 | 3 files / 16 tests passed |
| `pnpm exec tsc --noEmit --pretty false`（frontend） | 0 | 0 errors |
| 中间诊断：`green-app-core-network` / `green-desktop-recovery-base` / `compile-schema1` | **101** ×3 | 分别是红测尚未转绿、误导入 `AppServices` crate、默认 GNU 工具链缺 `-lgcc_eh`/`-lgcc`；前两者已修正并由最终绿测覆盖，第三者按 `gpt1.md` 改用 MSVC 工具链（与 trae 回执一致），未改环境 |
| `git diff --check -- <本人 16 个修改文件>`（根） | 0 | 无空白错误（仅 2 条 CRLF 转换提示） |
未使用 timeout / skip / allow / 删断言 / 吞错制造通过；未加 `any`、未新增依赖、未改锁文件；未并行全仓构建，仅跑受影响模块。
验证范围：
- R01/S01-1：A 好 B 坏列表（B 脱敏且标需补录）、A 目标启动、B 拒绝运行、持久化原行不被读改坏、未知 ref 不回传；未解锁 / 丢失 / 软删 secret / 标记前引用库均不被当明文重加密（26 位纯字母与 ULID 形状口令用例保留）。
- R01/S01-2：真实编辑补录 B 后重读与目标启动可用（desktop 路由级 `forward_update_impl` 集成证据，不只直接调 `prepare_forward`）；代理同类显式补录与 localStorage 不写密码回归通过；弹窗仅布尔回显、必填标记仅在为空时显示且保留无障碍语义。
- R01/S01-3：schema1 正确 / 错误主密码、3 条规则逐条补录、取消保留、少一条 / 空口令 / 重复规则混合失败整事务回滚、取消后可重试；安全元数据序列化、错误 message/details/Debug、metadata 导出与迁移前快照均不含旧值或合成口令；`Windows` 启动入口由 `needs_legacy_recovery` 判定 + 可注入 `recover_with_reentry` 编排 + AppServices 真实库恢复矩阵共同证明可达。
- R01/S01-4：`sync` 不再被无关全库预检卡死且能拉回缺失秘密，Task6 的 history catch-up / 认证 / 图·游标·冲突事务 9 项断言全绿；metadata 导出不再被坏引用阻断，含秘密导出仍拒绝缺失依赖、legacy 告警与 token retry 10 项断言全绿。
- 前端：IPC 读失败可见、mutation 成功与刷新失败分离、重试仅重读、旧异步不污染新状态；`ForwardRuleView` 为超集，`terminalStore` / `SessionModal` / `ConnectionDetailsPopover` 等既有消费方经 `tsc --noEmit` 验证兼容。
未验证部分：
- 真实 Windows CredUI 图形弹窗交互、Tauri 真机进程在 webview 创建前的端到端启动恢复、真实旧库安装升级：无交互图形环境；仅覆盖 UTF-16 解码、判定函数、可注入编排与 AppServices 真实库矩阵。
- 非 Windows 平台：无环境，仅确认明确 `Unsupported` 与可操作路径文案，不假报通过。
- 真实远程同步服务、真实硬件/图形入口、全仓 lint / clippy / build / 全量测试：按 main.md 交 CEO 集中联验。
- `backend/crates/store` 未改动，其独立测试未单独运行；迁移与备份链由 app-core 恢复矩阵间接覆盖。
验收对照（逐项）：仅改 main.md 第 15 行 gpt 独占白名单及对应测试；冻结契约与另两人接口未变；红→绿有配对真实退出码；失败/取消/重试路径均有新用例而非以成功路径替代；`forward_list` 契约变化已同步 Rust 类型、命令、前端封装、UI 与回归测试；未 add / commit / push / 切分支，未恢复旧基线/旧补丁，未 stash pop，未放回 5 张 FinalShell 图片，未读取或打印真实秘密；证据精简存 `audit/remediation-task7/gpt/`。
范围外发现（未处理）：
- 默认 `x86_64-pc-windows-gnu` 工具链的 `x86_64-w64-mingw32-gcc`（llvm-mingw/clang）缺 `-lgcc_eh` / `-lgcc`，proc-macro 链接失败；未安装驱动或改环境，与 trae 回执记录一致。
- `frontend/vite.config.ts.timestamp-*.mjs` 为 vitest 残留临时文件，已清理，未触碰他人代码。
- 他人进行中的 `syncStore.ts` 曾使 `tsc` 退出 2（trae 回执记录），本人最终 `tsc` 已为 0，说明该语法问题已由其收口；本人未修改该文件。
遗留问题与风险：
- `recover_legacy_network_secrets_with_reentry` 的补录事务提交后，`Self::new(data_dir)` 仍可能因备份/迁移失败返回 Err；此时补录已落库但 schema 未升级。下次启动 `inspect` 为空会走普通恢复路径重试，不损坏原库，但**不是单一大事务**，需 CEO 评估是否需要合并。
- SQLite `UPDATE` 不会重写空闲页，主库物理文件可能残留旧明文；本轮保证不回传、不进日志/报错/导出/迁移前快照，但未做 VACUUM 物理擦除（既有风险）。
- `cancel_legacy_recovery()` 以 `Err(ErrorCode::VaultLocked)` 表达「可重试的启动中止」，由 `lib.rs` 的 Tauri 阻塞对话框展示明确文案；若后续要区分「用户主动取消」与真实失败，需新增错误码（本轮未扩大契约）。
- `ForwardRuleView` 是 `PortForwardRule` 超集；仓库内消费方已验证兼容，但严格字段校验的外部消费者未在范围内。
需要决策者决定的事：
- 真实 CredUI / 真机旧库升级 / 全仓门禁由 CEO 组织；`+stable-x86_64-pc-windows-msvc` 是否定为 Rust 统一门禁工具链（或修复本地 GNU libgcc 路径）。
- 是否对主库做 VACUUM 以物理擦除旧明文残留页；是否把 `Self::new` 与补录合并为更大事务。
- 当前分支含未验收保全代码，**禁止直接推送整支或宣告上线**；请 CEO 在联验通过后按下列分组分批推送。
可独立提交组和依赖（按文件/hunk）：
1. **组 A｜app-core 核心**（必须整组）：`network_secrets.rs`（DTO/枚举 + `forwards`/`forwards_strict` 分流 + `unresolved_forward_items` + `migrate_legacy_in_transaction` + `reenter_legacy_socks` hunk）＋ `app_services.rs`（`unlock_legacy_store` / `inspect` / `cancel` / 两个 recover hunk）＋ `sync_service.rs`（删除全库预检 hunk）＋ `archive_service.rs`（export 分流 hunk）＋ `network_recovery_test.rs` / `sync_lifecycle_test.rs` / `archive_roundtrip_test.rs`。这些 hunk 共享 `forwards` 新返回类型与脱敏/严格契约，不可按 hunk 拆批。
2. **组 B｜desktop**（依赖组 A 的新 API）：`commands.rs`（`forward_list`/`forward_start`/`forward_update` hunk 与 2 项路由测试）＋ `lib.rs`（启动分支 + `needs_legacy_recovery` 用例）＋ `vault_recovery.rs`（全文）。
3. **组 C｜前端契约与 UI**（依赖组 B 的 `forward_list` 返回契约）：`types/ipc.ts`（仅凭据恢复类型 hunk）＋ `lib/ipc.ts`（`forwardList` 返回类型 hunk）＋ `forwardStore.ts` ＋ `forwardStore.test.ts` ＋ `PortForwardModal.tsx/.test.tsx` ＋ `ProxyManagerModal.test.tsx`。`types/ipc.ts` / `lib/ipc.ts` 是共享面，gemini / trae 本轮未改，仍需 CEO 联验时确认无冲突。
4. 组间顺序 **A → B → C**，且 C 不得先于 B 单独推送；`ProxyManagerModal.tsx`、`network_secrets_test.rs`、`backend/crates/store/*` 均未改动，不进入发布 hunk。
5. 发布依赖：CEO 全量 lint / typecheck / build / Rust workspace test 通过；真实 Windows CredUI、真实旧库升级、真实同步服务与真实硬件/图形入口验收完成；不重做历史审计。

## 员工2：gemini
【回执 | 员工:gemini | Task 7】
状态：本人 R03–R05 及 S04 回归已完成先复现、最小修复与定向回归；未 add / commit / push，未改索引，未动他人增量。不作上线通过结论，交 CEO 集中联验、独立评审与分批推送。
开工核对：`git branch --show-current` = `Fce/task7-integration`，`git rev-parse HEAD` = `1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`；他人本轮并行的 `rdp_process.rs` / `terminalStore.*` / `serialStore.*` / `TerminalTabs.tsx` / `XtermView.test.tsx` 原样保留。
改动清单（本人白名单 11 文件，9 修改 + 2 新增）：
- `frontend/src/components/ImportExportModal.tsx`：代次归属校验（Commit A pending 时切换 tab/strategy 或 preview B，A 决议时不冲掉 B 报告/文件/loading/token；A reject 孤立 token 安全丢弃；弹窗关闭时保护中途 token；成功时无条件刷新全局 store；文件异步读取原子状态与防错配）。
- `frontend/src/components/ImportExportModal.test.tsx`：新增 R03 代次与 token 所有权回归测试、S04 异步读取文件切换/卸载竞态用例、S07 真实 store 与模拟 IPC 失败隔离用例（共 20 项全部通过）。
- `frontend/src/components/SyncSettingsModal.tsx`：变更成功但刷新失败时不展示「同步/登录/注册失败」，UI 呈现 `refreshError` 警告与独立重试刷新视图按钮。
- `frontend/src/components/SyncSettingsModal.test.tsx`：补充 syncNow 与 login 刷新失败隔离及重试按钮验证。
- `frontend/src/components/SnippetBar.test.tsx`：补充 snippet 创建/删除边界与未决拒绝防护用例。
- `frontend/src/stores/sessionStore.ts`：`loadAll` 引入 `{ throwOnError?: boolean }` 与 store 层友好错误记录，保留现有 sessions/groups；变更方法内 reload 容错，避免写成功后因刷新失败导致变更误报失败。
- `frontend/src/stores/sessionStore.test.ts`（新增）：5 项 sessionStore 单元测试（加载、错误保留、throwOnError、写操作隔离）。
- `frontend/src/stores/vaultStore.ts`：`checkStatus` 引入 `{ throwOnError?: boolean }` 与 store 层友好错误记录，保留现有 status。
- `frontend/src/stores/vaultStore.test.ts`（新增）：4 项 vaultStore 单元测试（状态检查、错误保留、throwOnError、锁状态更新）。
- `frontend/src/stores/syncStore.ts`：`loadConfig` 引入 `{ throwOnError?: boolean }` 与 `configError`；`refreshSyncedViews` 采用 `throwOnError: true`；将写操作与读刷新彻底解耦，写成功后仅记 `refreshError`；`retryRefreshViews` 仅重试只读拉取且失败时不抹除错误。
- `frontend/src/stores/syncStore.test.ts`：补充 syncNow、login、register、retryRefreshViews 的刷新异常隔离与只读重试测试。
关键实现说明：
- R03 & S04 Token/代次所有权：`handleCommit` 闭包冻结代次 `commitGen` 与 `committingTokenRef`。若用户在中途切换策略、切换选项卡或发起新预览 B，Commit A 完成时不覆盖 B 的界面、不丢失 B 的 token；若 A 失败且代次不匹配则清理孤立 token；弹窗 unmount 时保护正在提交的 token 不被提早清理，resolve 时仍触发 `sessionStore.loadAll` 与 `snippetStore.loadSnippets`。文件读取引入原子暂存，未就绪或名称/内容不一致时阻断 preview。
- R04 变更与刷新分离：`syncNow` / `login` / `register` / `resolveConflict` 在后端变更成功后才调用 `refreshSyncedViews()`；读刷新（`listSessions`, `getVaultStatus`, `snippetList`, `sync_get_config`）若失败，不回滚变更成功状态，而是置 `refreshError` 并暴露重试按钮；重试只执行读取，不重新触发写 mutation。
- R05 吞错治理：`sessionStore.loadAll`, `vaultStore.checkStatus`, `syncStore.loadConfig` 在兼顾顶层挂载无 `.catch()` 不产生未处理拒绝的前提下，支持 `{ throwOnError: true }`；刷新场景传入 true，使上层调用者能精准感知读取失败；同时 store 层记录友好错误信息且保留现有内存数据。
自测结果（命令/退出码，证据在 `audit/remediation-task7/gemini/`）：
| 命令（工作目录） | 退出码 | 结果 |
|---|---|---|
| `git status`（根） | 0 | 仅变动白名单内文件，无意外暂存或他人文件污染 |
| `pnpm --prefix frontend exec tsc --noEmit` | 0 | 前端全局类型检查通过，0 错误 |
| `pnpm --prefix frontend exec vitest run src/components/ImportExportModal.test.tsx src/components/SyncSettingsModal.test.tsx src/components/SnippetBar.test.tsx src/stores/snippetStore.test.ts src/stores/syncStore.test.ts src/stores/sessionStore.test.ts src/stores/vaultStore.test.ts --reporter=verbose` | 0 | 7 文件 / 64 测试通过 / 0 失败 |
| `pnpm --prefix frontend exec eslint <本人 14 个文件>` | 0 | 0 errors / 0 warnings |
| `git diff --check -- <本人修改文件>` | 0 | 无尾随空白与格式异常 |
验证范围：
- R03：Commit A pending 切换策略并预览 B，A 成功不冲掉 B 报告/token；A 失败不覆盖 B 错误；Commit A pending 弹窗 unmount 不丢弃 token A 且全局刷新依然触发。
- R04：`syncNow`、`login`、`register`、`resolveConflict` 写成功但后续读失败时，不误报同步/登录/注册失败，设置 `refreshError` 并支持「重试刷新视图」，重试不二次提交 mutation。
- R05：`loadAll`、`checkStatus`、`loadConfig` 在未指定 throwOnError 时不抛未处理拒绝并记录 store 错误；在指定 `{ throwOnError: true }` 时精准上抛；原有 sessions/groups/status 不被清空。
- S04：文件读取未决时切 tab 或关闭弹窗，延迟 resolve/reject 不污染状态，防错配保护生效。
未验证部分：
- 全量前端构建与测试、Rust 后端编译与测试：交 CEO 集中联验。
- 真实远程 WebDAV/S3 同步服务交互、真实 Tauri IPC 进程间通信：无端到端后端环境。
验收对照（逐项）：
- 仅在个人白名单范围内改动；未 add / commit / push / 切分支；未增加外部依赖；未改动外部 IPC 接口签名；红→绿测试具备真实退出码；测试不包含 timeout / skip / allow / 吞错假通过。
范围外发现（未处理）：
- 无。
遗留问题与风险：
- `refreshSyncedViews` 中 `loadSnippets` 暂未暴露 `throwOnError` 参数，其内部通过 Promise reject 传播错误，当前实现已被 `Promise.all` 捕获，后续若需更细粒度区分各 store 状态可继续完善。
需要决策者决定的事：
- 无，已满足集中联验条件。
可独立提交组和依赖：
- 组 C（R03/S04 导入导出代次与 token 生命周期）：`ImportExportModal.tsx` + `ImportExportModal.test.tsx`。
- 组 D（R04/R05 同步与 Store 读写解耦与错误传播）：`SyncSettingsModal.tsx/.test.tsx` + `syncStore.ts/.test.ts` + `sessionStore.ts/.test.ts` + `vaultStore.ts/.test.ts` + `SnippetBar.test.tsx`。
- C 与 D 共享 `sessionStore.loadAll` 与 `snippetStore` 刷新契约，建议整体作为一个批次提交。
- 发布依赖：需等 CEO 全量 lint / typecheck / build 验证通过。

## 员工3：trae
【回执 | 员工:trae | Task 7】
状态：本人 R06–R09 已完成先复现、最小修复与定向回归；未 add / commit / push，未改索引，未动他人增量。不作上线通过结论，交 CEO 集中联验、独立评审与分批推送。
开工核对：`git branch --show-current` = `Fce/task7-integration`，`git rev-parse HEAD` = `1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`，`git status` 干净；收尾时分支/完整 HEAD 不变、`git diff --cached --name-only` 为空。他人本轮并行的 `sessionStore.ts` / `syncStore.ts` / `vaultStore.ts` 及两个新测试原样保留。
改动清单（本人白名单 7 文件，`git diff --stat` = `7 files changed, 640 insertions(+), 64 deletions(-)`）：
- `frontend/src/stores/terminalStore.ts`：`sendTextToTab` 统一代次归属（resolve/reject）、`sendCommandToTabs` 冻结目标快照、`closeTab` 首个 await 前同步失效串口发送、新增 `RdpCleanupFailure` / `rdpCleanupFailures` / `retryRdpCleanups` / `recordRdpCleanupFailure`，三处 `rdpClose` 失败不再吞掉 launch_id。
- `frontend/src/stores/serialStore.ts`：新增 `timerCardId` 归属、`failSerialSend` 旧拒绝归一、导出 `expireSerialSendEpoch`。
- `frontend/src/components/TerminalTabs.tsx`：清理失败可见错误条与点击重试。
- `frontend/src/stores/terminalStore.test.ts`（11 项 R06–R09 回归）、`frontend/src/stores/serialStore.test.ts`（3 项）、`frontend/src/components/XtermView.test.tsx`（1 项真实 IPC 边界用例 + mock 导出补齐）。
- `backend/desktop/src/rdp_process.rs`：`close_with_kill` 参数化 + native kill 失败 / 状态文件保留 / 重试成功边界测试。
未改 `XtermView.tsx` / `RdpSessionView.tsx`（归一在 store 层即可）、共享 `types/ipc.ts` / `lib/ipc.ts` / `commands.rs`、依赖锁、公共 UI、scripts；`sendTextToTab(tabId,text):Promise<void>`、serial 发送接口、rdp close/status/launch_id 契约不变。
关键实现说明：
- 旧 encode / import / write / send 的每个 await 结果都按入口冻结的代次 + 身份复核；代次或身份已变的 resolve/reject 统一抛 `StaleTargetError`，当前代次的真实失败原样上报。XtermView 既有 `StaleTargetError` 分支因此不会把重连后的新连接 `markDisconnected`，无需改组件。
- 广播进入时一次性冻结完整目标集合及各自身份/epoch，循环前与 catch 写回前用同一快照复核；不扩大目标集、不改 `"\r"` payload、`allTabs`/activeTab/历史行为。
- `closeTab` 在 `await pendingTeardown` 之前同步 `expireSerialSendEpoch(cardId || tabId)`；`deferred closeCard` 期间旧编码结果即被拦下，同 cardId 重开后旧发送仍不落新句柄。
- 串口 encode/send 旧拒绝归一为 `StaleSerialSendError`，不写 `sendError`、不停 timer；真实失败仍写错误并只停自己归属的 timer（`timerCardId` 为空表示旧式全局 timer，保持既有语义）。
- RDP 清理失败保留 launch_id 所有权与可见错误（不写回 `tab.error`，避免污染新连接界面），`retryRdpCleanups()` 对同一 launch_id 重发真实 `rdpClose`；后端 `rdp_close` 失败时保留 `rdp_launches()` 中的 entry（只读核对），故重试有效。
- `rdp_process::close_with_kill` 仅为可注入边界而参数化 kill，生产行为不变；新测试验证 kill 失败时如实返回 Err、保留 child 与临时 .rdp 状态文件，真实重试成功并全部释放。
自测结果（命令/退出码，证据在 `audit/remediation-task7/trae/`）：
| 命令（工作目录） | 退出码 | 结果 |
|---|---|---|
| `git branch --show-current` / `git rev-parse HEAD` / `git status`（根） | 0 | 分支、完整 HEAD 与基线一致，开工干净 |
| `pnpm exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/components/XtermView.test.tsx --reporter=dot --maxWorkers=2 --minWorkers=1`（frontend，红测） | **1** | 3 文件 / 11 失败 / 46 通过，11 项全部指向 R06–R09 真实根因 |
| 同上（绿测） | 0 | 3 文件 / 57 通过 |
| `pnpm exec eslint <本人 6 个前端文件>` | 0 | 0 errors / 0 warnings |
| `pnpm exec tsc --noEmit` | **2** | 14 项语法错误全部来自他人进行中 `syncStore.ts`，本人 7 文件零错误 |
| `pnpm exec vitest run src/lib/terminal-actions.test.ts src/stores/monitorStore.test.ts src/components/ServerSidebar.test.tsx --reporter=dot --maxWorkers=2 --minWorkers=1` | 0 | 3 文件通过（调用者定向联验） |
| `cargo test -p openshell-desktop --lib rdp_process::tests`（默认 GNU host） | **101** | 链接器 `x86_64-w64-mingw32-gcc` 缺 `-lgcc_eh` / `-lgcc`，环境工具链问题 |
| `cargo +stable-x86_64-pc-windows-msvc test -p openshell-desktop --lib rdp_process::tests` | 0 | 4 通过 / 0 失败 / 26 filtered，含新增 kill 失败边界用例 |
| `cargo +stable-x86_64-pc-windows-msvc fmt --check -p openshell-desktop` | 0 | 首次为 1（仅本人断言换行），按 rustfmt 修正后复跑通过 |
| `git diff --check -- <本人 7 文件>` | 0 | 无空白错误 |
未使用 timeout / skip / allow / 删断言 / 吞错制造通过；未加 `any`、未新增依赖、未改 IPC 签名。
验证范围（逐项）：
- R06：`terminalEncode` 旧拒绝 + 重连、`writeTerminal` 旧拒绝 + 重连均归一为 `StaleTargetError` 且零 `writeTerminal`；XtermView 从真实 IPC 边界注入旧写入拒绝，重连后 `markDisconnected` 零调用、新连接仍 `connected`；serial 旧 encode / 旧 `sendSerial` 拒绝不写 `sendError`、不停新 timer、不影响其他 card；当前代次真实失败仍上报错误并停自己 timer。
- R07：经真实 `terminalStore.closeTab` 路径、`deferred closeCard` 期间旧编码 resolve 不发送（不只测直接 `teardownSerialSession`）；同 cardId 重开后新发送成功、旧发送仍拒绝。
- R09：A 延迟期间 B 重连，B 零写入且不写 error；B 关闭期间不发送、不复活；未变化的 C 正常收到；`\r` payload、选中子集、activeTabId、commandHistory 不变。
- R08：首次打开 late launch → `rdpClose` reject → 记录 → retry 成功（不复活标签）；重启 late launch 同路径；`closeTab.closeRdp` 失败同类；清理记录随之清空。既有「两次快速重启」「正常 close 失败可重试」「重复重启最新代次获胜」「同 session 多 tab 隔离」「launchRdp 迟到释放」「connected 只来自 rdp_get_status」用例全部保留通过。Rust 侧 kill 失败保留 child/状态文件并重试成功。
- 真实发送调用者（逐个核对，未改其调用契约）：`XtermView.tsx:361` 键盘 onData、`MultiExecBar.tsx:92` 选中子集 `Promise.allSettled`、`SnippetBar.tsx:89`（gemini 范围，只读）、`terminalStore.sendCommandToTabs` 内逐目标、`CommandInputBar.tsx:79` 广播入口；串口独立链 `SerialSendBar.tsx:51` Enter → `sendCurrent`、快捷片段 → `sendSnippet`、`serialStore.startTimer` 定时发送；`sendTextToTab` 串口分支直接走 IPC `sendSerial`（由 store 代次守卫）。
- 清理失败可操作的重试入口：`useTerminalStore.getState().retryRdpCleanups()`（store action）＋ `TerminalTabs.tsx` 标签栏右侧条件渲染的「远程桌面清理失败 · N 项 · 点击重试」按钮（`title` 与 `aria-label` 含每条 launch_id 和错误文本）；所有权记录在 `rdpCleanupFailures: {tabId, launchId, error}[]`，不依赖 app 退出。
未验证部分：
- 全量前端 test / lint / build、Rust workspace 全量 test / check / clippy：按 main.md 交 CEO；本轮只跑定向。
- `pnpm exec tsc --noEmit` 退出 2 完全阻塞于他人进行中 `syncStore.ts`（第 110 行多余的 `}`），未修改；需其收口后 CEO 全量复跑 typecheck / build。
- 真实 RDP / NLA 成功登录、实体串口与编码回环、外部 SSH / X11、真实旧库图形恢复、安装 / 升级：无环境；mock 只证明时序契约，不证明成功桌面。
- `TerminalTabs` 新增告警条与 `MultiExecBar` / `CommandInputBar` / `SerialSendBar` / `RdpSessionView` 无独立组件测试，仅静态 / 类型 / lint 核对。
- 真实 OS kill 持续失败下的 `rdp_close` 释放只验证了 `rdp_process::close` 边界与前端重试契约，未做真实 mstsc 权限受限场景。
- 默认 GNU 工具链链接失败（101），未改环境；Rust 门禁改用 MSVC 工具链。
验收对照（逐项）：仅改 main.md 的 trae 白名单及对应测试；冻结契约与 IPC 签名未变；红→绿有配对真实退出码；失败 pending 路径有新用例（既有成功 await 测试未充当替代）；定向 vitest 用 `--maxWorkers=2 --minWorkers=1`、限定 eslint、必要类型检查、受影响 desktop 目标测试；未 add / commit / push / 切分支，未恢复旧基线或旧 patch，未 stash pop，未放回五张图片，未读取真实秘密；证据精简存 `audit/remediation-task7/trae/`。
范围外发现（未处理）：
- `frontend/src/stores/syncStore.ts` 他人进行中编辑含多余 `}`，使全量 `tsc --noEmit` 退出 2；按互斥白名单未修改，交 gemini / CEO 收口。
- 默认 `x86_64-pc-windows-gnu` 工具链的 `x86_64-w64-mingw32-gcc` 缺 `-lgcc_eh` / `-lgcc`；未安装驱动或改环境。
- 四条发送路径换行规则仍不一致（`sendCommandToTabs` `\r`、`SnippetBar` `\n`、`MultiExecBar` `\r\n`、`serialStore` 按 newlineMode），属既有语义，本轮未统一。
遗留问题与风险：
- `connectionEpochs` / `serialSendEpochs` / `rdpCleanupFailures` 均为模块级内存态；页面刷新会重建连接，但清理记录随进程重启丢失，后端 `rdp_launches()` 同样只在进程内（既有风险，本轮未做持久化）。
- `sendTextToTab` 写入成功后若期间重连，会以 `StaleTargetError` 结束（字节已写、无法回滚）；这是「旧 resolve 也校验」的取舍，UI 按取消处理，不误标断开。
- `StaleTargetError` 仍通过 `name` 字符串在 store 与 XtermView 两侧约定（既有设计，未新增共享面）。
- 广播的冻结快照只覆盖入口时刻的目标；若同一 tabId 被删除后以同 ID 重建，代次 Map 保留 tombstone，旧广播仍被拒绝。
需要决策者决定的事：
- 全量 typecheck / build 需等 gemini 收口 `syncStore.ts`；请 CEO 在其完成后集中复跑，不把本轮 `TSC_EXIT=2` 记为本人门禁通过。
- Rust 全量门禁统一采用 `+stable-x86_64-pc-windows-msvc`，还是修复本地 GNU 工具链的 libgcc 路径。
- `rdpCleanupFailures` 是否需要后续批次持久化（本轮为避免扩大范围未做）。
可独立提交组和依赖：
1. 组 A（R06/R07/R09 发送归属与串口）：`terminalStore.ts` 发送/广播/closeTab hunk + `serialStore.ts` + `terminalStore.test.ts` / `serialStore.test.ts` / `XtermView.test.tsx`。
2. 组 B（R08 RDP 清理所有权）：`terminalStore.ts` 的 RDP 段 + `TerminalTabs.tsx` + `terminalStore.test.ts` R08 用例 + `rdp_process.rs`。
3. A、B 同改 `terminalStore.ts` 与 `terminalStore.test.ts` 且共享代次原语，**必须作为一个提交组整体验证、整体提交**，不要按 hunk 拆批。无新依赖、无 IPC/共享契约变化，不触发跨员工契约全量验证要求；发布前仍需 CEO 按 main.md 跑前端全量、Rust workspace、脚本与真实 dist 扫描。
4. 发布依赖：他人 `syncStore.ts` 语法收口；真实 RDP/NLA、实体串口、外部 SSH/X11、旧库 UI 恢复、安装升级仍缺环境验收；当前分支含未验收保全代码，禁止直接推送整支或宣告上线。

## CEO 审查记录
2026-11-07：三份回执齐，三路独立只读评审并对照实际源码。三位均有实质改进，但组合批次仍部分完成，详见docs/bug/2026-11-07-TASK7_REVIEW.md。员工原回执保留；同步补拉秘密、文件读取reject/arrayBuffer等覆盖声明超过实际证据的部分已明确列出，不改成通过。

CEO已复现并补修两个恢复入口的旧Store句柄泄漏（Windows OS32红→绿），以及最先执行的非Windows指引；此安全修改只本地保全。另补共享读取归属5个红→绿用例、forward全局scope和孤儿会话回归，三个独立前端批次已推8aca310、6e4d04d、5c6baed到Fce/terminal-workspace-ux。未推未验收的安全/归档/协议整文件。

新鲜集中结果：主前端291/291，批准副本143/143、22定向；两边build/typecheck、lint0错误/12既有warning、实际dist35文件扫描通过；扫描器7/7。Rust workspace529过/0失败/1既有ignored，启动冗余闭包最小清理后另跑desktop39/39及Clippy all-targets -D warnings通过；fmt/diff通过。无新增timeout/skip/allow，真实硬件/协议成功及旧库UI恢复仍未验收。

旧库检查/取消仍写vault，组合refresh/read/conflict归属、串口owned timer与late write完成转Task8三份互斥任务。任务已细化真实失败输入与边界，不重做全仓扫描。剩余37项源码/测试保全92f4d3e，合入通过提交后新Task8基线d7bbd25c6c3f296f82e4514d3037601921da8fd3；753个文件逐个SHA256无变化，两个Git工作区干净，旧stash保留。该本地WIP没有推送，不能上线。
