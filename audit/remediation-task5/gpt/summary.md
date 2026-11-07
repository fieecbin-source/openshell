# Task 5 · gpt 定向验证记录

- 起点核对：HEAD `10a989e7e5597d1300c8ad8af1412b4ecb03ca3f`，索引为空，工作区保留 Task 4 未提交交付；本轮回执未提交、未推送、未格式化、未改 Cargo 依赖。
- 工具链：`cargo +stable-x86_64-pc-windows-msvc`，全部命令附 `--locked --offline --jobs 2`。
- 回环相关测试进程设置 `NO_PROXY=127.0.0.1,localhost`（ssh/forward）。
- 本目录只放命令输出与结论，不含任何真实凭据、用户数据库或素材。

## 命令与退出码

| 范围 | 命令 | 退出码 | 日志 |
|---|---|---|---|
| R01/R02/R12 及 app-core 全量目标 | `cargo +stable-x86_64-pc-windows-msvc test -p openshell-app-core --locked --offline --jobs 2` | 0 | `test-openshell-app-core.log` |
| R02 导入 | `cargo ... test -p openshell-importer --locked --offline --jobs 2` | 0 | `test-openshell-importer.log` |
| R03 串口 | `cargo ... test -p openshell-serial --locked --offline --jobs 2` | 0 | `test-openshell-serial.log` |
| R14 ssh（回环，NO_PROXY 隔离） | `cargo ... test -p openshell-ssh --locked --offline --jobs 2` | 0 | `test-openshell-ssh.log` |
| R14 forward 生命周期（回环，NO_PROXY 隔离） | `cargo ... test -p openshell-forward --locked --offline --jobs 2` | 0 | `test-openshell-forward.log` |

汇总（实测）：

- app-core：13 个目标共 74 项通过，0 失败（含 29 项 lib 单元测试）。
- importer：17 项通过，0 失败。
- serial：14 项通过（lib 7 + 集成 7），0 失败。
- ssh：13 项通过（lib 11 + 集成 2），0 失败。
- forward：16 项通过（lib 9 + 生命周期集成 7），0 失败。

## 逐项改动与验证

### R01 旧 SOCKS 明文口令升级（`crates/app-core/src/network_secrets.rs`、`app_services.rs`）

- 根因重现（可执行断言）：`secret_id_shape_alone_cannot_distinguish_legacy_passwords` 证明
  `SecretId::from_string("abcdefghijklmnopqrstuvwxyz")` 与 ULID 形状字符串都 `is_ok()`，
  因此旧实现“形态判断”必然把合法旧口令误判成缺失引用。
- 修复：改用 `app_meta['network_secrets.store']` 持久化迁移来源。
  - 仅在证明库内无旧明文时写入：`record_reference_store_if_clean()`（启动时调用）与
    `migrate_legacy()` 全量迁移成功后同事务写入。
  - `migrate_socks_rule`：secret 行存在且类型正确 → 通过；类型不符 → validation；
    缺失且已带标记 → 报「引用不存在，请重新保存密码」；缺失且无标记 → 按旧明文加密。
  - `forwards()` 全量迁移成功后补写标记（失败只 warn，不影响列表结果）。
- 覆盖：`abcdefghijklmnopqrstuvwxyz`、`01ARZ3NDEKTSV4RRFFQ69G5FAV`、普通明文三类旧口令一次迁移且可解密；
  真实缺失现代 ref 报错且行保持原样；错主密码失败后 `secret` 表仍为空、旧值不丢；
  触发器强制失败后整体回滚并可重试成功；完整 `AppServices::recover_legacy_network_secrets`
  启动恢复路径（含 secret-free 快照不含口令）迁移后带标记、再遇缺失 ref 报错。
- 未验证：真实用户旧库（Windows 上已有 `openshell.db` 升级）未执行；只有合成 schema 1 库与内存库证据。

### R02 FinalShell 内嵌转发认证（`crates/importer/src/finalshell.rs`、`preview.rs`）

- 修复：解析时逐条净化 `port_forwarding_list`，删除
  `socks_auth`/`socks_username`/`socks_password`/`socks_password_ref`/`password`/`passwd`/`auth_type`/`authentication_type`
  的值，并给该条目写 `import_blocked` 原因；`extract_embedded_forwards` 跳过被阻断条目，
  原始未净化列表里带认证字段的条目同样跳过，绝不生成 `SocksAuth::None` 规则。
- 预览：`generate_preview` 把 `port_forwarding_warnings` 汇入既有 `warnings`（不改 `import_blocked` 语义与去重策略）。
- 覆盖：合成 JSON（`socks_auth=socks_password=...`）；序列化后的 SessionInput 不含测试口令与引用文本；
  被阻断条目保留 `port`/`type` 等非秘密字段；预览出现「已跳过」警告；
  规则只生成未带认证的那一条；`AppServices` 落库后再读会话、`export_json`、新备份、db/wal 全部不含口令。
- 边界声明：未证明 FinalShell 真实导出字段，因此只声明「输入安全边界」，不声称能读取真实格式；
  「经 Vault 安全提取既有认证」未实现，已列入需决策事项。

