# Task9 独立最终审查

日期：2026-11-07。审查者：独立 reviewer（只读产品代码）。工作区 `E:\Projects\openshell`，执行分支 `codex/task9-closeout`；比较基线 `7b3007a13c839857f19d89ce931c7d8b273a9eee`。

## 初审结论

**存在 4 项真实可达 finding：P1 × 1、P2 × 2、P3 × 1。初审不能据此通过发布。** 下述行号来自初审时工作区；原实现者已收到问题并开始修复，修复完成后的代码和验证应单独复审，不可把本报告当作修复后的通过结论。

审查以实际 `git diff` 和源码为准，未依赖滞后的 `audit/task9-review.diff` 快照。已读 `multi-agent/task9/{main,gpt1,gemini2,trae3,BASELINE}.md`、三线 evidence 和后来生成的 `audit/remediation-task9/ceo-session-refresh.md`。核查了本次 18 个产品/测试变更文件，并追到代理后端整表保存、同步自动入口、相关 store/IPC 与实际弹窗控件。未重做 Task1–8 整仓审计，未运行全量或重复集中门禁，未修改产品代码、提交、推送或启动子 agent。

## Findings

### R1 — P1：迁移与普通写入缺少反向互斥，可覆盖已成功保存的代理

位置：`frontend/src/components/ProxyManagerModal.tsx:159`（loadProxies 入口），`:197-202`（从旧列表构造并提交迁移整表），`:469`（刷新控件）；关联 `:358-369`（删除未占用 saving）。

触发链：首次自动迁移的 `proxyListSave` 遇临时失败，旧缓存按设计保留，加载结束。用户随后普通新建/修改代理，保存仍 pending 时点击现有“刷新代理列表”按钮。`loadProxies` 不检查 `saving`，按钮也未禁用，因而可先读到普通写入之前的旧列表，然后再次发起迁移整表保存。如果普通写入先成功、迁移整表后成功，后者覆盖前者，新代理丢失或刚修改的配置恢复旧值。迁移验证仍能通过并删除缓存，因为它只确认自己的旧列表加候选条目。删除也未设置 saving，可形成同类交叠。

证据：普通保存只在 `loading || saving` 时拒绝，保护方向仅为“迁移先开始”。相反方向的刷新完全可点；`backend/crates/app-core/src/network_secrets.rs:420-450` 读取 old 仅用于绑定已有秘密引用，最终保存传入整表，并不会保留未包含的新代理或较新的配置。这是单个现有组件的竞态，不需要跨窗口或不存在的 CAS 能力。

必须修复：普通保存、删除与迁移使用对称的最小互斥；保存/删除正在执行时，刷新与关闭重开触发的加载不能启动第二个整表写入。补“迁移失败后普通 save/delete pending → 刷新/重开”的 resolve/reject 矩阵，验证实际后端输入与最后列表、不重复写入、失败可重试。

### R2 — P2：配置重试 busy 由公共反馈代次释放，可永久卡住

位置：`frontend/src/components/SyncSettingsModal.tsx:197-204`；关联 `:64`、`:102`、`:167`。

触发链：初始配置读取失败后，用户点击“重试配置”，读取保持 pending，`configRetrying=true`。此状态不计入 `busy`，因此仍可提交登录；已有登录配置时也可点“检查软件更新”。这些操作递增 `feedbackGeneration`。配置重试随后失败，`configError` 保留，但 finally 的 `ownsFeedback(generation)` 为 false，永远不清 `configRetrying`。按钮的 `loading` 会将其禁用，用户无法再次重试配置，除非关闭并重开弹窗。

必须修复：给配置重试自身的 busy/finally 分配独立归属，或者在明确失效时同步释放它，不能由无关反馈操作决定能否释放。用真实配置 invoke deferred 覆盖重试 pending → 登录/检查更新 → 重试 resolve/reject，断言最终按钮可用且当前错误保持正确。

### R3 — P2：登录刷新期间退出，会重新显示原密码

位置：`frontend/src/components/SyncSettingsModal.tsx:120-135`（成功后及 finally 密码清理），`:67-73`（退出订阅未清凭据），`:434-436`（退出控件）；关联 `frontend/src/stores/syncStore.ts:285-286`。

触发链：用户填入密码登录，真实 `sync_login` 成功；`loadConfig` 已把 `is_logged_in` 置为 true，登录表单隐藏，而 session/vault/snippet 刷新仍 pending，所以 `await login()` 尚未返回。用户点击仍可操作的“退出当前账号”。退出递增公共反馈代次，成功后切回登录表单，但没有清空 password state。旧登录最终完成时，成功分支和 finally 都因 `ownsFeedback` 不成立跳过清理，原密码重新出现在登录输入框且继续保留。登录刷新期间先点检查更新也会换代，随后退出可出现同样结果。

