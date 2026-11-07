# Task 7 统一任务书

状态：待下发。返工自Task6 R01/R03–R09；团队沿用员工1=gpt、员工2=gemini、员工3=trae。无需重新确认花名册。

工作区E:\projects\openshell；开工分支、完整SHA和远端边界见同目录BASELINE.md。本地基线含未验收保全代码，不是上线或发布证明。只沿当前源码继续修复，不reset/restore到远端旧版本，不套旧patch、不stash pop。

OpenShell是Rust/Tauri/React终端客户端。当前已通过批次独立推送在Fce/terminal-workspace-ux；未通过安全/归档/原生协议代码保存在本地。先读docs/bug/2026-11-07-TASK6_REVIEW.md及自己Task6回执；Task1–3分析优先复用，不重复逆向或读取真实配置秘密。

## 目标与分流

本轮是三条互不依赖的修复线（L2）。S01跨层工作全部交同一员工，其内部按枚举→目标校验→补录→旧库恢复顺序闭环；不把未确定的恢复接口交给另两人并行接线。S01已连续留缺口，本轮缩为下列具体可核验步骤，并扩大其独占范围以消除原白名单阻塞。

| 员工 | 文档 | 独占修改范围，含相关测试 |
|---|---|---|
| gpt | gpt1.md | backend/crates/app-core网络秘密、启动/同步/归档恢复；必要store秘密/迁移；desktop commands.rs、lib.rs、vault_recovery.rs；PortForwardModal、ProxyManagerModal、forwardStore；frontend lib/ipc.ts、types/ipc.ts仅凭据恢复相关契约 |
| gemini | gemini2.md | ImportExportModal、SyncSettingsModal、SnippetBar；syncStore、snippetStore、sessionStore、vaultStore及相应测试，仅读错误/归属/刷新闭环 |
| trae | trae3.md | terminalStore、serialStore、XtermView、RdpSessionView、TerminalTabs、MultiExecBar、CommandInputBar、SerialSendBar、lib/terminal-actions；desktop rdp_host.rs/rdp_process.rs/rdp_host.cs及相应测试 |

其他源码、依赖/锁、全局样式、公共Field、scripts均只读；CEO负责共享入口集成及发布检查。gpt独占IPC公共文件，只修改凭据恢复所需部分，保留另两人使用的现有接口。所有员工只看自己分流文档，不改别人反馈。

## 冻结契约与安全决策

- sendTextToTab(tabId,text):Promise<void>、serial发送接口、rdp close/status/launch_id和archive token契约不变。不得新增通用取消框架或用any绕过类型。
- 凭据恢复优先复用现有forward_update/save_proxies显式密码输入，允许gpt在同一独占垂直范围实现必要的最小恢复入口；不能再次以“需要前端”停在仅后端函数。确需新IPC，gpt须同时实现Rust注册/类型/封装/调用者及定向契约测试，在回执列明；不得改变其他IPC。
- 列表提供脱敏元数据，坏行的未知ref绝不回传（可能就是历史明文）；用户可进入该条编辑，补录必须显式输入。运行仅校验目标规则，未知/丢失秘密仍拒绝运行，禁止把ref当密码、猜ULID/长度或关闭验证。
- schema1、标记前引用库、现代库、混合库都保留原值；取消/错误主密码/补录失败应可重试且原库、原备份不损坏。不能删除坏规则或重建库换取启动成功。
- mutation成功与刷新失败分离；重试仅重新读，不重复提交/同步/解决冲突。旧异步成功和拒绝均不能污染新的连接或界面。

## 验收与纪律

1. 每条修复先以真实根因最小测试复现，再修共享根因，追所有调用者；不要只替换顶层store action mock，读失败要从真实IPC边界注入。
2. 员工只跑受影响模块定向测试/lint/必要类型检查；禁止并行全仓测试/构建。不得加timeout、skip、allow或删断言制造通过。
3. 不git add/commit/push/切分支；只交文件与可独立提交组，保留他人工作。证据集中audit/remediation-task7/自己名字/，保持精简，无真实秘密。
4. 局部填写Task 7 Feedback.md自己小节并重读。写清命令、退出码、验证范围/未验证部分、依赖，不能将mock或进程启动称为真实协议验收。
5. 原5张FinalShell图片不回public；不装驱动、不启停服务、不发布、不删旧stash/备份/任务。UI无placeholder、无实现文案/可选后缀，★仅必填为空时显示并保留无障碍语义。

CEO收尾：三份回执齐后独立评审、前端全量(test限定worker、typecheck/lint/build)、Rust workspace test/check/clippy/fmt、脚本测试及真实dist扫描；跨层契约/依赖变更必须全量验证。只有通过的依赖闭环提交至远端功能分支，禁止推本地WIP或宣告可上线。缺真实硬件环境单独列明。
