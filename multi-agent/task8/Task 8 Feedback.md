# Task 8 Feedback

每人只改自己小节，写完重读，保留别人和历史报告。

## 员工1：gpt
【回执 | 员工:gpt | Task 8】
状态：本人 T7-02「未初始化旧库的零写入检查与原子补录」已完成先复现真实失败（红）、最小修复、定向绿测与矩阵补齐；未 add / commit / push / 切分支，未 reset/restore 旧树、未套旧 patch、未 stash pop，未动他人文件与保全内容。**当前不宣告上线**，交 CEO 集中联验、独立评审与分批推送。
开工与收尾核对：`git branch --show-current` = `Fce/task8-integration`；`git rev-parse HEAD` = `d7bbd25c6c3f296f82e4514d3037601921da8fd3`；开工 `git status --short --branch` 干净。收尾 `git status --short` 另有其他员工并行写入的前端白名单增量（gemini/trae 的 store、组件与测试，数量随并行进度变化，含未跟踪的新测试文件），按 BASELINE.md 第 9 条原样保留，本人未触碰、未清理。
改动清单（本人独占白名单 7 文件：4 个生产源码、2 个集成测试文件、1 个 desktop 源文件内的内联测试模块）：
- `backend/crates/store/src/repositories/vault.rs`：新增 `VaultRepo::save_in_transaction(&Transaction, &VaultRecord)`；原 `save` 改为自开 Immediate 事务后复用同一 UPSERT 与错误映射再提交，公开语义不变。
- `backend/crates/app-core/src/vault_service.rs`：抽出 `key_slot_parts()` 与 `build_vault_record()` 共享 helper（`init` 与恢复确认路径共用，不复制密钥槽生成/加密逻辑）；新增 `pub(crate) verify_password()` 纯内存主密码校验；`unlock` 复用同一密钥槽构造，正常解锁仍写 `last_opened_at`。
- `backend/crates/app-core/src/network_secrets.rs`：新增 `commit_legacy_recovery(new_vault, entries)` 单一 Immediate 事务边界（可选新 vault 行 + secret/SOCKS 补录 + 代理迁移 + 来源标记），抽出 `reenter_in_transaction()`；`migrate_legacy()` / `reenter_legacy_socks()` 改为复用该边界，公开签名与原有错误分支不变。
- `backend/crates/app-core/src/app_services.rs`：`unlock_legacy_store` 改为只读（已有 vault 仅纯内存验密、不写 `last_opened_at`；未初始化库不 `init`、不绑定此次口令）；新增 `pending_vault_record()` 仅在用户确认后生成待写入记录；两个 `recover_legacy_network_secrets*` 入口改走 `commit_legacy_recovery`，保留 T7-01 的 `drop(network)→drop(vault)→drop(store)→Self::new→unlock` 顺序。
- `backend/crates/app-core/tests/network_recovery_test.rs`：`old_profile()` 抽成可切换 vault 初始化状态的 `legacy_profile(bool)`；新增 `LegacySnapshot` / `legacy_snapshot()` / `assert_snapshot_unchanged()`，覆盖 vault 记录（含 `kdf_salt`/`wrapped_vault_key`/`key_check` 主密码绑定、`last_opened_at`、`updated_at`）、secret、旧 SOCKS 原值、代理、`app_meta` 来源标记、schema 与备份；新增 5 项用例（未初始化检查+取消零写入、补录缺条/空口令零写入、已有 vault 不更新 last_opened、取消不固定第一次主密码、事务中途 ABORT 整事务回滚后同口令重试）。
- `backend/crates/app-core/tests/sync_lifecycle_test.rs`：新增真实 HTTP fixture 用例 `sync_pulls_back_missing_secret_and_makes_rule_password_resolvable`。
- `backend/desktop/src/vault_recovery.rs`：仅新增未初始化旧库的可注入编排 fixture 与 2 项内联用例；`recover_with_reentry` 生产编排与 `backend/desktop/src/lib.rs` 启动调用链未改。
- 未改：`sessionStore`/`vaultStore`、公共 UI、IPC/types、依赖/锁、全局样式、scripts、`backend/desktop/src/commands.rs`（CEO 保留）、他人文件与回执。
关键实现说明：
- **根因与只读检查**：T7-02 根因是 `inspect_legacy_recovery` 复用 `unlock_legacy_store`，后者对未初始化库调 `vault.init` 立即落库、对已有库调 `vault.unlock` 顺带 `set_last_opened`。现改为 `VaultRepo::load()` 判定：已有库用 `VaultManager::unlock(KeySlotParts, password)` 纯内存校验（零 DB 写），未初始化库不创建记录、不绑定口令；`legacy_recovery_items()` 本就只读。取消因此天然零写入，不靠删除新 vault 或恢复真库补救。
- **确认后原子边界**：`VaultRepo::save_in_transaction` 接受外部 `&Transaction`，`commit_legacy_recovery` 在同一个 Immediate 事务内先写新 vault 行（仅未初始化库），再 `encrypt_in_transaction` 写 secret、更新 SOCKS 引用、`migrate_legacy_in_transaction` 做代理迁移与来源标记，一次提交。缺条/空口令/重复规则完整性校验在该事务内提前返回，`BEFORE INSERT ON secret … RAISE(ABORT)` 每库隔离注入证明 vault 行与 secret 一起回滚，不留下无法解密的 secret 或已绑定主密码。正常 `init` 与恢复共用 `build_vault_record`，没有复制加密/通用事务框架。
- **取消不固定口令**：确认前不 `VaultManager::init`，因此第一次输入的主密码不产生任何 keyslot；取消后换新主密码重试成功，旧口令解锁失败，成功重开库后逐条 `resolve` 得到正确合成口令。
- **真实同步**：复用 `server()`（DbPool + `bootstrap_single_user` + `create_router` + `TcpListener` + `axum::serve`）真实回环 HTTP；A 推送带 SOCKS 口令的规则，断言服务器 `record_history` 有该 secret 的非空密文版本；B 登录后删除本地 secret 与其 `sync_record`、回退 `last_cursor=0`，`sync_now()` 经真实 `get_changes_v2` 认证并拉回历史，断言 `resolve` 恢复口令、`pulled_count`、`sync_meta.last_cursor` 与服务器 `MAX(head_seq)` 一致、图引用一致且无冲突。不只证明坏行不阻断空同步。
自测结果（命令/退出码，证据精简在 `audit/remediation-task8/gpt/`）：
| 命令（工作目录均用 `--manifest-path E:/projects/openshell/Cargo.toml`，工具链 `C:\Users\fiee1\.cargo\bin\cargo.exe +stable-x86_64-pc-windows-msvc`） | 退出码 | 结果 |
|---|---:|---|
| `git branch --show-current` / `git rev-parse HEAD` / `git status --short --branch`（根） | 0 | 分支与完整 HEAD 同基线，开工干净 |
| 红测：`… test -p openshell-app-core --locked --offline --jobs 2 --test network_recovery_test -- --nocapture` | **101** | 15 项中 4 failed：`vault=None→Some(...)`（未初始化库 inspect 已落库）、`last_opened_at 1→当前毫秒`（unlock 写）、失败补录残留 vault、取消固定第一次口令；11 passed（`red-app-core-network.log`） |
| 红测：`… -p openshell-desktop --locked --offline --jobs 2 --lib -- --nocapture vault_recovery::tests` | **101** | 9 项中 2 failed：可注入编排取消/失败补录后 `vault_is_uninitialized` 为 false；7 passed（`red-desktop-recovery.log`） |
| 绿测：`… -p openshell-app-core --locked --offline --jobs 2 --test network_recovery_test` | 0 | 15 passed / 0 failed（`green-app-core-network.log`） |
| 绿测：`… -p openshell-desktop --locked --offline --jobs 2 --lib -- --nocapture vault_recovery::tests` | 0 | 9 passed / 0 failed（`green-desktop-recovery.log`） |
| 矩阵绿测：`… -p openshell-app-core --locked --offline --jobs 2 --test network_recovery_test --test sync_lifecycle_test` | 0 | 16 + 10 passed / 0 failed，含新增原子回滚与真实 HTTP 同步用例（`green-app-core-matrix.log`） |
| 定向全量：`… -p openshell-app-core --locked --offline --jobs 2 --lib --tests` | 0 | 29 单元 + 全部集成测试目标通过（`green-app-core-full.log`） |
| 定向全量：`… -p openshell-desktop --locked --offline --jobs 2 --lib` | 0 | 41 passed / 0 failed（`green-desktop-full.log`） |
| 定向全量：`… -p openshell-store --locked --offline --jobs 2 --lib --tests` | 0 | 12 + 7 passed / 0 failed（`green-store-full.log`） |
| `rustfmt +stable-x86_64-pc-windows-msvc --edition 2021 --check <本人 7 文件>` | 初次 **1** → 格式化后 **0** | 6 处排版差异仅出现在本人新增代码；只格式化本人 7 文件（`fmt-apply.log`），重跑无 diff（`fmt-check.log`）；未格式化无关文件 |
| `git diff --check -- <本人 7 文件>` | 0 | 无空白错误（`diff-check.log`） |
| 最终绿测（格式化后）：`… -p openshell-app-core -p openshell-desktop -p openshell-store --lib --tests --locked --offline --jobs 2` | 0 | 各目标 `test result: ok`，0 failed（`green-final.log`） |
| 中间诊断：首次误用 `--manifest-path E:/projects/openshell/backend/Cargo.toml` | **101** | workspace 根 manifest 在仓库根；改用 `E:/projects/openshell/Cargo.toml` 后全部命令正常，未改环境 |
未使用 timeout / skip / allow / 删断言 / 吞当前失败制造通过；未新增 crate、依赖或锁改动；未并行全仓测试或构建（仅三 crate 定向），未启停服务、未动真实数据库或隔离图片。
验证范围：
- gpt1.md-1：schema1 + vault 表为空 + 来源不明 SOCKS（含明文、26 位纯字母、ULID 形状）临时库；真实 `inspect`、取消、补录缺一条/空口令/重复规则失败均用 `LegacySnapshot` 逐项断言 vault 记录、主密码绑定字段、`last_opened_at`/`updated_at`、secret 数、旧 SOCKS 原值、代理明文、`app_meta` 来源标记、`PRAGMA user_version` 与备份数量全不变；红测日志可见 `vault: None → Some(...)` 与 `last_opened_at: 1 → 当前毫秒` 的真实失败。
- gpt1.md-2：已有 vault 仅纯内存验密，错密码在检查阶段即失败，`last_opened_at`/`updated_at` 固定值不变；未初始化库确认前零持久化记录、零口令绑定，未通过删除新 vault 或恢复真库补救。
- gpt1.md-3：未初始化库确认后新 vault 行 + secret + SOCKS 补录 + 代理迁移 + 来源标记同一 Immediate 事务；每库隔离 `CREATE TRIGGER … RAISE(ABORT)` 在 secret 插入阶段使整事务回滚，快照逐项不变、无孤立 secret；去掉触发器后同库同主密码重试成功。
- gpt1.md-4：成功后 `Self::new` 重开并解锁，逐条 `resolve` 得到正确合成口令；取消后换 `synthetic-second-master` 重试成功且 `synthetic-first-master` 解锁失败。已有 vault 与未初始化 vault 均覆盖取消、正确/错误输入、部分失败、成功重试；既有 schema 迁移失败快照恢复用例 `recovery_closes_old_handles_before_migration_failure_restore` 与 `schema_one_reference_snapshot_with_a_missing_secret_is_preserved` 保持通过。
- gpt1.md-5：真实回环 HTTP 同步 fixture（非纯 mock、非空同步），服务器有效加密 secret/history、客户端确实缺 secret，同步后 `resolve` 恢复规则口令、`pulled_count≥1`、`last_cursor == 服务器 head_seq`、图引用一致且无冲突；既有认证/图事务/冲突用例 10 项全部保持通过。
未验证部分：
- 真实 Windows CredUI 图形交互、Tauri 真机在 webview 创建前的启动恢复全程、非 Windows 平台（`prompt`/`prompt_reentries` 仅静态文案，Task7 CEO 修复未动）、真机旧库安装升级、真实远程同步服务（本轮为本地 axum 回环服务器）、安装包升级与真实协议成功率。
- 全仓 workspace test / clippy / build、前端单 worker 全量与 typecheck/lint/build、真实 dist 扫描与依赖副本验证：按 main.md 交 CEO 集中联验；本轮只跑三 crate 定向。
- 历史主库/备份的 SQLite 物理页残留：只记录边界，未对真库 VACUUM、未删旧备份。
验收对照（逐项）：
- 仅改 main.md 第 13 行 gpt 独占白名单（app-core `app_services`/`network_secrets`/`vault_service` + 恢复/同步测试、必要 store vault repository 写 helper、desktop `vault_recovery` 仅恢复编排）及对应测试；`commands.rs`、前端 IPC/DTO、公共 UI、依赖/锁、全局样式、scripts 与他人文件未改。
- 冻结契约 `forward_list/view`、密码补录、archive token、`sendTextToTab`、现有 IPC 签名与 `generate_handler!` 注册不变；未新增前端 IPC/DTO，未新增通用取消/事务框架。
- 旧库检查/取消不持久化 vault、主密码绑定、`last_opened`、来源标记或迁移状态；新 vault 记录与补录共同成功/共同回滚；未删坏行/备份、未猜 ref 形态、未改成无验证运行；保留 T7-01 句柄释放与 drop 顺序、schema 迁移失败快照恢复。
- 红→绿有配对真实退出码（101→0），失败/取消/重试路径均有真实库断言而非以成功分支替代；证据精简在 `audit/remediation-task8/gpt/`（日志均 < 18 KB，含 `.exitcode`）。
范围外发现（未处理）：
- 收尾 `git status --short` 出现若干前端文件 M 与未跟踪测试文件，属其他员工并行白名单增量（gemini 回执已列其前端批次，trae 仍在进行）；开工时干净，按 BASELINE.md 第 9 条保留，未 reset/restore/清理。
- `backend/crates/app-core/src/network_secrets.rs::proxies()` 为读接口却自开 Immediate 事务并可写代理迁移（既有行为），本轮未扩大范围处理。
- 员工2 回执记录的 `frontend/src/stores/serialStore.test.ts` 2 处 TS 未用变量导致全仓 `tsc` 退出 1，属 trae 独占范围，本人未处理。
- 默认 `x86_64-pc-windows-gnu` 工具链缺 `-lgcc_eh`/`-lgcc` 沿用 Task7 记录，本轮统一用 MSVC 工具链，未安装驱动或改环境。
遗留问题与风险：
- 补录事务提交与 `Self::new(data_dir)` 迁移仍是两个边界（Task7 既有结构）：迁移失败时 `open_with_migration` 用迁移前快照恢复，快照已含补录数据，可重试且不损坏原库，但不是单一大事务；本轮未合并，避免引入通用事务框架。
- 未初始化库在用户确认前没有 keyslot，检查阶段无法判定主密码是否输错；确认后 vault 由该次输入一次性创建，没有二次输入校验。这是「取消不绑定口令」的必然结果，需 CEO 评估 UI 文案与是否加二次确认。
- SQLite `UPDATE`/`DELETE` 不重写空闲页，历史主库/备份物理页可能残留旧明文；本轮保证不回传、不进日志/导出/快照，未做物理擦除。
- 未初始化旧库 UI 全程、真实 CredUI 与真机安装升级未验收；单元/集成通过不等于上线。
需要决策者决定的事：
- 是否对未初始化库的确认阶段增加主密码二次输入校验；是否把 `Self::new` 与补录合并为更大事务；是否对真库 VACUUM 物理擦除旧明文残留页。
- 全仓门禁、真实 CredUI / 真机旧库升级 / 真实同步服务 / 安装升级验收由 CEO 组织；`+stable-x86_64-pc-windows-msvc` 是否定为 Rust 统一门禁工具链。
- 当前分支含未验收保全（本地 `92f4d3e8…` 等）与三员工并行增量，**禁止整支推送或宣告上线**；请 CEO 在联验通过后按下述分组分批推送。
可独立提交组与依赖：
1. **组 A1｜后端原子恢复核心（必须整组，不可按文件拆）**：`backend/crates/store/src/repositories/vault.rs`（`save_in_transaction` + `save` 复用）＋ `backend/crates/app-core/src/vault_service.rs`（`key_slot_parts`/`build_vault_record`/`verify_password`）＋ `backend/crates/app-core/src/network_secrets.rs`（`commit_legacy_recovery`/`reenter_in_transaction`）＋ `backend/crates/app-core/src/app_services.rs`（只读解锁、`pending_vault_record`、两个 recover 入口）＋ `backend/crates/app-core/tests/network_recovery_test.rs` ＋ `backend/crates/app-core/tests/sync_lifecycle_test.rs`。共享新 API 与原子边界，按 hunk 拆批会编译失败或丢失零写入语义。
2. **组 A2｜desktop 编排回归（依赖 A1）**：`backend/desktop/src/vault_recovery.rs`（仅新增 fixture 与 2 项内联测试，生产编排零改动）。`backend/desktop/src/lib.rs` 未改，不进入发布 hunk。
3. 顺序 **A1 → A2**；本轮不改任何 IPC 签名或前端契约，前端无联动改动，但 A1 仍须与分支内既有的 app-core/desktop 保全 hunk 一起由 CEO 联验，不能单独复制整文件替换。
4. 发布依赖：CEO 前端单 worker 全量 + typecheck/lint/build（含他人前端增量）、MSVC Rust workspace test/check/clippy/fmt、脚本测试、真实 dist 扫描与依赖副本验证；真实 CredUI、未初始化旧库 UI 全程、非 Windows、真机旧库升级、真实远程同步服务、安装升级验收完成。不重做历史全仓审计。
5. 全部改动仅为本地 WIP，本人未 add / commit / push；真实协议/安装仍单列未验证，定向通过数不代表上线。

