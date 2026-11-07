# Task9：最后一轮数据迁移、同步归属与覆盖收口

花名册沿用：员工1=gpt，员工2=gemini，员工3=trae。状态：待用户统一下发。工作区 E:\projects\openshell，分支/完整HEAD以 BASELINE.md 为准。只接着现有代码，不重做全仓审计、逆向或恢复旧 patch。批准副本 E:\projects\openshell-approved 只读；本地主分支含未验收保全，禁止整支推送。

先读 docs/bug/2026-11-07-TASK8_REVIEW.md、BASELINE.md、本人任务和 Task8 回执。Task8 CEO 已修只读旧库检查/原子恢复、串口关闭前停定时器、晚成功与历史合并、RDP 命令清理重试、导入 refreshing 与转发状态读取归属、代理 clear_password 与旧缓存误删。不得撤销。

## 互斥所有权

| 员工 | 任务文件 | 可修改文件（含相应同名测试） |
|---|---|---|
| gpt | gpt1.md | frontend/src/components/ProxyManagerModal.tsx 及 .test.tsx |
| gemini | gemini2.md | frontend/src/stores/syncStore.ts/.test.ts；frontend/src/components/SyncSettingsModal.tsx/.test.tsx |
| trae | trae3.md | frontend/src/components/ImportExportModal.tsx/.test.tsx、SnippetBar.tsx/.test.tsx、PortForwardModal.tsx/.test.tsx；frontend/src/stores/snippetStore.ts/.test.ts、forwardStore.ts/.test.ts |

backend、sessionStore/vaultStore、terminalStore/serialStore、IPC/types、公共UI、配置、依赖/锁、scripts只读。若必须改共享契约，先在本人回执提交最小提案，CEO集成，不越界修改。三条线无必要代码依赖，可以并行。

## 不变契约与边界

- 密码只能作为临时 ProxyServerInput 输入，经现有 proxyListSave 加密；配置输出不含 password。保留/显式清除语义不变，测试也必须传 clear_password。
- 旧 localStorage 缓存当前保留原值且停止写新明文。只有相应数据确认安全持久化且未发生并发替换才可删除旧缓存；锁库、失败、无效行、冲突均不能默默丢失数据。不读取真实浏览器或用户库，只用隔离 fixture。
- archive_token、提交成功后的全局刷新、sendTextToTab、throwOnError 可选行为、现有IPC参数不变。写成功与后续读失败分离；重试只读，不重复提交。
- busy、列表数据、错误及 finally 必须有当前操作归属；不把多个 generation 随意合并，也不增加通用取消/事务框架。旧 mutation 完成后仍履行必要后台刷新，但不能回写已换代界面。
- 所有输入无 placeholder/可选后缀，空必填才显示★；界面不出现实现说明。无需扩展UI或改样式。

## 执行与回执

1. 先写能复现指定失败的测试，取得实际红测；最小修复后绿测。真实 store/IPC 边界注入，不只 mock 顶层动作；resolve、reject、finally 都断言实际可见状态。
2. 员工仅跑白名单定向 Vitest 单 worker、限定 ESLint、必要 typecheck；不并行全量/Cargo/build，不增 timeout/skip/allow，不删断言、吞当前失败或更换 acceptance。
3. 不 add/commit/push/切分支，不 reset/restore/stash pop/清理他人文件。证据精简至 audit/remediation-task9/本人名字/。
4. 只填写 Task 9 Feedback.md 自己小节，列实际命令与退出码、修改、发布依赖和未验证项，写完重读。
5. CEO 集中审核、完整门禁、按依赖提取并推送通过批次，保全全部剩余代码并保持 Git 干净。真实 RDP/NLA、实体串口、外部 X11/agent、CredUI、非Windows与安装升级继续列未验证，测试数不能替代。