这不是后端返回秘密或 localStorage 回填，而是本次对原 unconditional `finally { setPassword("") }` 加入公共反馈条件后产生的内存秘密清理回归。原有“认证失败清密码”测试未覆盖成功登录后的这条时序。

必须修复：密码清理依照认证/退出生命周期，退出立即清空旧凭据；同时保留关闭重开后不误清新输入的归属约束。补真实 login → config logged-in → global refresh deferred → 真实 logout/clear 控件的密码值断言，以及旧 finally 不清新输入的矩阵。

### R4 — P3：清除完成反馈可写入关闭后重开的弹窗

位置：`frontend/src/components/SyncSettingsModal.tsx:416-421`。

触发链：用户发起“清除本地同步数据”后 IPC 或退出后的配置读取保持 pending；随后关闭弹窗并重新打开。旧 handler 完成后仅检查当前 `modalOpen`，因此把旧操作的“本地同步数据已清除”写入新弹窗；当前弹窗已有反馈也会被该旧反馈覆盖。公共订阅虽然在关闭/重开时清空反馈，却未保护这个完成 writer。

必须修复：完成反馈需同时属于发起时的弹窗生命周期和清除操作。不要机械复用会被本次 logout 自身递增的公共反馈代次而吞掉正常清除成功反馈。补真实 close/reopen 后旧 clear resolve，验证新界面不出现旧反馈、正常同一界面清除仍显示成功。

## 已核实的修复与覆盖

- 代理迁移在成功读取后端后才读取旧缓存；无效数据、未知字段、重复 ID、同 ID 冲突与无法证明的秘密引用不会进入保存，原字节保留。保存后读回核验、缓存值比较后删除以及成功提交后只读重试的路径存在；`publicConfig` 剥离临时 password/clear_password，既有 DTO 的 clear_password 保留/显式清除语义仍在。除 R1 的交叠写入外，未再发现本次新增路径直接把秘密回填表单或缓存的问题。
- 同步 busy 释放已从共同 refreshError 代次中分离；同步/认证/冲突写入之间有 store guard，冲突按钮也按共同 busy 禁用。过期 loadConfig 不再派生新的冲突读取；冲突读取同时捕获配置代次；logout/clear 使旧 sync/config/conflict/refresh 回写失效。现有跨入口 late resolve/reject 矩阵直接在 Tauri invoke 注入。
- `refreshSyncedViews` 等待全部三个公开读取动作 settle；CEO 的 `sessionStore.loadAll` 又等待内部 session_list/group_list 两项 settle，保留首个实际拒绝原因和原列表/可选 throwOnError 行为。其新增测试调用真实 IPC 包装器并断言底层 invoke 参数。
- SyncSettingsModal 原有隐私、登录失败、两种冲突选择、成功 mutation 后只读刷新重试和初始冲突读取失败意图，在改为真实 store 的用例中保留。没有发现通过移除原有关键断言规避失败；R2–R4 是尚未覆盖的真实交叠时序。
- ImportExport 新矩阵确实区分 JSON text/加密 arrayBuffer、切 tab/真实关闭控件/unmount、late resolve/reject，并观察 B 文件/loading/token/格式化错误和提交次数；既有提交成功必要全局刷新以及 token 契约未改。
- SnippetBar 新增错误/只读重试与 toast，保留 canonical body/kind 和统一发送路径；PortForwardModal 的最小生产变更仅在新读取 effect 清除旧本地 readError。forward/snippet 的旧完成矩阵观察真实 store 结果、错误、filter 与 finally。上述三线测试多数在 `../lib/ipc` 包装器边界 mock；不能表述成实际 Tauri/WebView/后端执行，但比 mock 顶层 store 动作更深入，且足以覆盖本轮局部状态契约。
- updater 修改只是把原文案移入 UPDATE_COPY；Rust 改动去掉 `Ok(query_row(...)?)` 的冗余包裹，返回值和错误传播保持一致。未发现这两处新增行为问题。

## 验证限制与后续

本审查没有重新执行集中门禁，不能替主负责人宣称全量通过。审查期间已知的 PortForwardModal 测试 DTO 类型问题正在按 ForwardRuleView 补齐；sessionStore 首错修复后的最新定向证据为 15/15，完整集中结果仍需在生产编辑停止后重跑。

真实用户旧缓存、真实锁库/网络代理、多窗口整表同时写入、实际远端账户同步、真实 WebView/归档、RDP/NLA、实体串口、X11/agent、CredUI、macOS/Linux 及安装升级均未在本次审查执行。现有后端整表接口缺少跨窗口 CAS 是已知边界；不得拿该边界解释 R1 的同组件互斥遗漏。

主负责人已收到全部 4 项 finding。修复完成后，应对 R1–R4 的实际修复 diff、红绿证据及必要回归做限定复审，再记录最终是否有剩余 finding。

