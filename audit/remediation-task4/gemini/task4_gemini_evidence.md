# Task 4 · Gemini 修复证据与定向验证报告

- 负责人：员工2 (gemini)
- 范围：SFTP (BUG-002, BUG-006, BUG-007)、代理密码安全 (BUG-011)、动态转发 (BUG-011–014)、归档/导入 (BUG-015–017)、同步冲突 (BUG-018)、AI 设置 (BUG-021, BUG-022)、备份 (BUG-023, BUG-024)、片段 (BUG-026)、自身范围 G01。
- 日期：2026-11-06

---

## 1. 修复清单与实现位置

### 1.1 P0 传输 (BUG-002, BUG-006, BUG-007)
- **改动文件**：
  - `frontend/src/stores/sftpStore.ts`: 普通上传/下载默认 `resume = false`；新增 `resumeTransfer(taskId)` 调用 `sftpResumeTransfer(taskId)`，复用原任务 ID 恢复传输。
  - `frontend/src/components/SftpView.tsx`: 上传/下载显式设置 `resume: false`。
  - `frontend/src/components/TransferQueueDrawer.tsx`: 统一 `running` 运行态；在 `running`/`queued` 状态显示“暂停”与“取消”；在 `paused` 状态显示“恢复”与“取消”；在 `completed`/`failed`/`cancelled` 终态隐藏控制按钮，避免伪装新任务。
- **验证**：
  - `frontend/src/stores/sftpStore.test.ts` (5 tests passed)
  - `frontend/src/components/TransferQueueDrawer.test.tsx` (3 tests passed)
  - `frontend/src/components/SftpView.test.tsx` (1 test passed)

### 1.2 P0 代理密码 (BUG-011)
- **改动文件**：
  - `frontend/src/components/ProxyManagerModal.tsx`:
    - 彻底移除 `localStorage` 读取与写入代理包含明文密码的旧逻辑（`readFallbackProxies` / `writeFallbackProxies`）；
    - 组件初始化时执行 `cleanLegacyProxyCache()` 清除旧缓存键 `openshell_proxy_list_fallback_v1`；
    - 表单密码仅作为临时提交内存，不回显解密密码；编辑时密码留空保留已有 Vault 凭据；勾选 `clear_password` 才显式清空；
    - `proxyListSave` 抛错（如 Vault 锁定）时不更新 proxies 本地缓存，保留当前表单编辑状态并显示友好错误提示。
- **验证**：
  - `frontend/src/components/ProxyManagerModal.test.tsx` (7 tests passed)

### 1.3 动态转发 (BUG-011–014)
- **改动文件**：
  - `frontend/src/components/PortForwardModal.tsx`:
    - SOCKS 认证类型更新为 `userpass` 标准线值；
    - 用户输入密码放入 `socks_password`，绝不传入 `socks_password_ref`；
    - 支持编辑保留与 `socks_clear_password` 清除；
    - 依据 `has_socks_password` 与用户名展示凭据状态，不回显明文密码；
    - 规则启停失败时友好弹窗提示，不伪报成功。
- **验证**：
  - `frontend/src/components/PortForwardModal.test.tsx` (3 tests passed)

### 1.4 归档/导入 (BUG-015–017)
- **改动文件**：
  - `frontend/src/components/ImportExportModal.tsx`:
    - 提交导入时向 `importerCommit` 传入 `archive_token`；
    - 关闭弹窗、重选文件、重新校验预览或切换 Tab 时，自动调用 `importerDiscardPreview` / `invoke("importer_discard_preview", ...)` 释放服务端暂存；
    - 导入成功后保留 warnings 显示（“已导入会话的待补录依赖”），防止跳板机或私钥依赖静默遗漏；
    - 提交失败时显示具体友好错误提示，不冒充成功；全过程不将加密包或会话秘密写入 localStorage 或 console 日志。
- **验证**：
  - `frontend/src/components/ImportExportModal.test.tsx` (3 tests passed)

### 1.5 同步冲突 (BUG-018)
- **改动文件**：
  - `frontend/src/stores/syncStore.ts`:
    - 增加 `conflicts: SyncConflict[]`、`loadConflicts()`、`resolveConflict(conflictId, choice: "local" | "remote")`；
    - 防重复提交机制（`resolvingConflictId`）；解决成功后原子刷新冲突列表与配置；失败保留冲突记录并展示错误；
    - 坚决不用 `clearLocalSyncData()` 或 `logout()` 代替冲突解决；不将未解密秘密快照传至 renderer。
  - `frontend/src/components/SyncSettingsModal.tsx`:
    - 当存在冲突时渲染冲突列表卡片，为每个冲突提供“保留本地副本”和“使用远端数据”两个明确动作；防重复点击并在操作后刷新。
- **验证**：
  - `frontend/src/stores/syncStore.test.ts` (8 tests passed)
  - `frontend/src/components/SyncSettingsModal.test.tsx` (4 tests passed)

