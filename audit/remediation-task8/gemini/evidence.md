# Task 8 · Gemini (员工2) 验证证据

- 基线 SHA：`d7bbd25c6c3f296f82e4514d3037601921da8fd3`
- 分支：`Fce/task8-integration`
- 测试结果：7 文件 / 75 测试全部通过，退出码 0。
- ESLint：12 文件 0 error 0 warning，退出码 0。
- 类型检查：除员工3正在进行的 `serialStore.test.ts` 既有未使用变量外，Gemini 负责的 12 个源码与测试文件 0 错误。

## 失败先复现与红绿对比

| 编号 | 模块 / 用例 | 红测现象 (Exit 1) | 绿测现象 (Exit 0) |
|---|---|---|---|
| R02 | `snippetStore.test.ts` (loadSnippets out-of-order) | `Expected: snip_B, Received: snip_A` (代次缺失，慢请求 A 晚完成覆盖新结果 B) | 代次 `snippetGeneration` 生效，A 晚 resolve 被忽略，保留 B |
| R01 | `syncStore.test.ts` (syncing 覆盖全流程) | `AssertionError: expected false to be true` (调用 `sync_now` 后即清除 syncing，视图刷新中重入) | `syncing` 贯穿配置与视图刷新全程，期间重入被阻断 |
| R03 | `syncStore.test.ts` (loadConfig 冲突可等待) | `AssertionError: expected null to be truthy` (`loadConflicts` 未被 await，读冲突失败被静默吞掉) | `conflict_count > 0` 严格 await `loadConflicts({ throwOnError })` 并冒泡至 `refreshError` |
| R06 | `forwardStore.test.ts` (refreshAfterMutation 乱序) | `Refresh A 晚完成清除了 Refresh B 的 refreshError` | `refreshGeneration` 生效，过期的刷新完成不改变当前最新 `refreshError` |
| R06 | `forwardStore.test.ts` (loadStatuses 乱序) | `Expected: Listening, Received: Stopped` (慢读取 A 覆盖新状态 B) | `statusGeneration` 生效，过期的状态读取被丢弃 |
| R04 | `ImportExportModal.test.tsx` (handleRefreshAfterCommit) | `retry refresh pending -> switch tab -> late reject: does not write refreshError into new tab` 失败，A 的重试错误写入新 tab | `handleRefreshAfterCommit` 纳入代次与 mounted 校验，切 tab/策略或预览 B 后 A 不写 B |
| R04 | `ImportExportModal.test.tsx` (Commit A 决议中 Preview B pending) | B 预览 pending 期间 A 决议，B 的 loading 保持及 token 归属 | 保持 B 的 loading，A resolve/reject 仅清理自身代次 |
| R05 | `ImportExportModal.test.tsx` (完整 S04 矩阵) | 过去仅测 JSON resolve，缺少 osvault arrayBuffer 切 tab/卸载晚 resolve 与 reject | 补充完整的 arrayBuffer 与 JSON 晚 resolve/reject 独立用例 |
| R03 | `SyncSettingsModal.test.tsx` (挂载 loadConflicts 拒绝与重试) | 挂载 unhandledRejection 且无只读重试按钮 | `Promise.resolve` 消费拒绝，InlineNotice 暴露只读「重试」调用 `retryRefreshViews` |
| R02 | `SnippetBar.test.tsx` (真实 store/IPC 边界) | 原测试直接 mock 替换 store 的 `createSnippet`/`deleteSnippet` 动作 | 还原真实 store 方法，通过 mock 底层 IPC `snippetCreate`/`snippetDelete` 证明真实读后写和错误隔离 |

