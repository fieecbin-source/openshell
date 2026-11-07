# Task9 gemini：同步跨流程竞态证据

工作区：`E:\Projects\openshell`；分支：`codex/task9-closeout`；冻结 HEAD：`7b3007a13c839857f19d89ce931c7d8b273a9eee`。开工工作区干净。已读 Task9 main/gemini2、Task8 BASELINE 和 Task8 gemini 回执。Task9 BASELINE、TASK8_REVIEW 未出现，按主 agent 明确授权继续冻结代码。

只修改 `frontend/src/stores/syncStore.ts/.test.ts` 与 `frontend/src/components/SyncSettingsModal.tsx/.test.tsx`；本报告及命令日志为授权证据目录。没有 add、commit、push、切分支、子 agent、依赖安装；没有改公共 store、IPC/types、backend、样式或共享反馈。由主 agent 集中更新反馈及验证。

## 根因、最小修复与覆盖

1. sync 的 busy 释放曾依赖可被 resolve 改写的 syncFlowGeneration。现在共同 refreshError 仍共享 syncFlowGeneration，syncing / resolvingConflictId / refreshingViews 各自拥有 finally 代次；resolve 的忙状态贯穿必要刷新。sync/login/register/resolve 在 store 互相防重入，真实组件同时禁用同步、认证、冲突选择及刷新按钮。覆盖 sync pending → resolve/login/register 不提交，以及五入口兄弟读取结束后释放。
2. refreshSyncedViews 改用 allSettled 等待已启动 sessionStore.loadAll、vault.checkStatus、snippet.loadSnippets，全部 settle 后才报告失败。五入口均注入 snippet_list 提前 reject、session_list 与 vault_status deferred；断言一个兄弟结束后仍 busy，全部结束后释放，成功 mutation 不 reject、不回滚，retry 是只读失败。真实 session/vault 状态也断言，既有同步成功后全局读取及只读重试用例全部保留。
3. retry、sync、login、register、resolve 统一共同 refreshError 归属；busy 释放独立于错误归属。16 项矩阵覆盖 retry A 与四 mutation B、四 mutation A 与 retry B，以及晚 resolve/reject 双向；旧结果不清除/覆盖新错误，旧 finally 释放自身忙状态。
4. 旧配置成功先检查 configGeneration，再 set config 或派生 loadConflicts；冲突读取额外捕获配置代次，已经派生的旧冲突读取也不能越过新 config 晚写列表/错误。配置 IPC catch 与派生冲突错误分离，configError 不冒充冲突失败；默认 loadConfig 保留非抛错行为，throwOnError 仍传递。初始 configError 在真实组件显示，配置按钮只重读配置，拒绝被消费。
5. 冲突读取只清除自身写入的错误，且不能覆盖已有无关 mutation 错误。认证退出/清除失效 sync/config/conflict/refresh 与旧 finally；logout 成功立即清除冲突、lastResult、错误并置退出状态，再读取当前配置。clear 复用同一退出生命周期，IPC 仍 sync_logout。旧成功 mutation 继续必要 session/vault/snippet 后台刷新，但不重新读写退出后的同步配置/结果。logout/clear × resolve/reject 四组真实混合 deferred 同时覆盖旧 sync mutation、config、conflict 和 retry；组件两组覆盖退出后旧同步成功不能回写成功提示。

## 实际命令与退出码

所有测试命令相同（根目录）：

`pnpm --dir frontend exec vitest run src/stores/syncStore.test.ts src/components/SyncSettingsModal.test.tsx --maxWorkers=1 --minWorkers=1`

| 日志 | 退出码 | 实际结果及阶段 |
|---|---:|---|
| red.log / red.exitcode | 1 | 57 项：30 failed / 27 passed；生产未改。store 27 个行为红测，UI 初始配置与同步时冲突按钮两项行为红测；另一个 UI sync 计数失败是测试把命令写成 sync_sync，已纠正成 sync_now，不作为生产缺陷证据。|
| intermediate-red.log / intermediate-red.exitcode | 1 | 59 项：4 failed / 55 passed。store 第一轮修复通过；UI configError、冲突禁用、logout/clear 后旧反馈四项仍红。|
| green.log / green.exitcode | 0 | 59 / 59。UI 修复后第一轮绿测。|
| derived-red.log / derived-red.exitcode | 1 | 62 项：2 failed / 60 passed。新补 config A 已经派生 conflict pending → 新 config B → 旧 conflict resolve/reject，分别错误写旧列表/旧错误。|
| final-green.log / final-green.exitcode | 0 | 62 / 62；store 49、组件 13，无 skipped、无 Vitest unhandled rejection 报告。|