### 1.6 AI 设置 (BUG-021, BUG-022)
- **改动文件**：
  - `frontend/src/stores/aiSettingsStore.ts`:
    - `testProfile` 在无论成功、失败、超时或抛错时，均强制重置 `testingProfileId` 为 `null`；
    - 仅当 `result && result.ok === true` 时才更新 `verified_at`；失败与 reject 绝不更新 `verified_at`；
    - 抛错或超时封装为规范的 `ProviderTestResult`，供前端状态机精确感知。
  - `frontend/src/components/settings/ai/AiModelSettings.tsx`:
    - 新增 `formatShortAiError`，避免将远端 502 HTML、网关异常或原始 JSON 暴露给用户；不加伪装完成的前端计时器。
- **验证**：
  - `frontend/src/stores/aiSettingsStore.test.ts` (8 tests passed)

### 1.7 备份 (BUG-023, BUG-024)
- **改动文件**：
  - `frontend/src/updater/store.ts`:
    - `loadConfig` 读取规范键 `update.backup_keep`，兼容旧键 `update.backupKeep`，规范键优先，缺省默认 5；
    - `patchConfig` 仅写入 `update.backup_keep`；
    - `backupNow` 不再吞错，将 `api.backupNow("manual")` 的 reject 向上抛给调用者，成功返回真实新建的 `BackupInfo`。
  - `frontend/src/updater/AboutUpdateTab.tsx`:
    - 捕获 `backupNow()` 异常并以红色文字展示具体错误；仅在实际创建成功时才展示绿色文件路径与名称，不再用目录路径冒充成功。
- **验证**：
  - `frontend/src/updater/store.test.ts` (6 tests passed)
  - `frontend/src/updater/AboutUpdateTab.test.tsx` (2 tests passed)

### 1.8 片段 (BUG-026)
- **改动文件**：
  - `frontend/src/stores/snippetStore.ts`:
    - 双向对齐 `body` 与 `command_template`，新建/更新默认规范化为 `kind: "snippet"` 与 `body`，多行文本不丢失；
  - `frontend/src/components/SnippetBar.tsx`:
    - 读取优先使用 `snippet.body ?? snippet.command_template`；参数占位符展开正常；`execute` 模式发送末尾换行，`insert` 模式仅插入不发送换行。
- **验证**：
  - `frontend/src/stores/snippetStore.test.ts` (6 tests passed)

---

## 2. 验证命令与结果

### 2.1 全量定向单元测试 (Gemini 责任范围)
- **命令**：
  ```powershell
  pnpm --dir frontend exec vitest run src/stores/sftpStore.test.ts src/components/TransferQueueDrawer.test.tsx src/components/SftpView.test.tsx src/components/ProxyManagerModal.test.tsx src/components/PortForwardModal.test.tsx src/components/ImportExportModal.test.tsx src/stores/syncStore.test.ts src/components/SyncSettingsModal.test.tsx src/stores/aiSettingsStore.test.ts src/updater/store.test.ts src/updater/AboutUpdateTab.test.tsx src/stores/snippetStore.test.ts
  ```
- **退出码**：0
- **测试结果**：12 test files passed, 56 tests passed, 0 failed.

### 2.2 ESLint 限定检查 (Gemini 修改文件)
- **命令**：
  ```powershell
  pnpm --dir frontend exec eslint src/components/SftpView.tsx src/components/TransferQueueDrawer.tsx src/stores/sftpStore.ts src/components/ProxyManagerModal.tsx src/components/PortForwardModal.tsx src/components/ImportExportModal.tsx src/components/SyncSettingsModal.tsx src/stores/syncStore.ts src/components/settings/ai/AiModelSettings.tsx src/stores/aiSettingsStore.ts src/updater/store.ts src/updater/AboutUpdateTab.tsx src/components/SnippetBar.tsx src/stores/snippetStore.ts
  ```
- **退出码**：0
- **结果**：0 errors (3 warnings 为既有 react-hooks/exhaustive-deps).

---

## 3. 未验证部分与外部依赖（供 CEO 与 gpt 联调参考）
1. **真实 SFTP 服务端一致性 (BUG-002, BUG-006, BUG-007)**：
   - 前端已完成 `resume = false` 与恢复同一 taskId 的调用及状态响应；真实的跨端 SHA256 校验需结合 gpt 的后端 transfer 实现由 CEO 联调。
2. **后端新增 IPC 命令注册**：
   - `importer_discard_preview`: 前端已封装 fallback 调用；待 gpt 在 `backend/desktop/src/commands.rs` 中正式注册。
   - `sync_list_conflicts` / `sync_resolve_conflict`: 前端已完成契约层与组件接入；待 gpt 完成后端冲突元数据与原子解决逻辑。
3. **真实 SOCKS/HTTP 代理握手与密码提取扫描**：
   - 前端已确保 localStorage/console 零泄露，表单密码不回显；真实密钥扫描（DB/WAL/内存）需后端参与。

