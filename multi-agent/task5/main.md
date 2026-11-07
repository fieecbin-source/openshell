# Task 5：Task 4 交叉评审返工与分批提交准备

- 状态：待下发；不是验收通过记录。
- 花名册沿用用户确认：员工1 gpt，员工2 gemini，员工3 trae。
- 来源：Task 4 三人回执 + CEO全量检查 + 三组只读独立评审（2026-11-06）。
- 工作区：`E:\projects\openshell`，分支 `Fce/terminal-workspace-ux`。开工重新核对HEAD与自己文件diff，不能覆盖现有改动。
- 模式：L2。主要补齐Task4已交付契约的调用者，不新改IPC。确需改变接口的部分转L3，先向CEO报告，其余独立项继续。
- 批次策略：CEO已开始把审查及定向测试通过的独立模块提交/推送到当前功能分支。其余源码留工作区，后续按安全存储→归档/同步→前端协议→外观的依赖顺序收口。员工不自行提交、推送或全仓格式化。

## 先读证据

1. `multi-agent/task4/main.md`、自己的旧回执；以当前源码为准。gpt已交付RDP状态/关闭、unavailable_fields、归档discard、同步冲突IPC，其他员工“尚未交付”的旧文字已经过时。
2. `docs/bug/2026-11-06-BUG_LIST.md`、原验收报告；保留快照不改历史结论。
3. `docs/bug/2026-11-06-REMEDIATION_REVIEW.md`、`audit/ceo-frontend-test.log`、`audit/ceo-cargo-test.log`。
4. FinalShell参考、无真实秘密取证、用户UI规则均沿用Task4。不重新逆向已有常量。

## 本轮发现与唯一负责人

| 编号 | 优先级 | 具体触发与错误 | 负责人 |
|---|---|---|---|
| R01 | P1 | 26位字母数字旧SOCKS明文口令被误判为不存在的SecretId，旧profile正确解锁后仍无法升级 | gpt |
| R02 | P1 | FinalShell导入接受认证动态隧道时，原始列表密码留在普通session JSON，生成规则却降为无认证 | gpt |
| R03 | P1 | 满串口RX队列+持sessions锁等待worker控制，可阻塞read/close及所有串口会话 | gpt |
| R04 | P1 | RDP状态/close无生产调用者；启动后一直connecting；重启按钮无效；关标签/迟到启动不释放实例 | trae |
| R05 | P1 | 新旧契约混用导致typecheck失败：transferring、command_template、ProviderTestResult.code=null、测试fixture缺字段 | gemini负责自己模块，trae负责AppLayout |
| R06 | P1 | 同步解决和SFTP恢复catch包装失败后raw invoke重试，吞掉原异常、可能重复修改 | gemini |
| R07 | P1 | 归档无session候选时UI禁止commit，片段/分组/密钥/代理单独归档无法恢复 | gemini |
| R08 | P2 | 归档改策略不discard；预览迟到泄漏token；新预览失败后旧已discard报告仍可操作 | gemini |
| R09 | P2 | SnippetBar/MultiExecBar直接UTF-8写PTY，绕过会话编码；串口片段错误发送到不存在的PTY | gemini负责SnippetBar；trae负责共享发送和MultiExecBar |
| R10 | P2 | 串口故障后HEX订阅不恢复；关闭/读失败不统一停止定时发送，重连后可能意外继续发 | trae |
| R11 | P2 | unavailable_fields无UI消费者，首个CPU/网速采样和缺字段仍显示0 | trae |
| R12 | P1门禁 | 前端全量191过3失败；Rust全量在m3导入测试停下；定向测试不能替代这些门禁 | gpt修后端测试，gemini修sync错误，trae核对settings默认迁移 |
| R13 | P2 | 导入/同步冲突后片段store不刷新，挂载中的快捷命令显示旧内容 | gemini |
| R14 | P2待核对 | 远端转发已有relay不受stop路由取消；只测监听释放未测已建立socket | gpt |
| R15 | 暂缓推送 | 5张fs-bg JPG与FinalShell Jar内资源字节一致，共6,312,278字节，无已核实再分发来源记录 | trae保留本地，隔离素材与默认值批次 |

AI畸形JSON数据帧后接有效终止仍被判成功的补充问题由CEO在独立AI批次直接修复/验证，不与员工抢改；员工不修改AI provider或其测试。包扫描已由CEO独立评审/测试后提交。

## 分流与互斥所有权

| 身份 | 任务书 | 唯一可改范围（含对应测试） |
|---|---|---|
| gpt | `gpt1.md` | backend/app-core网络秘密和恢复、importer FinalShell、serial native/service、forward/ssh远端relay与相关后端测试；具体见个人任务；其他backend只在必要调用链上最小修改 |
| gemini | `gemini2.md` | SftpView/TransferQueueDrawer/ImportExportModal/SnippetBar/SyncSettingsModal、sftpStore/syncStore/snippetStore/aiSettingsStore、updater目录及对应测试 |
| trae | `trae3.md` | terminalStore/serialStore/monitorStore、RdpSessionView/TerminalTabs/TerminalHost/XtermView/HexDumpView/MultiExecBar/CommandInputBar、lib/terminal-actions、MonitorDashboard/ServerSidebar/ConnectionDetailsPopover/AppLayout、settingsStore及对应测试；壁纸批次只核对不发布 |

