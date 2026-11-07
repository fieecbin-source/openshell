# Task9 本次执行基线（2026-11-07）

- 原始远端分支：`Fce/task8-integration`。
- 冻结 HEAD：`7b3007a13c839857f19d89ce931c7d8b273a9eee`。
- 当前执行分支：`codex/task9-closeout`，工作区 `E:\Projects\openshell`。
- 用户已授权查看 task1–9 并完成剩余工作；按 Task9 三条互斥文件线实施，集中验证。
- 开工工作区和索引干净。保留原 Task1–8 回执，不将历史测试或 WIP 提交当作本轮验收。
- 发布副本 `openshell-approved` 与 `docs/bug/2026-11-07-TASK8_REVIEW.md` 不在本次拉取内容中。依据已发布的 Task8 回执、Task9 具体失败矩阵和当前代码继续，不伪造缺失的历史报告。
- 三线只修改 Task9 白名单；不改变 IPC、后端、依赖或锁文件。CEO 统一更新反馈，避免并行覆盖。CEO 额外集成 sessionStore.ts/.test.ts 的嵌套读取等待、AboutUpdateTab.tsx/copy.ts 的既有文案集中性，以及 sync_lifecycle_test.rs 冗余 Ok/? 闭包；后者仅测试代码，不改变后端行为或契约。
- 回归使用合成凭据、隔离 fixture 和真实 store/IPC 边界，不读取用户真实缓存或数据库。
- 本次新增提交只包含实际修复、测试及精简 Markdown 结论。原 Task8 整支不得据此视为可发布；不合入 dev/main 或发布安装包。
- 真实 RDP/NLA、实体串口、外部 X11/agent、CredUI、macOS/Linux 和安装升级仍需对应环境验收。
