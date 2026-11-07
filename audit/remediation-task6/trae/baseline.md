# Task 6 · trae 开工核对（2026-11-07）

## 只读命令与真实输出

命令（工作目录为仓库根目录）：

```
git branch --show-current
git rev-parse HEAD
git status --short
git diff --stat 9b05523777b38d5f1e1653abf9b57449f88c18cc
```

退出码：0

- 分支：`Fce/task6-integration`
- HEAD：`9b05523777b38d5f1e1653abf9b57449f88c18cc`（与保全基线一致，未改写、未回退）
- 相对 `9b05523` 当前增量：`12 files changed, 877 insertions(+), 152 deletions(-)`

| 当前已修改文件 | 归属 | 处理 |
|---|---|---|
| `backend/crates/app-core/src/app_services.rs` | gpt | 原样保留 |
| `backend/crates/app-core/src/network_secrets.rs` | gpt | 原样保留 |
| `backend/crates/app-core/src/sync_service.rs` | gpt | 原样保留 |
| `backend/crates/app-core/tests/network_recovery_test.rs` | gpt | 原样保留 |
| `backend/crates/app-core/tests/sync_lifecycle_test.rs` | gpt | 原样保留 |
| `backend/crates/forward/tests/lifecycle.rs` | gpt | 原样保留 |
| `scripts/check-package.mjs` | gpt/CEO | 原样保留 |
| `scripts/check-package.test.mjs` | gpt/CEO | 原样保留 |
| `frontend/src/stores/aiSettingsStore.ts` | 其他员工 | 原样保留 |
| `frontend/src/stores/syncStore.ts` | gemini | 原样保留 |
| `frontend/src/updater/AboutUpdateTab.test.tsx` | 其他员工 | 原样保留 |
| `frontend/src/updater/store.test.ts` | 其他员工 | 原样保留 |

上述文件全部不在 trae 白名单，一律不清理、不覆盖、不纳入本人 diff 或提交组。

## 结论

- 本轮本人白名单文件（`frontend/src/stores/terminalStore.ts`、`terminalStore.test.ts`、`serialStore.*`、`XtermView.*`、`RdpSessionView.tsx` 等）当前相对基线干净，无既有 Task6 增量。
- 后续一律以 `git diff 9b05523 -- <本人文件路径>` 登记本轮增量。
- 未执行 apply 旧 patch / stash pop / checkout / reset / restore 到 `7f89324`；未 `git add` / `commit` / `push`。
- `audit/remediation-task6/gpt/` 已有他人在轮证据，本目录仅写 trae 本人证据。