`pnpm --dir frontend exec eslint src/stores/syncStore.ts src/stores/syncStore.test.ts src/components/SyncSettingsModal.tsx src/components/SyncSettingsModal.test.tsx`：`eslint.log` 与 `final-eslint.log` 均退出 0，0 errors / 0 warnings。

`git diff --check -- frontend/src/stores/syncStore.ts frontend/src/stores/syncStore.test.ts frontend/src/components/SyncSettingsModal.tsx frontend/src/components/SyncSettingsModal.test.tsx`：退出 0，无输出。

日志中的 console.warn/error 是故意注入的读取失败及生产现有记录，未抑制日志、未吞当前 throwOnError 拒绝、未增 timeout/skip/allow。

## 原组件测试意图与断言映射

基线组件使用 mock 顶层 store 动作，现改为真实 store + 底层 Tauri invoke；不以减少断言获得通过。原 8 个用例意图逐项对应：

| 基线意图 | 现有真实边界覆盖 |
|---|---|
| 默认 server/username/password 全空、密码 autocomplete | starts with empty fields：全部输入空、autocomplete=new-password，保留全部断言。|
| 密码关闭/重开消失 | 同一隐私用例通过真实 setModalOpen：输入值实际写入，再关闭/重开清空。|
| 登录失败仍清密码 | clears entered password：真实 sync_login reject；命令一次、密码空、真实 error 渲染。|
| 冲突列表、本地与远端选择及成功反馈 | 两项参数用例：标题、record 内容、两按钮存在、真实 IPC conflictId/choice、实际列表刷新、两种成功文案均断言。另补真实 mutation failure：冲突保留、busy 释放、错误文案及按钮可再操作。|
| resolve 成功/刷新失败、只读重试、不重复 resolve | mutation success 参数 resolve：真实 resolve 写成功、snippet 读失败、warning 标题、只读 retry，refreshError 清空、resolve IPC 仍一次。|
| sync 成功/刷新失败、不显示同步失败、只读重试、不重复 sync | 同组参数 sync：保留 warning、无同步失败、retry、命令仍一次；手工命令字面为 sync_now。|
| login 成功/刷新失败、不显示登录失败 | 同组参数 login：真实登录、配置变化、读失败 warning、无登录失败，再增加只读 retry 与 login IPC 不重复。|
| mount loadConflicts reject 被消费、错误显示与只读重试 | consumes initial conflict rejection：真实 loadConflicts reject；window unhandledrejection spy、错误渲染、只读 retry 清自身错误，无 resolve/sync 写入。Vitest 无 unhandled rejection。|

原 store 测试全部保留，仅完整重置新增已有状态以避免用例间遗留。新覆盖不是对 mock 顶层动作的证明：deferred 注入 invoke，观察真实 Zustand 状态与真实渲染。

## 发布依赖、范围外提案与未验证

这四文件改动依赖冻结基线已有 throwOnError 读取契约；未修改 IPC 参数或状态接口，未新增通用取消/事务框架。

**范围外最小提案（已直接告知主 agent）**：`sessionStore.loadAll` 自身内部仍 `Promise.all(session_list, group_list)`。本线的 allSettled 能等待三个公开 store 读取动作，但 session_list 提前失败时，group_list 可能在 loadAll 已 reject 后继续 pending。严格要求所有嵌套必需 IPC settle 时，应由 CEO 在共享 sessionStore 内最小改成 allSettled 并补真实 sibling deferred；本人未越界编辑。这里不宣称此内部组合读取缺口已关闭。

没有运行全量 Vitest、typecheck、Cargo、build，按授权由主 agent 集中执行。真实登录、注册、远程同步服务端、Tauri WebView2 实时 IPC、真实账户退出/清除、凭据/用户数据库均未实测；所有账户与地址为 .invalid 隔离 fixture。真实 RDP/NLA、实体串口、外部 X11/agent、CredUI、非 Windows、安装升级仍未验证。

