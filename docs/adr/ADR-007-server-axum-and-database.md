# ADR-007：服务端框架与数据库选型

- 状态：已接受（M1）
- 日期：2026-10-21
- 关联：`docs/architecture.md` §11、§3；ADR-006；`spec/sync-api.md`

## 背景

需要交付一个**用户自行部署**的服务端，提供：账号与设备、端到端加密同步（只存密文）、更新清单分发、可选中继、限流/审计/健康检查/指标。部署目标是"单机 Docker Compose + Caddy"，默认单用户自用；多用户是配置开关。

约束：

- Rust 单二进制，启动快、内存占用低；
- 迁移可管理，备份简单；
- 默认零外部依赖（不强制用户装 Postgres）；
- 将来可平滑支持多用户/多租户；
- 与客户端共享线协议类型（`crates/sync-protocol`）。

## 选项（框架）

| 维度 | axum | actix-web | warp | poem |
|---|---|---|---|---|
| 生态与中间件 | 强（tower） | 很强 | 中 | 中 |
| 类型化提取器 | 好 | 好 | 一般 | 好 |
| 与 tokio/tower 组合 | 原生 | 独立运行时 | 原生 | 原生 |
| 学习/维护成本 | 低 | 中 | 中 | 低 |
| 单二进制体积 | 小 | 中 | 小 | 小 |

## 选项（数据库）

| 维度 | SQLite（sqlx） | PostgreSQL（sqlx） |
|---|---|---|
| 部署依赖 | 无（文件） | 独立服务 |
| 并发写 | 单写者 | 多写者 |
| 运维 | 备份 = 复制/`.backup` | 需备份/升级/连接池调优 |
| 多用户/多租户 | 可（单机规模） | 更合适 |
| 事务/索引/JSON | 足够 | 更强 |
| 用户成本 | 最低 | 中 |

## 决策

- **框架：axum + tokio + tower/tower-http**。
- **数据库：默认 SQLite（sqlx，WAL，单写者）；`--features postgres` 编译期切换 PostgreSQL**，运行期由 `DATABASE_URL` 选择。
- **默认单用户**：首次启动用一次性引导令牌（`BOOTSTRAP_TOKEN` 环境变量）创建唯一账号；之后注册接口返回 `403`，除非 `ALLOW_REGISTRATION=true`。
- **认证**：密码 Argon2id（服务端参数独立），访问令牌 JWT EdDSA（15 min，`sub`/`did`/`sid`/`iat`/`exp`/`ver`），刷新令牌 32 字节随机 Base64url、服务端仅存 SHA-256、30 天滑动轮换（旧令牌 60 s 宽限），检测到重复使用即吊销整个会话族并返回 `TOKEN_REVOKED`。
- **API 版本化**：路径前缀 `/v1`；`sync-protocol` 定义 DTO 与错误码，客户端/服务端共用。
- **运维端点**：`/healthz`（存活）、`/readyz`（DB 可用）、`/metrics`（Prometheus，默认仅内网/Caddy 保护）。
- **限流**：按 IP + 账号双维度；登录失败指数惩罚；同步提交按设备限速。
- **可选中继**：`relay/` 模块存在但默认编译关闭（feature `relay`），启用需显式配置与设备白名单。

## 理由

1. axum 与客户端同用 tokio/tower 生态，团队与 agent 心智一致；中间件（请求 ID、超时、限流、trace）可直接复用。
2. 单用户自用场景下强制 Postgres 会显著提高部署门槛（用户目标是一键 `docker compose up`）；SQLite 在"单机、低并发、密文记录"下完全够用。
3. 通过 sqlx 的编译期查询检查 + 离线模式（`.sqlx`），SQLite 与 Postgres 可共享大部分仓储代码，迁移成本可控。
4. 单用户默认 + 引导令牌，避免公网暴露注册接口被滥用；多用户只需打开开关。
5. 更新清单与同步共用服务端，减少用户维护面；对象存储可选（清单可 302 到外部 URL）。