## 员工2：gemini
【回执 | 员工:gemini | Task 8】
状态：本人负责的异步归属、生命周期代次与可重试错误流程已全部完成先红后绿复现、最小修复与定向回归；未 add / commit / push / 切分支，未改索引，未动他人文件与保全内容。不作全系统上线通过结论，交 CEO 集中联验、独立评审与分批推送。
开工与收尾核对：
- 本地分支：`Fce/task8-integration`
- HEAD：`d7bbd25c6c3f296f82e4514d3037601921da8fd3`
- 他人白名单文件（gpt 的 app-core/store/desktop 恢复编排，trae 的 serialStore.test.ts 等）严格保留未动。
改动清单（本人独占白名单 12 文件，6 修改 + 6 测试文件更新）：
- `frontend/src/stores/snippetStore.ts`：引入 `snippetGeneration` 代次与友好错误记录；`loadSnippets` 支持重载签名 `(groupIdOrOptions?, options?)`，过期读取结果或错误不污染新状态；抛错模式受控，刷新流程与默认调用双向兼容。
- `frontend/src/stores/snippetStore.test.ts`：新增乱序读取代次防护红测用例（慢 A resolve 晚于快 B，验证 A 不覆盖 B）。
- `frontend/src/components/SnippetBar.test.tsx`：清除原有 mock 动作替身，还原真实 store 方法；通过 mock 底层 IPC `snippetCreate` / `snippetDelete` 注入真实失败，验证真实读后写与 UI 提示保护。
- `frontend/src/stores/syncStore.ts`：
  1. `syncFlowGeneration`、`refreshFlowGeneration`、`configGeneration`、`conflictsGeneration` 四重代次；
  2. `syncNow` / `login` / `register` 的 `syncing` 状态严格贯穿后端 mutation 与配置/视图刷新全程，并在 `syncNow` 入口增加 `syncing` 防重入守卫，彻底杜绝自动同步/焦点/联网在刷新阶段重入；
  3. `loadConfig` 遇到 `conflict_count > 0` 显式 `await get().loadConflicts({ throwOnError })`，彻底消除原有的 fire-and-forget；读冲突失败纳入可等待的刷新结果并进入 `refreshError`；
  4. 写成功与读刷新失败严格分离，写操作成功不因读失败回滚；旧 flow 的成功/失败/finally 不刷新新 flow 的 busy 或错误。