### R03 串口满队列死锁（`crates/serial/src/native.rs`、`service.rs`）

- 修复：worker 去掉两处 `blocking_send`，改为「先处理全部控制消息 → `try_send` 投递 →
  队列满则保留本地待发块并停止继续 read」的反压循环（字节留在驱动缓冲，不丢字节、不伪造成功）；
  驱动错误仍以错误帧交给读取方。
- `SerialService` 改为每卡 `Arc<Mutex<SessionEntry>>`：全局表锁只用于取/放条目，后端 `await`
  只持本卡锁；`close` 先摘除条目再关停，其他卡片不再被连带阻塞。新增 `#[doc(hidden)] open_with_backend` 测试注入点。
- 覆盖：容量 1 的 RX 队列填满且设备仍有数据时，`write`/`GetModem` 均在 2s 内有界返回；
  反压期间字节按序完整到达；`is_open=false` 后 worker 有界退出；一卡 mock 阻塞时另一卡读写/控制线/close 有界完成，
  被摘除的卡片立即返回 `NotConnected`。

### R12 导入门禁（`crates/app-core/tests/m3_integration_and_load_test.rs`）

- 保留 BUG016 现行语义：`db-internal`（ProxyJump）必须 Skip 且 `protocol_options_json.import_blocked` 含 `ProxyJump`，
  预览 `warnings` 也包含该原因；仅提交非 Skip 候选，断言被阻断会话从未以直连形式落库。
- 新增独立有效会话 `cache`，使报告 `total=3 / new=2 / skip=1`，并保住两条有效会话的 `.osvault` 加密导出/解密回环与错口令必失败。
- `cargo test -p openshell-app-core` 全量目标 exit 0（74 项通过），不再停在 m3 导入测试。

### R14 远端转发停止语义（`crates/ssh/src/handler.rs`、`connection.rs`、`crates/forward/tests/lifecycle.rs`）

- 结论：产品「停止」应结束该规则，包含已建立的 relay。
- 修复：路由值改为 `RemoteRoute { dest, cancel: watch::Sender<bool> }`；
  `server_channel_open_forwarded_tcpip` 的 relay 用 `select!` 同时等待双向复制与取消；
  `stop_remote_forward` 先移除路由并广播取消（已建立隧道两端 EOF），再 `cancel_tcpip_forward` 撤销服务端监听；
  连接 `close()` 与健康检查失联清理改为 `cancel_all_remote_routes`（先取消再清表）。
- 测试夹具修正：进程内 SSH 服务器在 `cancel_tcpip_forward` 后保留既有子通道（与真实 OpenSSH 一致），
  否则服务端自身断开会遮蔽客户端缺陷。
- 新增用例 `stopping_remote_rule_ends_established_relay_but_keeps_other_rules`：远端 echo 建立 → `stop_rule` →
  已建立 socket 读到 EOF；同时本地规则的连接继续回环成功。
- 既有断言全部保留并通过：`rejected_remote_cancellation_preserves_error_and_can_retry`、
  `stopping_remote_rule_releases_server_listener`、BUG014 的监听释放与断连用例。
- 边界：这是 BUG014 之外的**新增**边界（BUG014 只要求 SSH 断开释放监听），不把它当作 BUG014 的唯一验收标准。

## 未验证范围（整体）

- 真实硬件串口：热插拔、真实 RX 反压、DTR/RTS 电平只做了假设备与 mock 验证。
- 真实 RDP 成功登录、真实 X Server、真实第三方 SSH 服务端（仅进程内 russh 夹具）。
- 真实 FinalShell 导出文件格式与真实旧用户库升级（只有合成 JSON / 合成 schema 1 库）。
- 前端、desktop 命令层、workspace 全量 test/clippy/fmt 未执行（按任务书由 CEO 在停止编辑后集中执行）。

## 可独立提交批次（文件组，员工未提交）

1. 安全存储/旧库迁移：`backend/crates/app-core/src/network_secrets.rs`、
   `backend/crates/app-core/src/app_services.rs`、`backend/crates/app-core/tests/network_recovery_test.rs`、
   `backend/crates/app-core/tests/network_secrets_test.rs`。
2. 导入防线：`backend/crates/importer/src/finalshell.rs`、`backend/crates/importer/src/preview.rs`
   （R02 的落库/导出/备份断言放在批次 1 的 `network_secrets_test.rs`，两批需一起通过；也可把该用例单独挪到批次 2 需要的测试文件）。
3. 串口与终端：`backend/crates/serial/src/native.rs`、`backend/crates/serial/src/service.rs`（无调用者签名变化）。
4. 远端转发：`backend/crates/ssh/src/handler.rs`、`backend/crates/ssh/src/connection.rs`、
   `backend/crates/forward/tests/lifecycle.rs`（依赖批次 3 之后的测试基线，可独立评审）。
5. 门禁修正：`backend/crates/app-core/tests/m3_integration_and_load_test.rs`（依赖批次 1、2 的语义）。
