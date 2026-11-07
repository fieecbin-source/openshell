## 员工1：gpt

状态：S02/S08 本轮定向修复及门禁通过；S01 静默凭据损坏已修，但完整恢复仍有 P1，不能判整个 S01 或 Task6 通过。未暂存、未提交、未推送。

开工基线：`Fce/task6-integration@9b05523777b38d5f1e1653abf9b57449f88c18cc`。开工已有 `aiSettingsStore.ts`、`syncStore.ts`、`updater/AboutUpdateTab.test.tsx`、`updater/store.test.ts` 修改，均保留；后续 gemini/trae 源码和回执也保留。只记录相对该基线新增 diff，没有恢复旧 patch/stash、reset/切回旧远端，没有改依赖、锁文件、schema、共享 IPC/DTO 或已推送的 importer/serial/AI/SFTP 实现。

改动清单：

- `backend/crates/app-core/src/network_secrets.rs`：SOCKS 只验证有效秘密引用；缺 marker 不再作为明文证据，缺失/软删除/来源不明时报错并保留原值；标记探测也排除 tombstone。代理明确的 `password` 字段仍事务迁移。
- `backend/crates/app-core/tests/network_recovery_test.rs`：真实创建引用后删除 marker/secret 的启动、恢复回归；覆盖硬删除、tombstone、混合代理明文、schema1 已引用快照、错主密码、明确补录及事务失败重试。原普通/26字母/ULID 口令解密一致、快照无秘密断言保留，改为明确补录后验证，不伪装自动来源识别。
- `backend/crates/app-core/src/sync_service.rs`、`sync_codec.rs`、`tests/sync_lifecycle_test.rs`：认证全部历史后按最高 revision 成对选 record/envelope，补逐条元数据校验；graph/conflict/dirty/revision/tombstone 和 cursor 同事务。公开函数签名、依赖校验和冲突恢复保持。
- `backend/crates/app-core/src/app_services.rs`：来源注释修正；同一个 `backup_retention_tests` 模块原样移到生产项之后，两项测试未删改。
- `backend/crates/forward/tests/lifecycle.rs`：保留4秒释放阈值，等 closed 信号并用重新 bind 确认监听释放，再断言真实 connect 拒绝；保留 pending EOF、其他规则隔离和远端既有 relay EOF。未改 forward/ssh 生产代码。
- `scripts/check-package.mjs`、`scripts/check-package.test.mjs`：复用已声明的 TypeScript parser，修正正则引号造成的递归边界误报；保留 YAML 连字符键、注释、转义/序列化真秘密和私钥/文件/指纹检测；未增加依赖。

关键实现说明：

- **S01**：主密码只能解锁保险库，不能证明旧 `socks_password_ref` 是明文。没有可靠来源时保留并拒绝，不能把真实 ref 加密为错误密码。现有 `prepare_forward` 密码输入可明确补录三类口令；恢复遇到不确定 SOCKS 旧值时，同事务内代理转换也回滚。补录成功证据在 API 层，不能据此宣称 UI 已可恢复。
- **S02**：真实服务返回 `record_history`；旧客户端累计全部版本却按 ID 覆盖 envelope，并应用旧 forward 导致删除秘密引用失败。现改为每条解密认证、核对 ID/type/revision/schema/device/deleted/时间/size/cursor 等后，按最高 revision 同时选记录和 envelope，不依赖客户端时间，也不因存在新版本而接受旧版篡改。复查发现的游标后置提交也已移入同事务。
- **S08**：原 Task5 失败没有原样重现，原单例和整个 forward 在本机均通过；合成探针明确证明监听约0.025秒释放、约0.040秒可重新 bind，旧 connect 混合采样仍可因 Windows 拒绝耗时触发4秒假超时。只修释放观测，不声称发现产品监听泄漏；没有扩大超时或去掉真实拒连/EOF断言。

自测结果（命令/退出码/证据）：

以下 Cargo 均为 `cargo +stable-x86_64-pc-windows-msvc`，统一带 `--locked --offline --jobs 2`；HTTP 回环只在测试子进程设置 `NO_PROXY/no_proxy=127.0.0.1,localhost`。证据位于 `audit/remediation-task6/gpt/`；完整命令见各 summary 和 `forward-verification.json`。

| 命令/目标 | 退出码 | 结果与证据 |
|---|---:|---|
| `test -p openshell-app-core --test network_recovery_test pre_marker_missing`，修复前 | 101 | 真实 ref 缺失后恢复仍成功，静默存错密码；`s01-red.log` |
| `test -p openshell-app-core --test sync_lifecycle_test history_catch_up_keeps_latest_forward_and_matching_conflict_envelope`，两次红例 | 101 / 101 | 旧 forward 依赖失败、旧时间元数据篡改被接受；`sync-history-red.log`、`sync-history-metadata-red.log` |
| 同一 history 目标，cursor 触发器红例 | 未回收 | `sync-cursor-red.log` 为0过1失败：错误后已保存 `latest`，而非 `offline-local`。worker 中断前未回收进程退出码，不虚构退出码 |
| `test -p openshell-app-core`，最终版 | 0 | **77通过、0失败、0 ignored**，含游标 INSERT/UPDATE 回滚、history 与恢复/归档；`app-core-tests-final.log`。前一轮完整目标也77过，见 `app-core-tests.log` |
| `test -p openshell-forward --test lifecycle server_disconnect_releases_all_rule_types_and_pending_handshakes -- --nocapture` | 0 | 1通过；`forward-green-single.log` |
| `test -p openshell-forward -- --nocapture` | 0 | 16通过；`forward-green-full.log` |
| `test -p openshell-forward -p openshell-ssh -- --nocapture` | 0 | 正常并行组合29通过，0失败/ignored；`forward-green-ssh-parallel.log` |
| `clippy -p openshell-app-core --all-targets -- -D warnings` | 0 | `app-core-clippy-final.log` |
| `clippy -p openshell-forward -p openshell-ssh --all-targets -- -D warnings` | 0 | 两crate相关完整目标；`forward-clippy.log` |
| `node --test scripts/check-package.test.mjs`，最终版 | 0 | 7通过、0失败/skip；`package-review-green.log`。原误报/转义键以及 review 的 YAML/注释漏检红例日志保留 |
| `node scripts/check-package.mjs frontend/dist` | 0 | 隔离 APPDATA/HOME/USERPROFILE，真实当前 dist 35文件；`package-review-dist.log`。未读用户库或输出候选秘密 |
| 7个改动Rust文件 `rustfmt --edition 2021 --check`；两脚本 `node --check`；白名单 `git diff --check` | 0 / 0 / 0 | Rust格式见 `rustfmt-final.log`；无全仓格式化 |