- `frontend/src/stores/syncStore.test.ts`：补充 `syncing` 贯穿刷新防重入红测、`loadConfig` 冲突读取失败纳入 `refreshError` 红测。
- `frontend/src/components/SyncSettingsModal.tsx`：
  1. 挂载阶段通过 `Promise.resolve().catch()` 安全消费 `loadConfig` 与 `loadConflicts` 的拒绝，杜绝未处理 Promise rejection；
  2. 当存在顶层读取错误（如冲突读取失败）时，`InlineNotice` 呈现可操作的只读「重试」按钮，直接触发 `retryRefreshViews()`。
- `frontend/src/components/SyncSettingsModal.test.tsx`：补充挂载时冲突读取失败的拒绝消费与只读重试用例。
- `frontend/src/stores/forwardStore.ts`：
  1. 引入 `refreshGeneration` 与 `statusGeneration`；
  2. `refreshAfterMutation`、`retryRefresh`、`toggleRule` 与 `loadStatuses` 纳入代次保护，慢刷新晚完成不能清除新错误或覆盖新状态；
  3. 严格保留 CEO 已验收的外部 undefined 归属全局、内部刷新显式保留 scope 及原有 generation。
- `frontend/src/stores/forwardStore.test.ts`：补充慢刷新 A 晚完成不清除快刷新 B 的 `refreshError`、慢状态 A 不覆盖新状态 B 的红测用例。
- `frontend/src/components/PortForwardModal.tsx`：挂载 `loadRules(sessionId)` 补充 mounted 与当前 `sessionId` 双重校验，解决卸载或快速切换会话时的读错误残留；`useEffect` 补全 `loadRules` 依赖消除 linter warning。
- `frontend/src/components/ImportExportModal.tsx`：`handleRefreshAfterCommit` 增加 `generationRef` 与 `mountedRef` 检查，重试 pending 期间切换选项卡/策略、预览 B 或关闭时，旧异步的成功/失败/finally 绝不写 B；全局刷新传递 `{ throwOnError: true }`。
- `frontend/src/components/ImportExportModal.test.tsx`：
  1. 新增 `handleRefreshAfterCommit` 重试 pending 期间切 tab 晚 reject 不污染新 tab 用例；
  2. 新增 Commit A pending 期间切换策略并触发 Preview B pending，A resolve 时保持 B 的 loading 与 token 归属用例；
  3. 完整补全 S04 矩阵：针对 JSON text 与加密 `.osvault` arrayBuffer，分别覆盖切 tab 晚 reject、卸载晚 resolve 与晚 reject 的全部独立分支。