## 独立复审修复（追加）

主 agent 在独立复审下发三个缺口；仅在原四文件范围继续，实际追加修改为组件与其测试。没有改 sessionStore；主 agent 明确通知共享 sessionStore 内部 allSettled 已由 CEO 修复，前文范围外提案是首轮时点记录，最终共享验证以 CEO 证据为准。

1. **P2 配置重试永久 busy**：configRetrying 的 finally 原先比较公共 feedbackGeneration。真实配置重试 pending 期间，提交登录/检查更新会提升公共代次，旧配置读取 resolve/reject 后不能释放重试 loading。现有 configRetryGeneration 独立持有请求 finally；新 sync/resolve/refresh 或弹窗/认证生命周期失效时同步释放旧配置重试归属。检查更新仅改变反馈，不改变配置 busy 归属；配置读取完成后正常释放。四项真实按钮 + invoke deferred 矩阵覆盖 login/update × resolve/reject，断言 login 换代立即释放过期配置 busy、update pending 期间仍保持配置 busy、settle 后错误可见且按钮可再点击，只读请求成功且不重复登录/同步。
2. **P2 登录秘密因反馈换代未清除**：登录 mutation 成功先显示登录状态、全局刷新 pending，旧 password 仍留在组件 state；logout/update 提升反馈代次后旧 finally 不清秘密，退出重新出现原密码。密码现在单独使用 passwordGeneration；认证进入/退出及弹窗生命周期清空密码，真实退出/清除控件点击立即清空；认证 finally 只清本轮密码输入，与公共成功提示无关。新密码输入提升自身代次，旧 finally 不会擦掉退出后新输入。两个真实登录 + snippet deferred 路径覆盖刷新中退出，以及检查更新换代后完成刷新再退出；都断言空密码、一次登录/退出，并保留新输入。
3. **P3 清除晚完成反馈污染重开弹窗**：clear 完成原先只检查 modalOpen，close/reopen 后旧成功会写新弹窗。现在 clear 领取公共反馈操作代次，只有当前归属可写提示；记录其拥有的 logout 认证转换，正常清除不因自身转换被误失效，而 modal 变化/新操作始终失效。真实 clear + sync_logout deferred → close 控件 → setModalOpen 重开 → 旧 resolve 验证无旧成功提示；原正常清除用例另加成功提示断言，避免把全部 clear 反馈吞掉制造通过。

所有追加测试仍使用真实 store 和底层 invoke；原初始配置只读重试、密码关闭/重开及登录失败清理断言保留。手工追踪共用反馈 helper 的 auth、sync、resolve、retry、checkUpdate、clear 调用点：反馈由 feedbackGeneration 拥有；配置 busy、秘密清理各有独立归属；clear 仅保留自己当前 logout 转换，其他 UI 换代仍失效。卸载时通过稳定 ref 对象失效三个归属，避免晚完成写卸载组件。

追加实际命令仍为上文白名单 Vitest 双文件单 worker：

| 日志 | 退出码 | 实际结果 |
|---|---:|---|
| review-config-red.log / .exitcode | 1 | 66 项：4 failed / 62 passed；四个真实 config busy 矩阵全部红。|
| review-config-green.log / .exitcode | 0 | 66 / 66。|
| review-secret-red.log / .exitcode | 1 | 68 项：2 failed / 66 passed；真实退出后旧密码两路径均红。|
| review-lifecycle-red.log / .exitcode | 1 | 69 项：3 failed / 66 passed；两个密码红测及 clear close/reopen 红测。|
| review-final-green.log / .exitcode | 0 | **69 / 69（store 49、组件 20）**；当前失败/只读重试/旧 finally 保护全部通过，无 skipped 与未处理拒绝。|
| review-final-eslint.log / .exitcode | 0 | 四文件限定 ESLint：最终 0 errors / 0 warnings。首次清理 ref 语法产生 3 个 hook 警告，改为捕获稳定 ref 对象后消除；无禁用规则。|
| review-diff.exitcode | 0 | 四文件 diff --check 无输出。|

未增加 timeout/skip/allow、未删既有断言、未改变 IPC 或 store 状态接口。真实服务端登录/同步、全量 Vitest/typecheck/build/Cargo 仍由 CEO 集中验证；本追加不产生新的共享文件发布依赖。