完整细节见 `s01-summary.md`、`sync-summary.md`、`forward-summary.md`、`package-summary.md`、`review-summary.md`；9个白名单源码文件的本轮 diff 为 `task6-gpt.diff`。

验证范围（逐S编号）：

- **S01**：真实 pre-marker 引用库、现代 marker、混合库、schema1 引用快照缺 secret 均拒绝，不增错秘密、不改原 ref；三种形状口令明确补录后解密一致，正确主密码恢复可继续；锁库/错密码/触发器失败不丢旧值、可重试。后端补录通过，完整 S01 未关闭。
- **S02**：真实 HTTP 服务和数据库保留 **509条 history、501个填充会话、3版 forward**，跨500项分页；两次换密并删除旧 secret，客户端时间 `1→20→10` 仍选 revision3。验证两条 tombstone、唯一最新冲突及对应 envelope、本地副本、dirty/revision、游标/冲突故障原子回滚、冲突恢复、不重复上传；11种旧历史篡改均拒绝，恢复原记录后普通同步成功。
- **S08**：单例、完整 forward、正常并行 SSH 组合及两组 all-targets Clippy 通过；监听隔离、远端取消拒绝/重试和既有 relay EOF 保持。包扫描保留原4组断言，新增安全JS边界、真秘密/转义/序列化/YAML/注释/私钥/指纹覆盖，真实当前 dist 通过。

未验证部分：

- workspace 全量 test/check/clippy/fmt 和全前端门禁由 CEO 集中执行；没有用本轮定向结果覆盖 Task5 旧失败报告。
- 真实用户旧库/备份的 UI 恢复、外部 SSH 断链、真实串口/RDP/X Server、跨OS、安装升级未验证；未重建 dist、未扫描安装包。

验收对照：

- 本轮9个源码/测试文件均属 gpt 白名单，无共享 IPC/DTO、依赖/锁文件、schema 变更，保留其他员工源码和回执。
- 无 skip/allow、删除既有安全断言、吞错、重复提交或扩大超时；来源不明时明确拒绝，不把恢复限制伪称通过。
- 独立复查的扫描器漏检与游标事务缺口已修并补回归，没有把中断 worker 或单元数量当作协议/发布验收。

范围外发现（未处理）：

- **S01/P1**：`forward_list` 全量调用 `forwards(None)`，`forward_start` 也先校验全库。一条缺 ref 会挡住列表/编辑入口和其他完好规则启动。`prepare_forward` 修复证据仅在 API 层，用户未必能从界面进入；schema1 安全快照失败时也进不了普通编辑页。desktop/前端不在本员工白名单，未跨界修改。

遗留问题与风险：

- 来源不明的旧 SOCKS 值会保留并报错，需后续明确补录/秘密备份恢复入口。**S01 保持 P1，不能按完整迁移修复通过推送。**
- 包扫描需要仓库已有 TypeScript 开发依赖；未声明能识别任意混淆或压缩安装包内容。

需要CEO决定的事：

- 单独安排 S01 desktop/前端范围：分开脱敏元数据列表和单规则运行校验，利用已有密码保存接口按规则补录，并提供 schema1 明确确认/补录入口。列表不可返回来源不明的原 `socks_password_ref`，它可能是旧明文。涉及恢复契约的部分按 main.md 另排 L3，不以主密码或字符串形状推断来源。
- 停止并行编辑后集中门禁，按独立暂存内容验收；本地保全基线及本回执均不代表上线或发布通过。

可独立提交组和依赖：

1. **S01安全组（P1未关闭）**：`network_secrets.rs`、`tests/network_recovery_test.rs`、`app_services.rs` 来源注释 hunk；与 S02 无新增依赖，须连同恢复限制审查。
2. **S02历史/事务组**：`sync_service.rs`、`sync_codec.rs`、`tests/sync_lifecycle_test.rs`，三者同批验证；依赖既有基线同步实现。
3. **Clippy门禁组**：`app_services.rs` 测试模块移动 hunk，可与来源注释分开暂存；两测试原样保留。
4. **转发门禁组**：`backend/crates/forward/tests/lifecycle.rs`，无 S01/S02 新增依赖，不改生产协议。
5. **包扫描组**：`scripts/check-package.mjs`、`scripts/check-package.test.mjs`，同批验证，使用已有前端 TypeScript 环境。