关键实现说明：
- **生命周期与代次归属**：所有异步流（commit、refresh、status、config、conflict、snippet）均以单调递增局部代次（generation / flowGen）封锁。当新操作发起时，旧操作即使先于当前操作超时或晚于当前操作到达，也会在代次比对后直接丢弃其副作用，绝不回写错误、绝不抹除 loading、绝不清除他人新错误。
- **写成功与读失败正交**：`syncNow` / `login` / `register` / `resolveConflict` / `importerCommit` / 端口转发各 mutation 在后端提交成功后，即使随后的 `loadConfig`、`loadConflicts`、`loadSnippets`、`loadAll` 或 `loadRules` 失败，主业务数据与成功状态均不回滚，而是精准捕获到 `refreshError`，并向用户提供只读重试按钮。重试仅执行读操作，绝不重复发起写 mutation。
- **防止未处理 Rejection**：组件挂载阶段所有的 fire-and-forget 读取一律使用 `void Promise.resolve(...).catch(...)` 消费 Promise 拒绝，并在 store 或 state 中保留友好错误信息供 UI 展示，兼顾无崩溃与可重试。
自测结果（命令/退出码，证据保存在 `audit/remediation-task8/gemini/`）：
| 命令（工作目录） | 退出码 | 结果 |
|---|---:|---|
| `git branch --show-current` / `git rev-parse HEAD` / `git status --short`（根） | 0 | 基线 SHA 一致，他人增量保留，无暂存 |
| 红测 1：`pnpm --prefix frontend exec vitest run src/stores/snippetStore.test.ts` | **1** | `loadSnippets` 乱序覆盖，`snip_A` 错误覆盖 `snip_B` |
| 红测 2：`pnpm --prefix frontend exec vitest run src/stores/syncStore.test.ts` | **1** | `syncing` 提前置 false 导致可重入；`conflict_count > 0` 失败被吞未进 `refreshError` |
| 红测 3：`pnpm --prefix frontend exec vitest run src/stores/forwardStore.test.ts` | **1** | 慢刷新 A 清除 B 错误；慢状态 A 覆盖 B 状态 |
| 红测 4：`pnpm --prefix frontend exec vitest run src/components/SyncSettingsModal.test.tsx` | **1** | 挂载缺少只读重试按钮且无拒绝防护 |
| 红测 5：`pnpm --prefix frontend exec vitest run src/components/ImportExportModal.test.tsx` | **1** | `handleRefreshAfterCommit` 跨 tab 写入 `refreshError` |
| 最终绿测：`pnpm --prefix frontend exec vitest run src/components/ImportExportModal.test.tsx src/components/SyncSettingsModal.test.tsx src/components/SnippetBar.test.tsx src/components/PortForwardModal.test.tsx src/stores/snippetStore.test.ts src/stores/syncStore.test.ts src/stores/forwardStore.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose` | 0 | 7 文件 / 75 测试全部通过（0 失败） |
| `pnpm --prefix frontend exec eslint <本人负责的 12 个文件>` | 0 | 0 errors / 0 warnings |
| `pnpm --prefix frontend exec tsc --noEmit` | 1 | 本人 12 个文件 0 错误（唯一 2 处既有错误在他人 `serialStore.test.ts`，按互斥原则未动） |
| `git diff --check -- <本人负责的 12 个文件>` | 0 | 无空白与换行格式错误 |
验证范围：
- R01: `syncNow` / `login` / `register` 在配置及视图刷新全程保持 `syncing: true`，防重入守卫有效拦截重复同步；旧 flow 晚 resolve/reject 不清除新 flow 忙状态与错误。
- R02: `snippetStore`、`syncStore`（config & conflicts）真实 IPC 乱序注入回归，慢请求晚 resolve/reject 均安全丢弃；`SnippetBar` 增删失败使用真实 store 与 IPC 错误边界。
- R03: `loadConfig` 自动同步并等待冲突列表加载，错误必达 `refreshError`；`SyncSettingsModal` 挂载无未处理拒绝，`error` 呈现只读重试按钮且调用 `retryRefreshViews`。
- R04: `ImportExportModal` 刷新重试代次保护，切 tab/策略或预览 B 后 A 的晚决议不写 B；Commit A 决议中 Preview B pending 时维持 loading 与 token 归属。
- R05: `ImportExportModal` 补全 JSON 与 osvault arrayBuffer 切 tab 晚 reject、卸载晚 resolve / 晚 reject 全矩阵。
- R06: `forwardStore` 刷新与状态读取代次保护，慢刷新不冲掉新错误，慢状态不覆盖新状态；重试只执行读取 IPC，严格维持原有 scope。
未验证部分：
- 真实远程网络同步服务端、真实物理串口硬件、Windows CredUI 系统原生凭据弹窗、真实 RDP 会话：按 main.md 交 CEO 集中联验。
- 他人负责的 app-core / desktop / serialStore / terminalStore 等模块测试：由各自负责人及 CEO 闭环。
验收对照（逐项）：
- 仅在 gemini2.md 独占白名单内修改；
- 无 placeholder / 实现文案，UI 必填标记仅在为空时出现；
- 无通用取消框架或新增外部依赖；
- 未使用 timeout/skip/allow/吞错制造通过；
- 失败先复现，红绿有严格日志与退出码对照；
- 证据保存于 `audit/remediation-task8/gemini/`；
- 未 add / commit / push / 切分支。
范围外发现（未处理）：
- `serialStore.test.ts` 存在 2 处未使用的 TS 变量警告（`stopSerialSendTimer`、`getSerialStats`）导致全仓 `tsc` 退出 1，属于 trae 独占范围，按互斥原则未作处理。
遗留问题与风险：
- 前端测试在 jsdom 环境运行，真实 Tauri WebView2 的 IPC 并发乱序与取消机制由主进程控制，仍依赖全量集成验证。
需要决策者决定的事：
- 三名员工独立自测通过后，由 CEO 统一进行全局构建、Rust workspace 联验与分批推送。
可独立提交组与依赖：
- **组 C2（前端流程与异步归属）**：`snippetStore.ts/.test.ts`、`syncStore.ts/.test.ts`、`forwardStore.ts/.test.ts`、`ImportExportModal.tsx/.test.tsx`、`SyncSettingsModal.tsx/.test.tsx`、`SnippetBar.test.tsx`、`PortForwardModal.tsx`。
- 依赖关系：属于前端纯逻辑与 UI 容错层，依赖已验收的 Rust IPC 契约；可与 sessionStore/vaultStore 独立批次组合发布。