不选 actix-web 的理由：独立运行时/生态与客户端不一致，且没有明显收益。
不选"只支持 Postgres"的理由：违背"用户自行部署、一键启动"的交付目标。
不选"只支持 SQLite"的理由：多用户/大规模场景会受限，保留 Postgres 作为编译特性是低成本保险。

## 后果

**正面**

- 部署面最小：一个容器 + 一个卷 + Caddy；备份即文件复制。
- 客户端/服务端共享协议类型，契约漂移风险低。
- 单用户默认安全姿态明确。

**负面与缓解**

| 后果 | 缓解 |
|---|---|
| SQLite 单写者在多用户/高并发下成为瓶颈 | 文档明确单用户定位；多用户启用 Postgres；指标监控 `db_write_wait_seconds` |
| 双数据库需维护两套迁移 | 迁移 SQL 限定在两者交集（避免 SQLite 专有语法）；CI 双跑迁移与仓储测试 |
| sqlx 编译期查询需要数据库 | 使用 `SQLX_OFFLINE=true` + 提交 `.sqlx`；CI 校验离线元数据不过期 |
| JWT 泄露窗口 | 15 min 短令牌 + 刷新令牌旋转 + 设备吊销列表（`jti` 黑名单 TTL 15 min） |
| 公网被扫描 | 默认关闭注册；登录限流；Caddy 只暴露 80/443；fail2ban/防火墙写入 `deploy/README.md` |
| 中继成为滥用入口 | 默认关闭；需显式设备白名单 + 速率限制 + 全程审计；不提供 UDP |

## 数据模型（服务端最小集）

| 表 | 关键列 |
|---|---|
| `account` | `id, email UNIQUE, password_hash, created_at, disabled_at` |
| `device` | `id, account_id, name, platform, arch, public_key?, created_at, last_seen_at, revoked_at` |
| `refresh_token` | `id, account_id, device_id, token_hash, expires_at, rotated_from, revoked_at` |
| `vault` | `vault_id, account_id, schema_version, crypto_suite, kdf_json, wrapped_key, key_check, key_version, head_seq, created_at`（不存任何解密材料） |
| `key_slot` | `vault_id, key_version, kdf_json, wrapped_key, key_check, created_at, retired_at`（旧 `key_version` 保留 30 天） |
| `record` | `vault_id, record_id, version, ciphertext, checksum, size, deleted, deleted_at, updated_at, device_id`；`PRIMARY KEY(vault_id, record_id)` |
| `record_history` | 同上 + `valid_from_seq, valid_to_seq`（保留 50 版或 90 天，取先到者） |
| `commit` | `vault_id, seq, device_id, change_count, created_at, kind(normal/snapshot_restore)`；`seq` 严格单调无空洞 |
| `snapshot` / `snapshot_record` | `snapshot_id, vault_id, label, record_count, bytes, manifest_checksum, created_at, device_id` / `snapshot_id, record_id, ciphertext, checksum, deleted`（最多 20 个快照、总量 ≤ 256 MiB） |
| `idempotency_key` | `account_id, method, path, key, request_hash, status, response_json, expires_at`（24 h） |
| `update_manifest` | `target, channel, version, manifest_json, signature, signing_key_id, published_at, rollout_percent, revoked` |
| `audit_event` | `id, account_id, device_id, type, ip_hash, at, metadata_json` |

`record.version` 由服务端事务内自增；`commit` 在单事务内校验 `base_version`、写入新版本、追加 `record_history`、分配单调 `seq`、返回 `new_cursor`。墓碑即 `record.deleted=1` + `deleted_at`，90 天后随记录物理清除。

## 验证与退出条件

- `docker compose up` 后 60 s 内 `/readyz` 返回 200。
- 单用户流程 e2e：引导创建 → 登录 → 提交/拉取 → 双设备冲突 → 设备吊销 → 更新检查。
- 压测（单机 SQLite）：10 设备、1000 记录、每分钟 60 次增量提交，p95 < 200 ms；若持续超过 500 ms，文档引导启用 Postgres。
- 若多用户成为正式需求（Q10），默认数据库切换为 Postgres，SQLite 变为开发/单用户选项；需新 ADR。
