# Task 6 统一任务书：修复Task5评审遗留，继续分批推送

- 状态：待下发，未启动外部员工。
- 花名册沿用用户已确认：员工1 gpt、员工2 gemini、员工3 trae。
- 难度L2：冻结Rust IPC与DTO，按互斥文件并行。确需改契约/依赖先交CEO裁决，受影响部分另排L3。
- 工作区`E:\projects\openshell`，Task6本地分支`Fce/task6-integration`，开工基线`9b05523777b38d5f1e1653abf9b57449f88c18cc`。此为未验收代码的本地保全提交，不是通过或发布记录；已验证远端分支`Fce/terminal-workspace-ux`保持`7f89324`。开工重核HEAD/diff，禁止切回远端旧基线覆盖本地保全提交。
- 返工自Task5：S01–S08见`docs/bug/2026-11-06-TASK5_REVIEW.md`。本轮不重做已推送的AI/SFTP/串口/详情/备份批次。

## 共同先读

1. 上述CEO评审报告、自己Task5回执及当前调用链。
2. Task4/5 main里的秘密保护、无假成功、UI规则和测试边界；旧报告不改成通过。
3. `audit/ceo-task5-workspace-tests.log`、`ceo-task5-clippy-final.log`及自己相关前端证据。已知前端217过，当前类型与构建已通过；不能拿这些数覆盖新增竞态。

## 分流及文件所有权

| 员工 | 任务书 | 独占范围（含对应测试） |
|---|---|---|
| gpt | `gpt1.md` | backend/crates/app-core网络秘密、启动恢复、sync_service/sync_codec、archive_service必要门禁、后端相关测试；必要的store/server history fixture、forward/ssh释放及生命周期测试 |
| gemini | `gemini2.md` | ImportExportModal、syncStore、snippetStore、SnippetBar、SyncSettingsModal及对应测试 |
| trae | `trae3.md` | terminalStore、serialStore、RdpSessionView、TerminalTabs、MultiExecBar、CommandInputBar、XtermView、HexDumpView、MonitorDashboard/monitorStore、ServerSidebar及对应测试；lib/terminal-actions |

S08包扫描另由gpt独占`scripts/check-package.mjs`及其测试；其他发布脚本、依赖与锁文件仍只读。

共享`frontend/src/types/ipc.ts`、`frontend/src/lib/ipc.ts`、`lib/ai/aiIpc.ts`，依赖/锁文件、公共UI、全局样式、索引/提交由CEO保留。无白名单文件只读。Task5员工回执及旧audit只读，本轮证据进`audit/remediation-task6/<员工>/`，只局部更新自己的Feedback小节。

## 问题、负责人和完成标准

| ID | 负责人 | 可核验目标 |
|---|---|---|
| S01 | gpt | 旧明文26字符/ULID口令仍可安全迁移；引入标记前已引用化库、现代库及混合库丢失secret时不把ref当密码；失败不丢原值、正确密码重填/恢复可继续 |
| S02 | gpt | 先复现真实history的旧forward→换secret→新forward→旧secret删除 catch-up，再正确应用最新状态；envelope/revision/tombstone/冲突一致，篡改历史仍拒绝 |
| S03 | gemini | 预览pending时切策略/切tab，不永久loading；旧请求不可覆盖新状态，token最终释放 |
| S04 | gemini | A/B文件读取乱序不会混淆名称和内容；关闭、切tab、读失败均不恢复错误归档 |
| S05 | trae | 同tab重启串行或最新代次获胜；失败关闭可见、无孤立launch_id；关闭/重连中的迟到结果被释放，其他tab不受影响 |
| S06 | trae | 编码等待期间关闭/重连，旧发送拒绝，不写入新连接；SSH/串口均有证据，广播选中集/换行/活动tab和历史不回归 |
| S07 | gemini | 真实snippetList失败可被导入/冲突UI识别为“操作已成功、刷新失败”；只重试刷新，不重复修改；普通SnippetBar读失败也有处理，无未捕获rejection |
| S08 | gpt/CEO | 保留转发监听/握手子任务释放断言，定位全量失败根因；Clippy所有目标及dist包扫描通过，保留真正秘密正例，不加allow/skip或单纯加timeout |

## 跨员工契约

- `sendTextToTab(tabId: string, text: string): Promise<void>`保持；trae修代次归属，gemini只调用，不改变Rust IPC、不在SnippetBar重新TextEncoder编码。
- `snippetStore.loadSnippets(groupId?): Promise<void>`签名保持；若要让失败reject，由gemini同时检查更新自己负责的所有调用者，不把成功mutation当失败并重发。不能只改mock。
- RDP launch_id/status/close及archive token接口保持。任务6先修生命周期，不新增通用取消框架、消息总线或可配置超时。
- 后端两项来源/历史问题可能有架构取舍：先最小复现、提出最小安全实现；不能用缺标记或字符串形状猜秘密，不得关闭引用校验让测试过。

## 执行、验证和分批规则

1. 先根因与最小回归，修共享根因，追所有调用者；对尚未动态复现的S02先明确证据再下结论。
2. 并行只跑相关模块/限定lint；CEO在停止编辑后集中跑前端test/typecheck/lint/build及Rust workspace test/check/clippy/fmt和包扫描。无真实硬件环境的项目明示未验证。
3. 不改已提交串口/AI/SFTP实现来绕过本轮错误，不删除既有断言、不增加skip/allow、不简单放宽timeout。若证据确需修改已提交模块，先把复现/最小差异交CEO。
4. 员工不git add/commit/push。回执给出可独立提交的文件/hunk及依赖，CEO验证暂存树后分批推送，安全/同步→归档→协议UI→外观。任何P1未解除的批次继续保留工作区。
5. 无真实秘密进入证据，旧备份/用户配置不删除。5张FinalShell图片已移到ignored audit并移出public，不重新注册/复制到public，不重新逆向已有常量。
6. 不安装系统驱动、启停系统服务或发布产品；这轮是代码修复与验收准备。不能以进程启动、Mock、单元总数代替真实协议验收。

## CEO自留

核对实际回执、修少量共享问题、集中门禁及独立暂存副本验证，继续已获授权的功能分支分批推送。根因无法复现、环境不足或接口需要裁决的部分保持明确状态，不预先给上线通过结论。

## CEO 更新开工基线（2026-11-07，执行前共同确认）

用户要求“通过部分推远端、本地Git干净，避免Task6叠加旧diff”。已验证的五个提交留在远端`Fce/terminal-workspace-ux`，最新`7f89324`；剩余118项源码未被冒充通过推送，而是在同一项目目录的独立本地分支`Fce/task6-integration`建立保全提交`9b05523`。118个文件提交前后SHA256逐项一致，索引和工作区均为空；旧stash、用户配置、旧备份、ignored任务与证据保留。

三位员工仍共用`E:\projects\openshell`和本地Task6分支，按已有互斥白名单工作。开工先运行`git branch --show-current`、`git rev-parse HEAD`、`git status --short`：首次应为上述分支/完整基线SHA和干净状态；若其他员工已开始，可能已有其白名单内的Task6修改，记录并保留，不要求清理他人的新增工作。只用相对`9b05523`的diff记录本轮增量。

不得apply旧baseline.patch、stash pop、checkout/reset/restore到`7f89324`，不得改写本地保全提交、把其当已通过的提交直接推送或合并主分支。Task6新增修改仍由CEO验收后整理成可独立验证的远端批次；保全历史中的未验收内容也需要审查，不因当前git clean而被视为质量通过。员工继续只交源码/回执，不自行git add/commit/push。
