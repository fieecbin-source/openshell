# Task 7 · gpt 绿测与交付证据（2026-11-07）

身份：员工1 gpt。分支 `Fce/task7-integration`，完整 HEAD `1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`（收尾复核未变）。未 add / commit / push / 切分支 / stash pop / 恢复旧基线；他人增量原样保留。

## 最终绿测（只跑受影响模块）

| 命令 | 退出码 | 结果 | 日志 |
|---|---:|---|---|
| `cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-app-core --locked --offline --jobs 2 --lib --test network_recovery_test --test network_secrets_test --test sync_lifecycle_test --test archive_roundtrip_test` | **0** | 60 passed / 0 failed：`--lib` 29、network_recovery 10、network_secrets 2、archive_roundtrip 10、sync_lifecycle 9 | `green-app-core-final.log/.exitcode` |
| `cargo.exe +stable-x86_64-pc-windows-msvc test -p openshell-desktop --locked --offline --jobs 2 --lib` | **0** | 39 passed / 0 failed，含 7 项 `vault_recovery` 编排用例、2 项 forward 路由用例、1 项启动分支判定用例 | `green-desktop-final.log/.exitcode` |
| `pnpm exec vitest run src/stores/forwardStore.test.ts src/components/PortForwardModal.test.tsx src/components/ProxyManagerModal.test.tsx --reporter=dot`（`frontend/`） | **0** | 3 files / 16 tests passed | `green-frontend-final.log/.exitcode` |
| `pnpm exec tsc --noEmit --pretty false`（`frontend/`） | **0** | 0 errors | `tsc-final.log/.exitcode` |

补充的定向绿测（修复过程中，均为 0）：`green-app-core-sync.log`（sync 红测转绿 1 passed）、`green-app-core-rest.log`（app-core 其余目标）、`green-desktop-routes.log`（2 项路由级补录闭环）、`green-frontend-all.log`、`tsc.log`、`compile-app-core.log`、`compile-desktop.log`。

## 红测（修复前，真实断言失败）

见 `red-evidence.md`：`red-app-core-network` 101、`red-app-core-sync` 101、`red-frontend` 1。四类根因：整表失败、sync 全库预检、启动恢复仅主密码无逐条补录、前端吞错与补录入口不可达。

## 中间诊断记录（如实保留，均已处置）

| 日志 | 退出码 | 原因 |
|---|---:|---|
| `green-app-core-network.log/.exitcode` | 101 | 第一项红测转绿后 `startup_recovery_offers_only_safe_per_rule_reentry_metadata` 仍红（`details: None`），属修复过程中的真实断言失败；最终由 `green-app-core-final` 覆盖为通过 |
| `green-desktop-recovery-base.log/.exitcode` | 101 | `vault_recovery.rs` 误从 `openshell_core_domain` 导入 `AppServices`（实际在 `openshell_app_core`），已修正 |
| `compile-schema1.log/.exitcode` | 101 | 默认 `x86_64-pc-windows-gnu` 工具链的 `x86_64-w64-mingw32-gcc`（llvm-mingw/clang）缺 `-lgcc_eh` / `-lgcc`，链接 proc-macro 失败；环境问题，与代码无关。按 `gpt1.md` 要求统一改用 `+stable-x86_64-pc-windows-msvc`（与 trae 回执记录一致），未改环境、未加 allow/skip |

## 真实覆盖

- 安全枚举 / 运行校验分离：A 好 B 坏列表、A 目标启动、B 拒绝运行、原行不被读改坏、未知 ref 不回传；`forwards_strict` 保留给含秘密导出。
- 现代库补录：`forward_update_impl` → `prepare_forward(Some(id))` 显式新口令 → vault secret → 重读与目标启动可用；代理同类路径不倒退。
- schema1：正确 / 错误主密码、3 条规则逐条补录、取消保留、少一条 / 空口令 / 重复规则混合失败整事务回滚、取消后可重试、备份与导出无明文。
- 启动编排：`needs_legacy_recovery` 判定、Windows 注入式 `recover_with_reentry` 的 Apply / Cancel / 错误主密码 / 干净库跳过、UTF-16 解码、提示仅安全元数据。
- 同步与导出：`sync` 不再被无关全库预检阻断且 Task6 history / 认证 / 图事务断言 9 项全绿；metadata 导出不被坏引用卡死，含秘密导出仍拒绝缺失依赖（10 项全绿）。
- 前端：store 不吞错、mutation 成功与刷新失败分离、重试仅重读、代次防旧异步污染、需补录提示与强制显式输入、仅布尔回显。

## 未验证（不假报通过）

- 真实 Windows CredUI 图形弹窗交互、真实 Tauri 进程在 webview 创建前的端到端启动恢复、真实旧库安装升级：无交互图形环境；仅覆盖可注入编排、判定函数与 AppServices 真实库恢复矩阵。
- 非 Windows 平台：无环境，仅验证明确 `Unsupported` 与可操作路径文案。
- 真实远程同步服务、真实硬件与图形入口、全仓 lint / clippy / build / 全量测试：按 main.md 交 CEO 集中联验。
- `backend/crates/store` 未改动，其独立测试未单独运行；迁移与备份链由 app-core 恢复矩阵间接覆盖。

## 环境与纪律

- Rust 定向命令统一 `cargo.exe +stable-x86_64-pc-windows-msvc`（Cargo 位于本机安装目录），`--locked --offline --jobs 2`；前端为 `pnpm exec`。
- 未使用 timeout / skip / allow / 删断言 / 吞错制造通过；未加 `any`、未新增依赖、未改锁文件。
- 清理了 vitest 残留的 `frontend/vite.config.ts.timestamp-*.mjs` 临时文件。
