# Task8 统一任务书

状态：待下发；返工自Task7独立评审。花名册沿用员工1=gpt、员工2=gemini、员工3=trae。

工作区E:\projects\openshell。分支、完整HEAD和远端边界以BASELINE.md为准。保全基线含未验收功能，不是可直接推送版本。按当前源码继续，不重做全仓审计/逆向，不恢复旧patch/stash/远端旧树。

先读docs/bug/2026-11-07-TASK7_REVIEW.md及自己Task7回执。Task7 CEO已补旧SQLite句柄释放、非Windows指引、session/vault读取归属、forward scope与孤儿会话可见性；不重写或撤销这些修复。原Task1–3分析优先复用，禁止读取真实秘密。

## 目标与互斥所有权（L2）

| 员工 | 个人任务 | 独占修改范围（含对应测试） |
|---|---|---|
| gpt | gpt1.md | app-core app_services/network_secrets/vault_service及相关恢复/同步测试；必要的store vault repository原子写helper；desktop vault_recovery/lib仅恢复编排 |
| gemini | gemini2.md | ImportExportModal、SyncSettingsModal、SnippetBar；syncStore、snippetStore、forwardStore及对应测试；PortForwardModal仅刷新归属/错误交互 |
| trae | trae3.md | terminalStore、serialStore、TerminalHost、TerminalTabs、XtermView、SerialSendBar、RdpSessionView及相关测试；必要rdp_process/helper；命令级测试提案交CEO |

sessionStore/vaultStore、公共UI、依赖/锁、全局样式、scripts、IPC/types与其他文件只读。backend/desktop/commands.rs由CEO保留；trae若需路由测试先在自己反馈给出最小hunk，CEO集成，不让两人改共享入口。gpt若内部复用vault写helper需同时改调用者和测试，不新增前端IPC/DTO。

## 固定边界

- forward_list/view、密码补录、archive token、rdp close/status/launch_id、sendTextToTab及现有IPC签名不变。
- 旧库检查/取消不能持久化vault、主密码绑定、last_opened、来源标记或迁移状态。新vault记录与补录必须共同成功或共同回滚；不删坏行/备份，不猜ref形态，不改成无验证运行。
- 保留成功提交后全局刷新；写成功不因读失败被改成写失败，重试只读。晚成功、晚失败与finally都需归属；不新增通用取消/事务框架。
- 串口生命周期停止动作必须按card归属，用户显式全局停止维持原意；关闭首个await前既停owned timer又失效epoch，成功write晚回调不能改新历史/stats。

## 执行与验收

1. 三条独立线各自内部闭环。每人先复现任务书中的失败，再修根因；真实IPC边界注入，不只mock顶层store动作。
2. 仅白名单定向测试/lint/必要typecheck；不并行全仓测试/构建，不增加timeout/skip/allow，不删断言或吞当前失败制造通过。
3. 不git add/commit/push/切分支，不reset/restore旧基线、不stash pop；保留他人文件。证据精简进audit/remediation-task8/自己名字/。
4. 只局部填写Task 8 Feedback.md自己小节，列命令/退出码、真实覆盖、未验证和发布依赖，重读确认。看不到文件或身份不明则报告，不猜。
5. UI无placeholder/实现文案/可选后缀，★仅必填为空时显示；不装驱动、不启停服务、不动真实数据库或隔离图片、不发布产品。

CEO集中收尾：前端单worker全量、typecheck/lint/build，MSVC Rust workspace test/check/clippy/fmt、脚本测试、真实dist扫描及依赖副本验证。只推通过的独立功能分支提交；本地WIP保全绝不能推送。真实协议/安装仍单列未验证，单元总数不代表上线。
