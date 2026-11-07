# Task 4 统一任务书：26 项问题与 4 项质量问题修复

- 任务编号：Task 4
- 状态：任务已建立，待用户分别下发；尚未收到员工修复回执
- 发布者：项目 CEO（本聊天）
- 花名册：员工1 gpt；员工2 gemini；员工3 trae。用户于 2026-11-06 确认。
- 返工自：Task 1–3 的实现，经 2026-11-05/06 验收发现的问题。
- 难度：L2，按互斥文件所有权并行；仅对本文件已锁定的接口并行开发。若证据要求改变锁定契约，暂停受影响部分，交 CEO 审查后另建 L3 后续任务；其他独立项继续。
- 流程来源：https://github.com/chengzhaobing/any-skills/blob/main/skills/multi-agent.md

## 一、背景与证据基线

OpenShell 位于 `E:\projects\openshell`，使用 Rust Workspace、Tauri 2、React、TypeScript、Zustand 和 xterm。Cargo 工作区入口在仓库根目录 `Cargo.toml`，不是 `backend/Cargo.toml`。Windows Rust 命令使用 `C:\Users\fiee1\.cargo\bin\cargo.exe` 和 `+stable-x86_64-pc-windows-msvc`。

2026-11-06 派工时分支为 `Fce/terminal-workspace-ux`，HEAD 为 `1f746c27b3b189072719f49d6284f1452187633d`。工作区有大量已有未提交改动与未跟踪文件，包括后端和前端；不得 reset、checkout 覆盖、stash 他人修改或整树格式化。每位员工开工时记录自己白名单的原始 diff，区分已有内容与本轮增量。

问题报告基于旧快照 `3c17ab1d852bc3991687c7f9dfed1720d2a26dee`，行号仅作为导航，必须核对现有调用链。历史“全部通过”不代替本轮验证。BUG-020 已有 connectionGeneration/isCurrent 防护，先回归，避免重复改写。

共同先读：

1. `docs/bug/2026-11-06-BUG_LIST.md`（BUG-001–026、G01–G04 的完整依据）。
2. `docs/bug/2026-11-05-VERIFICATION_REPORT.md`（动态证据与 184 行功能验收边界）。
3. `multi-agent/task1/main.md`、`multi-agent/task2/main.md`、`multi-agent/task3/main.md`；按需读取对应 `Task N Feedback.md` 的相关实现、风险和 CEO 审查部分，复用已有分析。

FinalShell 只读参考：