## 员工3：trae
【回执 | 员工:trae | Task 8】
状态：完成，等待 CEO 集中联验（本人未 add / commit / push / 切分支，未整支推送、未宣告上线）。
开工核对：分支 `Fce/task8-integration`、完整 HEAD `d7bbd25c6c3f296f82e4514d3037601921da8fd3`、`git status --short --branch` 干净；收尾时分支与 HEAD 未变，工作区另有员工1/2 的并行白名单增量，按 BASELINE.md 第 9 条原样保留、未触碰。
改动清单：仅本人白名单 6 个文件（均未提交）——`frontend/src/stores/serialStore.ts`、`frontend/src/stores/terminalStore.ts`、`frontend/src/stores/serialStore.test.ts`（+5 用例）、`frontend/src/stores/terminalStore.test.ts`（+4 用例）、`frontend/src/components/TerminalHost.test.tsx`（新建，+1 用例）、`frontend/src/components/TerminalTabs.test.tsx`（新建，+3 用例）。`SerialSendBar.tsx` / `TerminalTabs.tsx` / `TerminalHost.tsx` / `XtermView.tsx` / `RdpSessionView.tsx` 只读核对未改；`commands.rs`、`sessionStore` / `vaultStore`、IPC/types、依赖锁、scripts、员工1/2 文件一律未改。未 reset / restore 旧树、未套旧 patch、未 stash pop。
关键实现说明：
1. `closeTab` 在首个 `await pendingTeardown.get(tabId)` 之前静态引入并同步调用 `stopSerialSendTimer(tab.cardId || tab.tabId)` + `expireSerialSendEpoch(...)`；既停 owned timer 又失效代次，修复「只失效 epoch、下一 tick 领取新 epoch 继续写」的 T7-08。
2. `sendCurrent` / `sendSnippet` 在 `await sendSerial` 成功后补 `assertCurrentSerialSendEpoch`；旧 write 晚 resolve 经既有 `failSerialSend` 归一为主动取消，不写 history/stats/sendError、不停 timer；当前连接真实失败仍报错（既有 R06 用例保持）。
3. 新增 `timerOwnedBy(timerCardId, cardId?)`；`stopTimer(cardId?)` / `stopSerialSendTimer(cardId?)` 按归属停止，`failSerialSend` 复用同一 helper（语义不变）。`teardownSerialSession`、`markDisconnected`、`reconnectTab`、`closeTab` 全部传 `tab.cardId || tab.tabId`；`SerialSendBar.tsx:222` 用户显式 `stopTimer()` 无参保持全局停止原意。已核对全部停止调用点（修复后实测行号）：`serialStore.ts:98`(failSerialSend 归属判定)、`429`(stopSerialSendTimer→stopTimer)、`439`(teardownSerialSession)、`terminalStore.ts:858`(reconnectTab)、`1065`(markDisconnected)、`1171`(closeTab)、`SerialSendBar.tsx:222`(用户显式无参全局停止)。
4. `history` 从 await 前解构的旧快照改为 `set((s) => …)` 读完成时最新状态合并，保留去重与 `slice(0, 50)`；`fetchStats` 仅在当代次成功分支触发。既有换行规则、选中集、广播入口快照未动。
5. 新建 `TerminalTabs.test.tsx`（createRoot/act 真实渲染）：告警条 title/aria-label 含 launch_id、重试再次失败仍保留同一 launch_id 且可再点、重试成功告警消失；T8-13 经真实 `closeTab`→`rdpClose` 失败产生记录再重试，不是只注入 store 状态。
自测结果（命令/退出码）：工作目录 `E:\projects\openshell\frontend`，除注明外；证据在 `audit/remediation-task8/trae/`，`.log` + `.exitcode` 成对。
- 红测（源码未改）：`pnpm exec vitest run src/stores/serialStore.test.ts src/stores/terminalStore.test.ts src/components/TerminalHost.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` → **退出 1**，3 文件 / 9 failed / 48 passed。9 项全部指向真实根因：T8-1 关闭 pending 期间 `sendSerial` 被调 4 次；T8-2/3 旧写入晚完成记为 success 并覆盖 history / 刷新 stats；T8-4 并发最终 history 丢 B；T8-5/6/7/8 生命周期入口误停 B timer；T8-9 真实 `TerminalHost` 链后 B timer 为 false（`t8-red.log`）。
- 绿测（修复后）：`pnpm exec vitest run src/stores/serialStore.test.ts src/stores/terminalStore.test.ts src/components/TerminalHost.test.tsx src/components/TerminalTabs.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` → **退出 0**，4 文件 / 61 passed / 0 failed（`t8-green.log`）。先红后绿 9 项；T8-10/11/12/13 为修复后补的组件证据与归属契约断言（验证既有正常行为，非本轮失败点）。
- 调用者联验：`pnpm exec vitest run src/lib/terminal-actions.test.ts src/stores/monitorStore.test.ts src/components/ServerSidebar.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` → **退出 0**，3 文件 / 17 passed（`callers-targeted.log`）。
- 同白名单回归：`pnpm exec vitest run src/components/XtermView.test.tsx --reporter=dot --maxWorkers=1 --minWorkers=1` → **退出 0**，9 passed（含 R06，`xterm-targeted.log`）。
- `pnpm exec eslint <本人 6 文件>` → **退出 0**，0 errors / 0 warnings（`eslint-targeted.log` 空）。
- `pnpm exec tsc --noEmit` → **退出 0**，无类型错误（`typecheck.log` 空）。首次 eslint/tsc 各报 1 个 `stopSerialSendTimer` 未使用（红测期导入已用尽），随即补 T8-12 用例实际覆盖该导入，重跑均 0；未删导入、未加 allow/ignore。
- `C:\Users\fiee1\.cargo\bin\cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-desktop --lib rdp_process::tests --locked --offline`（仓库根）→ **退出 0**，4 passed / 0 failed / 0 ignored（`rdp-process-msvc.log`）。helper 未改，仅回归确认。
- `git diff --check -- <本人 4 个已跟踪文件>` → **退出 0**，无空白错误。
未使用 timeout / skip / allow / 删断言 / 吞当前失败制造通过；未并行全仓 test/build。
验证范围：真实 store action 调用链 + `lib/ipc` 边界注入（`sendSerial` / `terminalEncode` / `getSerialStats` / `closeCard` / `rdpClose`），并含 `TerminalHost` 的 `sendError → markDisconnected` 与 `TerminalTabs` 按钮的组件级链路；T8-1 用 fake timer 在 `closeCard` pending 期推进 45ms 并让旧编码 resolve，T8-9 用真实 10ms interval 证明 B 的 timer 在 A 失败后仍继续写入。不是只 mock 顶层 store 动作、不是只测直接 teardown。`commands.rs` 的 `rdp_close` 保留 entry 未做命令层验证，已按要求把最小 hunk 交 CEO。
未验证部分：真实 mstsc / RDP / NLA 成功登录、实体串口与编码回环、外部 SSH/X11、真实旧库图形恢复、真实 Tauri WebView2 IPC 并发、安装/升级、真实 dist 扫描与依赖副本验证；全仓前端单 worker 全量、全量 lint/build、MSVC Rust workspace test/check/clippy/fmt、脚本测试均交 CEO。`rdp_process` helper 4 项只证明 native kill 边界，**不代替**命令注册表 `rdp_close` 失败保留 entry 的验证（Task7 报告遗留）。
验收对照（逐项）：
- 任务书 1：T8-1 红→绿，pending 期间 `sendSerial` 零调用、`isTimerRunning` false、旧编码失效。
- 任务书 2：T8-2/3 红→绿，两入口旧完成作为过时完成（rejected）、history/stats 不被覆盖、不误报新连接失败；当前连接真实失败仍报 sendError 由既有 R06 用例保持。
- 任务书 3：T8-5/6/7/8/9 红→绿，`closeTab` / `teardownSerialSession` / `markDisconnected` / `reconnectTab` / 真实 TerminalHost 链均按 card 停；T8-12 单独断言用户显式无参全局停止原意。
- 任务书 4：T8-4 红→绿，A/B 逆序完成得到 `['A','B']`，去重与长度限制保留。
- 任务书 5：T8-10/11/13 组件证据覆盖失败保留 launch_id、重试成功消失、重试再次失败仍可操作；commands.rs 路由测试只交最小 hunk 提案，本人未改共享入口。
- main.md 第 6 节：冻结边界未改（forward_list/view、密码补录、archive token、rdp close/status/launch_id、sendTextToTab、IPC 签名）；未新增通用取消/事务框架；保留成功提交后全局刷新、写成功不因读失败改判；无新增 placeholder / 实现文案 / 可选后缀。
范围外发现（未处理）：
1. 开工时工作区干净；收尾时 `git status --porcelain` 含员工1/2 的并行增量（`app_services.rs`、`syncStore.ts`、`ImportExportModal.tsx` 等），未读改、未清理。
2. 员工2 回执记录「并行中途 `serialStore.test.ts` 2 处未使用变量致 tsc 退出 1」属不同时间点；本人最终 `tsc --noEmit` 退出 0，该问题已在本人文件内闭环，无遗留类型错误。
3. `git diff --check` 全仓输出 36 个 CRLF/LF warning 均来自员工1/2 改动文件；仅对本人 4 个已跟踪文件检查为 0。
4. `commands.rs:2581-2608` 既有 `shutdown_rdp_launches()` drain 整个进程级 `RDP_LAUNCHES`，与新提案用例并行时可能互相清空；已在提案文件内列明，交 CEO 决策，未自行改共享入口。
5. 全仓 typecheck / lint / build、MSVC workspace 门禁与真实环境验证非本人范围，未跑、未代替。
遗留问题与风险：
- 命令注册表 `rdp_close` 失败保留 entry 的命令层路由测试尚未集成（需 CEO 决定并行隔离方式），当前只有前端组件证据与 native helper 回归，不能据此判定该缺口已关闭。
- `stopTimer` / `stopSerialSendTimer` 增加可选参数，6 处停止调用点与 1 处 failSerialSend 归属判定已逐一核对；无参调用向后兼容，但 CEO 联验时仍建议跑一次全仓前端单 worker 全量与全量 typecheck。
- 三员工 WIP 同处一支，提交前须由 CEO 按独立功能分支分批切分；本回执不代表整支通过。
需要决策者决定的事：
1. 是否集成 `audit/remediation-task8/trae/commands-rs-minimal-hunk.md` 中的 `commands.rs` 最小 `#[tokio::test]`，以及全局 `RDP_LAUNCHES` 的串行化方式（不要靠 skip/allow/ignore 绕过）。
2. 三人完成后的集中联验顺序与分批推送边界；基线含未验收保全，禁止整支推送或宣告上线。
3. 真实 RDP/NLA、实体串口、安装升级仍无环境，是否接受在发布说明中单列未验证。
可独立提交组与依赖：
- 提交组 A（串口生命周期与发送归属）：`serialStore.ts` + `terminalStore.ts` + 对应两个 store 测试，可独立成一支前端功能提交。
- 提交组 B（组件证据，依赖 A 的 store 语义）：`TerminalHost.test.tsx` + `TerminalTabs.test.tsx`。
- 两组均不含 `commands.rs`（CEO 保留）、不含他人文件、不改 IPC/types/DTO 与依赖锁；冻结边界不变。本人未提交、未推送，全部交 CEO 联验后分批推送；真实环境验证与独立评审仍为发布前置依赖。

## CEO 审查记录
待三份回执齐后独立评审。