## 限定复审结论（2026-11-07，原实现者停编后）

**R1、R2、R3、R4 均为 ADDRESSED。本次限定复审没有发现修复 diff 新引入的真实可达必修问题，剩余 must-fix 为 0。** 此结论只关闭上述四项 finding；原初审正文完整保留为历史记录。最终全量 Vitest、typecheck、build 和产物扫描以主负责人本轮集中结果为准。

复审重新读取当前实际生产源码/完整 git diff、两线追加 evidence 和新增测试断言，没有仅据通过数量判定，也没有重跑全量或扩大到历史整仓审计。

| Finding | 状态 | 当前代码及验证依据 |
| --- | --- | --- |
| R1 代理读写反向互斥 | ADDRESSED | `ProxyManagerModal.tsx:165` 在任何读取前检查 activeMutation；普通 save/delete 在同步取得 activeMutation 前检查 activeLoad、migrationJob 和已有写入（`:302`、`:383`）。删除也占有 saving；刷新按钮在保存中禁用，ref 同时覆盖尚未 render disabled 的同一事件轮。cleanup 只失效 UI mutation/load generation，不释放在途写入的实际 owner；`:293-297` 的 owner finally 才释放 busy，在同实例重开时再读取新列表。新增测试 `ProxyManagerModal.test.tsx:620-748` 覆盖 save/delete × resolve/reject 的真实 invoke、同轮重复 submit/delete/refresh、关闭重开、读取先开始后同轮写入；断言实际 payload、保存/读取次数、缓存原值、新表单及 busy。 |
| R2 配置重试永久 busy | ADDRESSED | `SyncSettingsModal.tsx:64` 引入独立 configRetryGeneration，重试 finally 比较该归属（`:227-234`）。同步/冲突/刷新或弹窗/认证换代明确失效并释放旧配置 busy（`:87-91`）；检查更新只改变反馈，不再剥夺配置 finally。测试 `SyncSettingsModal.test.tsx:168-219` 覆盖真实 login/update × late resolve/reject，额外以新的配置失败重新显示按钮，确认未留下隐藏的 spinner，随后只读重试成功且不重复 mutation。 |
| R3 登录退出后旧密码重现 | ADDRESSED | `SyncSettingsModal.tsx:83-85` 在进入认证状态、退出和弹窗生命周期时清密码；退出/清除控件还在发起动作时立即清空（`:450-451`、`:470-472`）。认证 finally 使用独立 passwordGeneration（`:130`、`:161-164`），用户输入也提升自身代次（`:523`），不再依赖公共反馈。测试 `SyncSettingsModal.test.tsx:314-341` 覆盖登录成功但 snippet 刷新 pending 时退出，以及检查更新换代后再退出；真实输入框为空，之后输入的新密码不被旧 finally 清掉，登录/退出 IPC 均仅一次。clear 控件清理路径同时经源码核对。 |
| R4 旧 clear 反馈污染重开弹窗 | ADDRESSED | `SyncSettingsModal.tsx:448-458` 为 clear 捕获反馈 owner，完成时用 ownsFeedback。`:75-81` 只保留当前 clear 自己的认证退出转换；modal close/reopen 始终失效。测试 `SyncSettingsModal.test.tsx:293-312` 通过真实 close 控件、重开和 deferred sync_logout 验证旧成功不回写；`:274-290` 同时断言正常同一弹窗 clear 仍显示成功，未通过吞掉全部成功反馈规避问题。 |

新增修复沿用现有 IPC/输入输出契约。同步 store 和 CEO 的 sessionStore allSettled 修复没有被回退；代理成功写入仍履行脱敏通知，失败仍保留旧缓存，普通通知错误也被区分为已保存后的刷新提示。未发现删除原有关键回归断言、增加 skip/timeout/allow 或把真实 store 行为替换成顶层 mock 来获得通过的变化。

已核对的执行证据：代理 evidence 记录本轮新增 8 项先红，最终新增 10 项后 **45/45**；同步 evidence 记录配置重试 4 项先红、密码 2 项先红和 clear 生命周期先红，最终日志为 **69/69（store 49、组件 20）**；CEO session 独立证据为 **15/15**。这些是实现者的实际定向执行证据，本审查没有冒充另行运行。代理限定 lint 仍有原先的 effect 依赖 warning，未新增禁用规则；不据此宣称全仓 lint 零 warning。

必要限制保持：R1 保证同一组件实例内的读写互斥，不能推导为跨实例/跨进程的后端原子补录或 CAS；成功保存但无法确认的历史缓存仍保守保留，冲突不会自动合并。真实用户数据、远端服务、WebView、外部协议/设备、跨平台与安装升级仍按初审“验证限制”列为未执行。上述限制不重新打开已被修复并验证的 R1–R4，也不替代最终集中门禁。