- 共享 `frontend/src/types/ipc.ts`、`frontend/src/lib/ipc.ts`、`lib/ai/aiIpc.ts`：本轮冻结，当前契约已交付，只有CEO可改；需要改先报具体原因。
- SnippetBar由gemini通过既有terminalStore发送入口使用会话编码/协议；trae修复该共享入口与MultiExecBar。不存在可复用入口时先报CEO确定一个最小签名，不各造路径。
- `frontend/package.json`、`pnpm-lock.yaml`、全局样式、公共UI组件、`.gitignore`及提交索引：CEO独占。
- 旧task1–4个人任务/员工回执、原audit证据只读；本轮证据进 `audit/remediation-task5/<员工>/`；只局部patch自己Feedback小节。
- 不读取/打印真实密码，不安装驱动或改系统网络，不自动删除旧备份/用户素材，不把日志/副本/分析结果提交产品仓库。

## 验收和批次门禁

1. 每项有最小重现与回归，保留原安全/功能断言；禁止以any、增加skip、单纯加timeout或重复invoke让测试通过。
2. 有来源争议的壁纸不随产品批次推送；保留本机文件。可提交不依赖它们的UI修复。若要移除产品引用，保留用户已有设置兼容，并使用已核实可发布的现有资源；不擅自声称得到再分发授权。
3. 并行仅跑自己模块的vitest/Cargo目标和限定lint；全量test/typecheck/build/clippy/fmt由CEO在全员完成、停止编辑后集中跑。检查命令沿用Task4。
4. 用户要求分批减少diff：回执列出可独立提交的文件组和依赖；有共享文件按hunk说明。不交“一次git add -A”方案，不提交audit/multi-agent/复制环境。
5. 完成后更新本轮回执，说明当前实际状态。未有真实RDP成功登录、串口热插拔、真实X Server等证据的能力保持未验证；P1和三项原上线阻塞未解除前不作上线通过结论。

## CEO自留

复核真实增量、修复少量共享集成问题、按测试通过的提交树分批提交推送当前功能分支；不合并main/dev、不发布。维护批次记录和新验收报告；继续跟进本轮回执。

## CEO 派工前审查与对接裁决（本轮执行前共同读取）

用户再次确认Task5仍由gpt/gemini/trae三人承担。已读回现有六份任务文件；三份员工回执均为空，尚无Task5完成声明。派工核对HEAD为 `10a989e7e5597d1300c8ad8af1412b4ecb03ca3f`，与远程功能分支一致，索引为空，工作区仍有137条待处理记录。员工实际开工须再次核对，不假设此后无人提交。

1. **R09发送契约由CEO锁定**：现有 `terminalStore.sendCommandToTabs(command, options)` 的参数保持不变。trae将其中单目标的编码/协议发送动作复用为store方法 `sendTextToTab(tabId: string, text: string): Promise<void>`；它不增删换行、不写命令历史、不改变activeTabId，只向指定的当前已连接可发送标签写入文本，按该Session.encoding编码，串口走sendSerial，其余可交互终端走writeTerminal；目标不可用或发送失败必须reject，不能只console后resolve。既有sendCommandToTabs、MultiExecBar与gemini的SnippetBar复用此动作；各调用者保留现有insert/execute与换行规则，禁止选中子集被扩大为全部标签。不新增Rust IPC、不做通用消息框架。
2. **R09文件所有权不变**：trae独占terminalStore及其测试、MultiExecBar；gemini独占SnippetBar及其测试。gemini按上述签名写调用者和定向测试，trae实现该签名；真实联调及全量门禁等待两方交付，不在另一方未完成时改其文件。不需要员工再就此签名询问CEO。
3. **执行顺序**：gpt先R01/R02/R03，再后端集成门禁，最后核对R14；gemini先R06/R07/R08及R05，再R09/R13；trae先交付R09共用发送入口，再R04/R10/R11/R05/R12，R15素材仅隔离与核对。模块内按依赖顺序做，三位员工可并行，不把跨端联调当作已完成的单元验证。
4. **已推送批次冻结**：AI provider及其测试、包扫描、SFTP已提交的完整性实现不重新改写。修sftpStore/UI不等于重做SFTP后端。发现已提交模块确有新缺陷时在回执附最小复现，由CEO决定追加修复批次。
5. **收尾提交顺序**：安全存储/旧库与导入防线 → 归档/同步/片段 → 串口与终端编码/RDP/监控 → 独立外观批次。能独立通过的先评审；每批说明依赖并验证暂存内容，禁止将未验证的其他工作区改动混入。Task5员工只交代码和回执，不自行推送；CEO复核后集中执行已授权的分批推送。
6. **完成定义**：R01–R13相关缺口有回归和真实调用者，门禁失败逐一解除；R14有明确停止语义与证据，R15不将未核实资源混入发布。全量前端test/typecheck/lint/build、Rust workspace test/check/clippy/fmt及包扫描由CEO在停止编辑后集中跑；真实硬件/成功RDP登录等未具备条件的项目仍单列未验证，不因本轮开发完成而宣称上线通过。