- 程序和 Jar：`D:\programfile\finallshell\finalshell\`、`finalshell.jar`。
- 配置样例：该目录的 `conn\` 与 `config.json`。只核对结构，不复制真实密码、私钥、主机资料或完整原始配置到日志、代码、回执。
- JDK：`C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\javap.exe`、`java.exe`。
- 用户给出的 ProbeLv 路径少了用户名后的反斜线；已找到实际文件：`C:\Users\fiee1\.gemini\antigravity\brain\6ad813c8-0f62-4276-b3db-d78335de25ea\scratch\ProbeLv.java`。
- 已归档常量：SSH=100、RDP=101；认证=1/2/3；转发 L/R/D=100/200/300。复用 task2 的详细映射，无需重复提取。
- REA 官方来源：https://github.com/morluto/rea 。优先已有记录；不足时仅对相关类做精准分析。当前会话未执行 REA、未确认 REA 可调用，不能写“已通过 REA 验证”。员工记录实际工具版本、命令、类/方法、结论与边界；若工具未装或不可用，说明并使用现有 javap 取证，不自行安装未审查工具、修改全局 MCP 或声称用了不存在的工具。
- 对齐可靠连接、状态机、文件完整性与生命周期等行为；FinalShell 中如有过时密码保护，不照搬为 OpenShell 的安全标准。沿用本项目 Vault/SecretResolver/主机密钥策略。

## 二、总目标与整体验收

修复清单内全部 26 项问题，补齐相关缺失链路，并处理 G01–G04。以真实行为和可重复测试判断，不能通过隐藏入口、返回假成功、吞错或放宽测试冒充完成。

- [ ] 三项阻塞：原生串口失败不进入 Mock；普通 SFTP 覆盖后字节一致；代理及 SOCKS 密码新写入不再明文持久化。
- [ ] 26 项逐项有当前结论、改动位置、回归命令/结果、未验证边界；BUG-020 允许“现有修复回归通过”。
- [ ] 前后端契约、所有调用者、存储、导入导出、同步、重复/编辑路径均一并修复。
- [ ] G01 前端测试恢复；G02 Rust 格式门禁；G03 包扫描保留真阳性检出；G04 主机密钥安全回归可被测试检出。
- [ ] JSON 与加密归档的恢复承诺、凭据处理和缺失依赖有明确且真实的结果，不丢实体后仍报告完整成功。
- [ ] 无现有用户数据损失；有迁移时采用可恢复、可重试路径；无真实秘密进入代码或验收文件。
- [ ] 全部员工完成后 CEO 集中做完整检查和跨模块联调，未执行项目仍标“未验证”。不能据此宣称所有未知漏洞均已发现。

## 三、团队与分流表

| 序号 | 员工 | 职责 | 任务文档 | 是否参与 |
|---|---|---|---|---|
| 1 | gpt | 后端根因修复、安全存储、协议实现、共享契约与后端门禁 | `gpt1.md` | 参与 |
| 2 | gemini | SFTP、代理/隧道、归档/同步、AI 设置和片段前端闭环 | `gemini2.md` | 参与 |
| 3 | trae | 串口、终端编码、RDP、监控/容器与相关前端回归 | `trae3.md` | 参与 |

你是 gpt 就只执行 `multi-agent/task4/gpt1.md`，gemini 只执行 `multi-agent/task4/gemini2.md`，trae 只执行 `multi-agent/task4/trae3.md`。共同阅读本文件，不执行其他员工任务。无法确定自己的身份时停止并向用户说明。

## 四、逐项责任与验收矩阵

表中的“后端”统一由 gpt 负责；“前端”指定唯一员工。每位员工均在自己回执逐项填写，整项关闭由 CEO 决定。

| ID | 目标 | 后端 | 前端 | 必要回归 |
|---|---|---|---|---|
| BUG-001 | 原生串口失败不假成功 | gpt | trae | 不存在/占用端口只调用原生一次，失败后无 Mock、无 connected |
| BUG-002 | 普通 SFTP 正确覆盖 | gpt | gemini | 双向等长异内容、短/长旧目标、空文件，完成后长度及 SHA256 一致 |
| BUG-003 | 串口完整参数重连 | gpt 按需 | trae | 非 COM1、非默认参数首次/重连一致，无端口名默认替代 |
| BUG-004 | 串口单一接收源 | gpt 按需 | trae | ASCII/HEX 来自同一完整字节流，切换/隐藏视图不抢读 |
| BUG-005 | 原生断开传播 | gpt | trae | 读写断开错误到达界面，停止定时发送，自动重连有上限 |
| BUG-006 | 传输运行状态一致 | gpt | gemini | running 时暂停/取消可用，终态不可操作 |
| BUG-007 | 暂停后恢复同一任务 | gpt | gemini | 暂停→恢复→完成，同 task ID；暂停中取消能退出 |
| BUG-008 | X11 真正生效 | gpt | trae | 启用请求和数据代理、关闭不请求；失败反馈，无静默忽略 |
| BUG-009 | 会话编码实际收发 | gpt | trae | GB18030 中文双向、跨块字符、UTF-8 对照、HEX 原字节不变 |
| BUG-010 | RDP 真实状态与释放 | gpt | trae | 启动≠连接；不可达/认证拒绝/成功/退出/关标签有正确状态 |
| BUG-011 | 密码只存安全引用 | gpt | gemini；trae 处理 SessionModal 隧道入口 | 隔离随机密码扫描 DB/WAL/缓存/新备份/导出，迁移与锁库失败不丢凭据 |
| BUG-012 | SOCKS 枚举一致 | gpt | gemini；trae 处理 SessionModal | userpass 创建/编辑/回读，错误认证被拒绝 |
| BUG-013 | SOCKS 建连后才成功 | gpt | gemini 按需 | 被拒目标返回非零 REP，成功目标真实往返 |
| BUG-014 | 监听随 SSH 生命周期 | gpt | gemini；trae 保证断连事件衔接 | 主动/被动断连释放端口并更正状态，不影响其他连接 |
| BUG-015 | 完整归档恢复 | gpt | gemini | 新 profile 两格式恢复，比较实体、引用、加密凭据及回滚；无悬空 FK |
| BUG-016 | OpenSSH 配置不静默丢失 | gpt | gemini | IdentityFile/ProxyJump/L/R/D 生效或预览明确阻断/待补录；无假成功 |
| BUG-017 | 批内重复遵循策略 | gpt | gemini | skip/overwrite/keep_both 同批与已有项均正确 |
| BUG-018 | 同步冲突可解决 | gpt | gemini | 列表、保留本地/远端、失败保留快照、解决后二次修改可上传 |
| BUG-019 | 监控无数据不装实时零 | gpt | trae | 非零退出、空/缺失采样、陈旧数据、恢复采样均有正确展示 |
| BUG-020 | 容器结果和操作绑定连接 | 无预设后端修改 | trae | A迟到/B先到、切换/断开、操作归属；先测试已有防护 |
| BUG-021 | AI 流异常不验证成功 | gpt | gemini | 空200、HTML、错误SSE、中断、正常完成；失败不写 verified_at |
| BUG-022 | AI 超时涵盖响应体 | gpt | gemini | 先回头后悬挂 body，整体15秒有界，界面解除 testing |
| BUG-023 | 保留数量实际生效 | gpt | gemini | 统一键，设置20生成超过5份仍按20保留；启动/迁移路径一致 |
| BUG-024 | 备份失败明确反馈 | gpt 按需 | gemini | backend reject→store reject→UI错误；成功只绑定真实新快照 |
| BUG-025 | SSH Agent 真实认证 | gpt | trae | 一次性 Agent 公钥认证、无 Agent/拒签失败，区别 Agent 转发 |
| BUG-026 | 片段正文和枚举闭环 | gpt | gemini | 创建→回读→编辑→变量展开→插入/执行均保留正文 |
| G01 | 原有前端失败修复 | — | 各自白名单，HomeHub/SessionModal 属 trae | 不删断言、不加 skip、不单纯扩大超时；CEO 全量复跑 |
| G02 | Rust 格式门禁 | gpt | — | 限定后端格式差异，禁止全仓业务重构 |
| G03 | 包扫描误报修复 | gpt | trae 提供 Telnet 合成样例 | 合法提示通过，真实秘密合成样例仍失败，不删除扫描规则 |
| G04 | 主机密钥回归检测 | gpt | — | strict未知/变更、accept_new变更拒绝；隔离副本 Trust 注入被测试检出 |

## 五、互斥文件所有权

本表为修改白名单；相应同目录测试文件归源码负责人。其他文件只读。新增文件只能位于所属模块，且直接服务本次问题。需要扩大范围先回执，由 CEO 在后续任务处理。

| 文件/模块 | 唯一负责人 | 备注 |
|---|---|---|
| `backend/**`、根 `Cargo.toml` / `Cargo.lock` | gpt | 含 commands.rs、路由注册、core-domain、Vault、导入、同步、序列化测试；依赖改动须说明必要性 |
| `frontend/src/types/ipc.ts`、`frontend/src/lib/ipc.ts`、`frontend/src/lib/ai/aiIpc.ts` 及这些共享契约的测试 | gpt | 不允许另两人直接 invoke 绕过包装或用 any 掩盖契约错误 |
| `scripts/check-package.mjs` 及其新增独立测试 | gpt | 不改 unrelated 发布脚本；保持生产秘密检测 |
| `frontend/src/components/SftpView.tsx`、`TransferQueueDrawer.tsx`、`RemoteEditorModal.tsx`；`frontend/src/stores/sftpStore.ts` | gemini | 普通覆盖、传输状态、暂停恢复 |
| `frontend/src/components/ProxyManagerModal.tsx`、`PortForwardModal.tsx`；`frontend/src/stores/forwardStore.ts` | gemini | 密码表单只驻内存，编辑不回显解密密码 |
| `frontend/src/components/ImportExportModal.tsx`、`SyncSettingsModal.tsx`、`SyncStatusWidget.tsx`；`frontend/src/stores/syncStore.ts`、`frontend/src/lib/useAutoSync.ts` | gemini | 导入确认/冲突、同步冲突解决 |
| `frontend/src/components/SnippetBar.tsx`；`frontend/src/stores/snippetStore.ts` | gemini | 正文和变量展开；若调用发送链需编码则交 trae 处理共享发送函数 |
| `frontend/src/components/settings/ai/**`；`frontend/src/stores/aiSettingsStore.ts`；`frontend/src/updater/**` | gemini | AI失败状态、备份保留/手动备份 |
| `frontend/src/stores/terminalStore.ts`、`serialStore.ts`、`monitorStore.ts`、`containerStore.ts`、`cardStore.ts` | trae | 生命周期、编码、单接收源、陈旧结果 |
| `frontend/src/components/TerminalHost.tsx`、`XtermView.tsx`、`HexDumpView.tsx`、`SerialSendBar.tsx`、`RdpSessionView.tsx`、`TerminalTabs.tsx` | trae | 终端与协议显示 |
| `frontend/src/components/MonitorDashboard.tsx`、`ContainerWorkspace.tsx`、`ServerSidebar.tsx`、`ConnectionDetailsPopover.tsx`、`DisconnectedBackdrop.tsx` | trae | 实时状态和归属 |
| `frontend/src/components/SessionModal.tsx`、`ConnectAuthModal.tsx`、`HomeHub.tsx`、`AppLayout.tsx`、`CommandInputBar.tsx`、`MultiExecBar.tsx`；`frontend/src/lib/terminal-actions.ts` | trae | Agent/X11/编码/内嵌隧道调用者、G01 |
| `frontend/package.json`、`pnpm-lock.yaml`、全局样式、UI公共组件、其他未列出的前端文件 | CEO 保留 | 不为短代码新增依赖；如确需修改先提必要性和最小 diff |
| `docs/bug/2026-11-06-REMEDIATION_REPORT.md`、本任务 main/个人任务/CEO审查小节 | CEO | 保留旧验收快照，不改成“已通过” |
| `audit/remediation-task4/gpt/**`、`gemini/**`、`trae/**` | 各自子目录负责人 | 复用旧脚本时复制到自己的新目录，不修改旧证据 |
| `Task 4 Feedback.md` | 各自小节负责人 | 仅局部 patch，不以整文件覆盖更新 |

自检结论：产品源码白名单互斥；两个最易冲突点 SessionModal 和共享 IPC 已分别指定 trae、gpt；共有 Feedback 按小节更新。未锁定的接口变化不能视为已获并行授权。

## 六、已锁定的跨端行为与接口契约

以下是实施目标，不表示当前代码已具备。gpt 负责实际补齐 Rust、注册、TypeScript 及序列化测试；前端员工按本节开发定向测试，生产联调等待真实后端，不能用 Mock 代替验收。

1. **现有线值以真实 Rust serde 为准**：TransferState 使用 `queued | running | paused | completed | failed | cancelled`；SocksAuth 使用 `none | userpass`；SnippetKind 使用 `snippet | macro`，正文 `body: string | null`，输入 `body?: string | null`；SendMode 保持 `insert | execute`。同步改完调用者，不更改数据库含义。确需读取旧前端别名，只在一个边界做兼容，不双写；新写入统一标准值。
2. **传输**：现有 `sftpStartTransfer` 的 `resume` 默认改为 `false`，后端缺省同样为 false。普通新任务覆盖；继续原暂停任务使用新 `sftpResumeTransfer(taskId): Promise<void>`，IPC `sftp_resume_transfer` 参数 `{ taskId }`，不是再开一个 resume=true 新任务。旧 resume=true 请求不得仅凭长度续传；需验证同一任务/文件身份，不满足则明确拒绝或安全重新覆盖。
3. **代理秘密**：持久化与列表返回的 ProxyServerConfig 不含明文 `password`；增加 `password_ref?: string | null` 和 `has_password?: boolean`。`proxyListSave` 接受独立输入 DTO `ProxyServerInput`（元数据 + 可选临时 `password` + `clear_password?: boolean`），返回脱敏列表。省略或空密码保留现有密码；显式 clear_password 才清除；非空值经 Vault 写入。相同语义适用于 `proxyTest` 的临时输入，不把测试密码写入设置。代理 UI 不缓存密码，清理旧密码缓存；旧明文迁移成功后才能删除旧值，不在锁库时静默丢弃。
4. **动态 SOCKS 秘密**：持久化 `socks_password_ref` 真正引用 Vault 秘密，运行前解析；输入新增 `socks_password?: string | null`、`socks_clear_password?: boolean`，返回元数据增加 `has_socks_password?: boolean`。省略/空值保留，显式清除才移除。前端不能再把原始密码塞进 ref；后端拒绝把任意 ref 文本当密码。SessionModal 与 PortForwardModal 两个入口执行同一契约。迁移/导入/同步的安全处理归 gpt。
5. **同步冲突**：新增 `syncListConflicts(): Promise<SyncConflict[]>` / `sync_list_conflicts`；SyncConflict 只含 `{ id, record_id, record_type, created_at, has_local_snapshot }` 元数据。`syncResolveConflict(conflictId, choice): Promise<void>` / `sync_resolve_conflict`，参数 `{ conflictId, choice: "local" | "remote" }`，意为恢复冲突发生时的本地副本/采纳远端。恢复、引用校验、dirty/revision 与 resolved_at 更新必须原子；失败保留副本与未解决状态。后续编辑正常上传，不只清零冲突计数。不得向渲染器返回解密秘密快照。
6. **备份**：保留数唯一新写入键为 `user/update.backup_keep`，兼容读取已有 `update.backupKeep`，canonical 值优先。首次迁移尚未安全读取旧设置时不得先按默认5删除备份。手动备份失败 Promise 必须 reject，界面错误反馈；成功反馈必须绑定真实生成结果。
7. **归档**：保持既有导出/预览/commit 命令名。增加可选 `archive_token?: string` 到 ImportPreviewReport，`importerCommit(candidates, archiveToken?): Promise<number>`，IPC 增加 `archiveToken` 可选参数；会话候选不携带完整秘密归档。后端持有已校验归档上下文，以 token 关联分组、片段、规则及依赖恢复，commit 时再次验证，成功消费，失败不形成部分恢复。token 仅内存、绑定当前应用/预览、不写日志；UI重预览/关闭释放，需提供 `importerDiscardPreview(archiveToken): Promise<void>` / `importer_discard_preview` 参数 `{ archiveToken }`。普通 OpenSSH/FinalShell 导入无 token 仍可用。JSON 默认不导出解密秘密；加密 .osvault 用于完整秘密恢复。旧 JSON 不含凭据时清理悬空引用并在预览 warnings 明示补录，不能伪称凭据已恢复。需要实质改变归档格式时先提交兼容方案，不静默破坏旧包。
8. **RDP**：`RdpLaunchResult` 增加 `launch_id: string`，不同启动实例独立标识；新 `rdpGetStatus(launchId): Promise<RdpRuntimeStatus>` / `rdp_get_status`，`rdpClose(launchId): Promise<void>` / `rdp_close`，IPC 参数 `{ launchId }`。状态为 `{ launch_id, session_id, state: "starting" | "launched" | "connected" | "disconnected" | "failed" | "closed", error: string | null, exit_code: number | null }`。TabStatus 增加 `launched`，仅真实认证/连接证据可置 connected 与记成功；进程存活或TCP端口开放都不是该证据。gpt 若经取证确认 mstsc 无法提供可靠连接结果，提交替代实现方案和限制交 CEO 决策，不拿监视进程冒充整项完成。
9. **串口**：沿用 `openSerial/readSerial/sendSerial/closeSerial`。生产调用不传 useMock=true；readSerial 遇设备失败必须 reject，不能伪造空数组；空闲无数据仍可返回空数组。前端每 card 单接收源向 ASCII/HEX 分发原始字节，错误处理汇入既有断线/重连路径。关闭清理订阅和发送定时器。
10. **编码**：保留 UTF-8 快速路径和 HEX 原字节。非UTF-8发送新增 `terminalEncode(text, encoding): Promise<number[]>` / `terminal_encode`，IPC `{ text, encoding }`，编码不支持或无法表示输入须明确失败，禁止无声 UTF-8 回退/替换字符。收端按会话编码使用流式解码（含跨块字符），控制序列保留；新工具仅在项目已有能力不足时使用，不引入通用转码框架。所有前端发送入口复用同一最小编码路径。
11. **监控**：现有 monitorGetLatest 签名保持。无有效采样返回 null；最近采集失败返回结构化 IPC 错误，不能把旧快照更新时间改成现在。可选追加 `unavailable_fields?: string[]`，用现有 HostMetrics 键名标注缺失字段；前端对应显示不可用而非零。历史曲线可以保留，但必须展示陈旧/失败状态。不得通过降低整台主机所有字段为零来吞解析错误。
12. **AI**：保持 ProviderTestResult 契约；只有有效模型响应且正常结束才 ok=true、写 verified_at。空/错误/提前EOF/取消均失败；超时涵盖 headers+body+解析，总期限15秒，并清理任务/前端 testing。不要把远端原始报文或密钥写到用户错误。

不能满足锁定契约时只暂停该部分，立即在回执说明；不得各写一套不同接口、事后靠 any 对齐。

## 七、执行与验证边界

1. 先核对调用链和现状，再写最小能重现的回归测试，再修根因；每个非平凡改动有有效测试。复用已有模块，不添加无关功能、配置或框架。
2. 不提交/推送/发布、不安装系统驱动、不改变用户真实配置与备份，不启停系统服务。测试使用新隔离 profile、合成秘密和回环服务；无环境即记录未验证。
3. UI 遵守用户 AGENTS：无 placeholder、无冗余说明；必填为空时彩色 ★、有效非空隐藏；可选字段无附加“可选”字样；保留无障碍与校验；不新增 Logo/重画品牌 SVG。
4. 并行只跑所负责模块的测试/限定 lint/目标 check，不跑全量测试和全仓构建。共享契约尚未完成导致失败时记录依赖，不能修改其他员工文件或删断言。
5. 各员工证据只写 `audit/remediation-task4/<员工>/`。记录命令、退出码、用例、失败前后结果、运行条件与覆盖边界。旧 audit 文件只读。缺硬件不使用 Mock 声称硬件验收。
6. 回执用局部 patch 仅改自己小节，立即重读确认；含真实问题ID、验证范围和未验证部分。发现白名单外问题只报告。
7. 三份回执到齐后由 CEO 审查真实 diff 和证据，集中执行下列命令。共享契约/锁文件改动必须覆盖全量；失败要修复再复跑，不能把“运行过”写成“通过”。

```powershell
# 在 E:\projects\openshell 根目录执行；逐条检查退出码。
pnpm --dir frontend test
pnpm --dir frontend typecheck
pnpm --dir frontend lint
pnpm --dir frontend build
& 'C:\Users\fiee1\.cargo\bin\cargo.exe' +stable-x86_64-pc-windows-msvc test --workspace --locked --offline --jobs 2
& 'C:\Users\fiee1\.cargo\bin\cargo.exe' +stable-x86_64-pc-windows-msvc check --workspace --locked --offline --jobs 2
& 'C:\Users\fiee1\.cargo\bin\cargo.exe' +stable-x86_64-pc-windows-msvc clippy --workspace --all-targets --locked --offline --jobs 2 -- -D warnings
& 'C:\Users\fiee1\.cargo\bin\cargo.exe' +stable-x86_64-pc-windows-msvc fmt --all -- --check
node --test scripts/release.test.mjs scripts/updater-sign.test.mjs scripts/check-package.test.mjs
python scripts/test-release-archives.py
node scripts/version.mjs --check
# 包检查先读 scripts/check-package.mjs 的参数，仅扫描隔离测试配置和真实产物，不读用户真实秘密。
```

跨模块补测：普通/暂停恢复 SFTP SHA256、代理和 SOCKS 错认证/监听释放、两个新profile归档恢复、双设备冲突后再上传、AI异常HTTP与悬挂体、RDP实际桌面结果、真实串口/虚拟对收发。硬件、Docker、X Server、Agent 或其他系统缺失时明确列出未验证项及所需条件；本任务不承诺自动具备这些环境。长期稳定性、macOS/Linux、安装升级等报告未覆盖项也不能冒充通过。

## 八、CEO 自留事项

- 维护任务契约、裁决接口变化；另建后续任务，不改已下发个人分工。
- 审查三份回执与真实增量，处理共享接口和调用者遗漏，安排独立交叉复核。
- 全员停止编辑后集中跑全量门禁及可用动态验证，形成 `docs/bug/2026-11-06-REMEDIATION_REPORT.md`；旧两份验收快照保持原样。
- 对不能实际验证或尚未实现的项目保留“未验证/未完成”状态。上线结论须等待三项阻塞和核心验收真正解除，不预先承诺。
