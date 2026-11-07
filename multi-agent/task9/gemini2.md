你是 gemini。本次任务目标为关闭已复现的同步跨流程竞态，作为多 agent 协作的一员，只负责下列任务：syncStore.ts/.test.ts、SyncSettingsModal.tsx/.test.tsx。

当前新同步界面仍仅本地保全，不能以 Task8 单流程测试通过代替交叉流程验收。保持现有IPC和状态接口，先复现下面五组，再最小修根因：

1. sync A 的刷新 pending → resolveConflict B 成功 → A finally：B 改了 syncFlowGeneration 却不持有 syncing，A 无法释放 busy，syncing 永久true。busy归属与刷新/错误归属必须一致且可释放；UI与store同时防重入，不能只禁一个按钮。
2. refreshSyncedViews 的 Promise.all 遇一个读取提前失败，另一个 snippet/session/vault 仍pending，busy已结束并可自动重入。等待所有已启动必需读取settle后报告当前错误，保留已成功mutation；不要把成功写入改成失败。
3. retryRefresh A 与手动sync/login/register/resolve B 使用不同代次，A 晚成功会清 B.refreshError。跨入口统一其共同写入状态的归属，保留 busy 独立职责。补晚resolve与晚reject双向矩阵。
4. loadConfig 只保护 set(config)，旧cfg仍发起 loadConflicts 并提升冲突代次，污染新流程。过期config不能继续派生读取；配置与冲突错误独立可见，当前初始configError应能显示并只读重试。
5. loadConflicts 成功写 error:null 会擦掉无关login失败；logout/clear未失效旧sync/config/conflict/refresh，晚完成重新写回已退出状态。按当前认证/流程生命周期失效读和UI回写，不重复mutation，不清掉当前有效错误。

使用真实store与 Tauri invoke deferred，补至少上述可达交叉流程，不靠mock顶层动作。断言busy在所有兄弟读取结束前保持、结束后释放，旧成功/失败不能覆盖当前列表/错误/认证状态；解决冲突按钮与初始配置失败真实渲染验证。回归同步成功后session/vault/snippet刷新、写成功读失败仅重读、无未处理拒绝。

定向命令：`pnpm --dir frontend exec vitest run src/stores/syncStore.test.ts src/components/SyncSettingsModal.test.tsx --maxWorkers=1 --minWorkers=1`，限定四文件 ESLint；必要 typecheck，记录红绿退出码。不得改snippetStore/sessionStore/vaultStore/IPC/backend、依赖锁或增加通用框架。反馈明确哪些真实登录/远程同步仍未测。
