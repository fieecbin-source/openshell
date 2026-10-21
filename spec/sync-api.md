# 同步与分发 API 规格（Sync API Specification）

| 项 | 值 |
|---|---|
| 文档编号 | SPEC-API-001 |
| 版本 | 1.0（M1 冻结） |
| 协议 | HTTPS + JSON（UTF-8）；可选 WebSocket 中继 |
| 基础路径 | 应用 API：`/v1`；更新：`/updates`；运维：根路径 |
| 服务端实现 | Rust（axum + tokio + SQLite/PostgreSQL），单二进制 + Docker Compose |
| 交付要求 | 必须生成 OpenAPI 3.1 文档；本文件为契约权威来源 |
| 洁净室声明 | 全部端点、字段、错误码、冲突模型均为本项目自设计；不复制任何第三方协议、字段名或加密方案。 |

## 1. 通用约定

### 1.1 传输与编码

| 项 | 约定 |
|---|---|
| TLS | 必须 HTTPS；最低 TLS 1.2，优先 1.3；HSTS `max-age=31536000` |
| 请求/响应 | `Content-Type: application/json; charset=utf-8`；二进制上传用 `application/octet-stream` |
| 字段命名 | `snake_case` |
| 时间 | ISO-8601 UTC，毫秒精度，如 `2026-10-21T12:00:00.000Z` |
| ID | 不透明字符串（ULID），长度 ≤ 40；服务端不得解析其内容 |
| 二进制字段 | Base64（标准字母表，无换行） |
| 最大请求体 | 16 MiB（快照分段上传除外，见 §6.4） |
| 压缩 | 支持 `Content-Encoding: gzip`；响应可按 `Accept-Encoding` 压缩 |
| 版本协商 | 客户端发送 `X-Api-Version: 1`；服务端不支持时返回 `426 UPGRADE_REQUIRED` |

### 1.2 认证头

| 头 | 必填 | 说明 |
|---|---|---|
| `Authorization: Bearer <access_token>` | 除注册/登录/健康检查外必填 | 短期 JWT（EdDSA/Ed25519），有效期 15 分钟 |
| `X-Device-Id` | 登录后的所有请求 | 设备 ID，必须与令牌 `did` 声明一致，否则 `403 DEVICE_MISMATCH` |
| `X-Api-Version` | 是 | 固定 `1` |
| `Idempotency-Key` | 见各端点 | 客户端生成的 UUIDv4；服务端保留 24 小时 |
| `X-Request-Id` | 否 | 客户端链路追踪 ID；响应回显 `request_id` |
| `X-Install-Id` | 仅更新检查 | 匿名安装标识（随机 UUID，本地生成，不含账号信息） |

### 1.3 错误响应

```json
{
  "error": {
    "code": "SYNC_CONFLICT",
    "message": "one or more records conflict with the current version",
    "details": { "conflicts": [ { "record_id": "01J...", "server_version": 42 } ] },
    "request_id": "req_01J...",
    "retry_after": null
  }
}
```

### 1.4 错误码

| HTTP | `code` | 含义 | 客户端行为 |
|---:|---|---|---|
| 400 | `INVALID_REQUEST` | 语法/参数错误 | 修正请求，不重试 |
| 401 | `UNAUTHENTICATED` | 缺少或无效令牌 | 尝试刷新；失败则重新登录 |
| 401 | `TOKEN_EXPIRED` | 访问令牌过期 | 刷新令牌后重试一次 |
| 401 | `TOKEN_REVOKED` | 令牌被吊销/重用检测 | 强制重新登录，提示设备可能被吊销 |
| 403 | `FORBIDDEN` | 无权限 | 不重试 |
| 403 | `DEVICE_REVOKED` | 设备已吊销 | 停止同步并提示 |
| 403 | `DEVICE_MISMATCH` | 设备 ID 与令牌不符 | 重新登录 |
| 403 | `REGISTRATION_CLOSED` | 单用户模式已存在账号 | 改为登录 |
| 403 | `RELAY_DISABLED` | 中继未启用 | 提示管理员启用 |
| 403 | `DESTINATION_NOT_ALLOWED` | 中继目标不在允许列表 | 提示目标被策略拒绝 |
| 404 | `NOT_FOUND` | 资源不存在（含软删除） | 刷新本地状态 |
| 405 | `METHOD_NOT_ALLOWED` | 方法错误 | 修正 |
| 409 | `SYNC_CONFLICT` | 记录版本冲突 | 进入冲突解决流程 |
| 409 | `ACCOUNT_EXISTS` | 账号已存在 | 改为登录 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一幂等键请求体不同 | 生成新键 |
| 409 | `SNAPSHOT_EXISTS` | 快照标签或 ID 冲突 | 更换标签 |
| 412 | `PRECONDITION_FAILED` | `If-Match`/游标前置条件失败 | 重新拉取后重试 |
| 413 | `PAYLOAD_TOO_LARGE` | 单条记录或请求过大 | 拆分或压缩 |
| 422 | `VALIDATION_FAILED` | 字段校验失败（含 `details.fields`） | 修正字段 |
| 426 | `UPGRADE_REQUIRED` | API 版本不支持 | 提示升级客户端 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避 |
| 429 | `QUOTA_EXCEEDED` | 存储/记录/设备/快照配额超限 | 暂停同步，提示清理 |
| 500 | `INTERNAL` | 未预期错误 | 指数退避重试（最多 5 次） |
| 503 | `UNAVAILABLE` | 维护/依赖不可用 | 按 `Retry-After` 重试 |
| 504 | `UPSTREAM_TIMEOUT` | 中继上游超时 | 关闭隧道并重试 |

### 1.5 幂等与重试

| 规则 | 说明 |
|---|---|
| 幂等键作用域 | `(account_id, method, path, Idempotency-Key)`；24 小时内返回首次响应（含状态码与体） |
| 同键不同体 | `409 IDEMPOTENCY_KEY_REUSED` |
| 可重试状态码 | 408/425/429/500/502/503/504；遵循 `Retry-After` |
| 不可重试 | 400/401（除刷新后重试一次）/403/404/409（业务冲突）/413/422 |
| 提交重试 | `POST /sync/commit` 必须携带幂等键；网络超时后应使用同一键重试 |
| 顺序 | 同一设备同一时刻只允许 1 个 in-flight commit；服务端按到达顺序分配序号 |

### 1.6 限流

| 范围 | 默认限制 | 超限 |
|---|---|---|
| 注册/登录 | 10 次/分钟/IP；登录失败 5 次后 15 分钟锁定该 IP+账号 | 429 `RATE_LIMITED` |
| 刷新令牌 | 60 次/分钟/设备 | 429 |
| 同步提交 | 120 次/分钟/设备；单次 ≤ 500 条变更 | 429 或 413 |
| 同步拉取 | 120 次/分钟/设备 | 429 |
| 快照 | 10 次/小时/账号 | 429 |
| 更新检查 | 60 次/分钟/IP | 429 |
| 中继票据 | 30 次/分钟/设备；并发 2 | 429 `RATE_LIMITED` |
| 健康/指标 | 600 次/分钟/IP | 429 |

---

## 2. 账号与认证（API-AUTH）

### 2.1 端点总表

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-AUTH-01 | `POST /v1/auth/register` | 无 | 建议 | `email`(string,必填,≤254)、`password`(string,必填,10–128)、`device_name`、`device_platform`(`windows/macos/linux`)、`device_arch`(`x86_64/arm64`)、`device_public_key`(Base64)、`invite_code`(可选) | `201`：`account_id`、`access_token`、`access_expires_at`、`refresh_token`、`refresh_expires_at`、`device_id` | 409 `ACCOUNT_EXISTS`、403 `REGISTRATION_CLOSED`、422 `VALIDATION_FAILED` |
| API-AUTH-02 | `POST /v1/auth/login` | 无 | 建议 | `email`、`password`、`device`{`id`(可选)、`name`、`platform`、`arch`、`public_key`、`app_version`} | `200`：同注册 + `account`{`id`,`email_masked`,`created_at`} | 401 `UNAUTHENTICATED`、403 `DEVICE_REVOKED`、429 |
| API-AUTH-03 | `POST /v1/auth/refresh` | 无（用刷新令牌） | 必须 | `refresh_token`、`device_id` | `200`：新的 `access_token`、`refresh_token`（轮换）、过期时间 | 401 `TOKEN_EXPIRED`/`TOKEN_REVOKED`、403 `DEVICE_REVOKED` |
| API-AUTH-04 | `POST /v1/auth/logout` | Bearer | 必须 | `refresh_token`（可选）、`all_devices`(bool,默认 false) | `204` 无体 | 401 |
| API-AUTH-05 | `POST /v1/auth/password` | Bearer | 必须 | `current_password`、`new_password` | `204`；其他设备刷新令牌全部失效 | 401、422 |
| API-AUTH-06 | `GET /v1/account` | Bearer | — | — | `200`：`account_id`、`email_masked`、`created_at`、`last_login_at`、`quota`{`bytes_used`,`bytes_limit`,`records_used`,`records_limit`,`devices_used`,`devices_limit`,`snapshots_used`,`snapshots_limit`}、`features`{`relay_enabled`,`multi_user`,`registration_open`} | 401 |

### 2.2 令牌语义

| 令牌 | 形态 | 有效期 | 存储 | 撤销 |
|---|---|---|---|---|
| Access token | JWT，EdDSA 签名；声明：`sub`(account_id)、`did`(device_id)、`sid`(会话族)、`iat`、`exp`、`ver` | 15 分钟 | 客户端内存（或加密存储） | 设备吊销/密码修改后立即失效（服务端维护 `token_epoch`） |
| Refresh token | 32 字节随机，Base64url；服务端仅存 SHA-256 哈希 | 30 天，滑动轮换 | 客户端保险库内的 token 存储 | 轮换后旧令牌立即失效；检测到重复使用 → 吊销整个会话族并返回 `TOKEN_REVOKED` |

规则：
- 每个刷新令牌绑定 `device_id`；换设备不可复用。
- 刷新采用轮换：每次刷新返回新 refresh token，旧的在 60 秒宽限后失效（容忍网络重试）。
- 登出 `all_devices=true` 需要再次输入密码（或 15 分钟内的最近认证）。
- 服务端记录 `token_epoch`；设备吊销或密码修改时递增，使所有旧 access token 失效。
- 账号密码与保险库主密码**完全独立**：API 从不接收、不存储、不派生任何与主密码相关的值（见 §8）。

### 2.3 注册策略

| 部署模式 | 行为 |
|---|---|
| 单用户（默认，`ALLOW_MULTI_USER=false`） | 首个账号可注册，之后返回 `403 REGISTRATION_CLOSED`；可通过环境变量 `BOOTSTRAP_TOKEN` 一次性注册 |
| 多用户（`ALLOW_MULTI_USER=true`） | 开放注册或要求 `invite_code`（`REQUIRE_INVITE=true`） |
| 关闭注册 | 仅管理员预置账号；登录仍可用 |

密码哈希：Argon2id（m=64 MiB、t=3、p=1、salt 16 B），与保险库 KDF 参数无关。密码最小长度 10，最大 128；拒绝常见弱密码（内置前 10,000 条列表）。

---

## 3. 设备（API-DEV）

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-DEV-01 | `GET /v1/devices` | Bearer | — | — | `200`：`devices[]`{`id`,`name`,`platform`,`arch`,`app_version`,`created_at`,`last_seen_at`,`last_sync_at`,`revoked_at`,`current`(bool)} | 401 |
| API-DEV-02 | `POST /v1/devices` | Bearer | 建议 | `name`、`platform`、`arch`、`app_version`、`public_key`、`id`(可选，客户端生成) | `201`：设备对象；`200` 若同 ID 已存在且公钥一致（幂等） | 409 `DEVICE_NAME_CONFLICT`、422 |
| API-DEV-03 | `PATCH /v1/devices/{device_id}` | Bearer | 建议 | `name`（≤64） | `200`：设备对象 | 404、403（非本人设备） |
| API-DEV-04 | `DELETE /v1/devices/{device_id}` | Bearer | 必须 | `reason`(`user/admin/security`，可选) | `204`；目标设备的 refresh token 立即失效 | 404、403 `FORBIDDEN`（不允许删除当前设备） |
| API-DEV-05 | `POST /v1/devices/{device_id}/revoke` | Bearer + 最近认证 | 必须 | `reason` | `204` | 同上 |

规则：
- 设备上限默认 10（可配置）；超限返回 429 `QUOTA_EXCEEDED`。
- 吊销在 5 秒内对所有节点生效（服务端缓存 `token_epoch`，TTL ≤ 5 s）。
- 当前设备不能自我吊销；需先登出或由其他设备执行。
- 设备公钥用于中继票据的持有证明（P2）；v1 允许不校验签名，但必须存储。

---

## 4. 保险库与端到端加密（API-VLT）

### 4.1 设计约束

| 约束 | 说明 |
|---|---|
| 服务端不可解密 | 服务端只存 `wrapped_key`、`key_check`、密文记录、版本号、大小、时间、设备 ID |
| 不上送明文 | `record_type`、会话名、主机、用户名、命令、备注、标签均不发送 |
| KDF 参数可见 | 仅 `kdf_alg`、`mem_kib`、`time`、`parallelism`、`salt`、`crypto_suite` 可见（非秘密） |
| 记录 ID 不透明 | 不得包含语义或时间可读信息以外的业务含义；仅为 ULID |
| TLS 仍必须 | E2EE 不替代 TLS；TLS 防篡改/防重放/防旁路 |

### 4.2 端点

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-VLT-01 | `PUT /v1/vault` | Bearer | 必须 | `vault_id`、`schema_version`(int)、`crypto_suite`(string)、`kdf`{`alg`,`salt_b64`,`mem_kib`,`time`,`parallelism`}、`wrapped_key_b64`、`key_check_b64`、`key_version`(int) | `200`：`vault_id`、`head_seq`、`created_at`、`quota`；`201` 首次创建 | 409 `VAULT_EXISTS`（不同 vault_id 已存在）、413、422 |
| API-VLT-02 | `GET /v1/vault` | Bearer | — | — | `200`：`vault_id`、`schema_version`、`key_version`、`kdf`、`wrapped_key_b64`、`key_check_b64`、`head_seq`、`record_count`、`bytes_used`、`quota`、`created_at` | 404 `NOT_FOUND` |
| API-VLT-03 | `POST /v1/vault/key-slot` | Bearer + 最近认证 | 必须 | `key_version`(必须为当前+1)、`wrapped_key_b64`、`key_check_b64`、`kdf` | `200`：`key_version`、`updated_at`；旧 key_version 保留 30 天供旧客户端读取 | 409 `VERSION_CONFLICT`、422 |
| API-VLT-04 | `GET /v1/vault/key-slots` | Bearer | — | — | `200`：`slots[]`{`key_version`,`kdf`,`wrapped_key_b64`,`key_check_b64`,`created_at`,`retired_at`} | 404 |

规则：
- `vault_id` 由客户端生成；一个账号默认 1 个 Vault（多 Vault 为 P2，`VAULT_LIMIT` 配置）。
- `PUT /v1/vault` 首次创建时必须是空 Vault（head_seq=0）；重复提交相同 `vault_id` 与相同 `wrapped_key` 返回 200（幂等）。
- `wrapped_key` 与 `key_check` 均为密文，服务端不得尝试解密。
- 主密码修改：客户端本地重新包裹后提交 `POST /v1/vault/key-slot`；服务端只做版本递增，不接触主密码。

---

## 5. 同步（API-SYN）

### 5.1 数据模型（服务端）

| 表 | 字段 | 说明 |
|---|---|---|
| `vault` | `vault_id`、`account_id`、`schema_version`、`crypto_suite`、`kdf_json`、`wrapped_key`、`key_check`、`head_seq`、`created_at` | 每账号 1 个 |
| `key_slot` | `vault_id`、`key_version`、`kdf_json`、`wrapped_key`、`key_check`、`created_at`、`retired_at` | 历史密钥槽 |
| `record` | `vault_id`、`record_id`、`version`、`ciphertext`、`checksum`、`size`、`deleted`、`deleted_at`、`updated_at`、`device_id` | 当前头 |
| `record_history` | 同上 + `valid_from_seq`、`valid_to_seq` | 历史版本（用于冲突/回滚查看） |
| `commit` | `vault_id`、`seq`、`device_id`、`change_count`、`created_at`、`kind`(`normal/snapshot_restore`) | 单调提交日志 |
| `snapshot` | `snapshot_id`、`vault_id`、`label`、`record_count`、`bytes`、`manifest_checksum`、`created_at`、`device_id` | 快照头 |
| `snapshot_record` | `snapshot_id`、`record_id`、`ciphertext`、`checksum`、`deleted` | 快照内容（密文） |
| `audit_event` | `id`、`account_id`、`device_id`、`type`、`ip_hash`、`at`、`metadata_json` | 审计 |

关键不变量：
- `commit.seq` 在 Vault 内严格单调递增、无空洞（事务内分配）。
- `record.version` 从 1 开始，每次成功变更 +1；墓碑同样 +1。
- `record.checksum = SHA-256(ciphertext)`；服务端不解析内容。
- 删除只写墓碑，不物理删除；墓碑在最后一次变更后保留 90 天。

### 5.2 端点总表

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-SYN-01 | `GET /v1/sync/changes` | Bearer | — | Query：`cursor`(int,默认 0)、`limit`(1–500,默认 200)、`include_deleted`(bool,默认 true) | `200`：`changes[]`{`seq`,`record_id`,`version`,`ciphertext_b64`,`checksum`,`size`,`deleted`,`deleted_at`,`updated_at`,`device_id`}、`next_cursor`、`has_more`、`head_seq` | 400、401 |
| API-SYN-02 | `POST /v1/sync/commit` | Bearer | **必须** | `base_cursor`(int,可选)、`changes[]`{`record_id`,`base_version`(int 或 null)、`ciphertext_b64`、`checksum`、`deleted`(bool)、`client_updated_at`(ISO)}，≤500 条 | `200`：`applied[]`{`record_id`,`version`,`seq`}、`conflicts[]`{`record_id`,`server_version`,`server_ciphertext_b64`,`server_checksum`,`server_device_id`}、`new_cursor`、`head_seq` | 409 `SYNC_CONFLICT`（整体结构中含 applied）、413、422、429 |
| API-SYN-03 | `GET /v1/sync/head` | Bearer | — | — | `200`：`head_seq`、`record_count`、`bytes_used`、`last_commit_at` | 401 |
| API-SYN-04 | `GET /v1/vault/records/{record_id}/history` | Bearer | — | Query：`limit`(1–100,默认 20)、`before_version`(可选) | `200`：`versions[]`{`version`,`seq`,`checksum`,`size`,`deleted`,`updated_at`,`device_id`}、`has_more` | 404 |
| API-SYN-05 | `GET /v1/vault/records/{record_id}/history/{version}` | Bearer | — | — | `200`：`record_id`、`version`、`ciphertext_b64`、`checksum`、`deleted`、`updated_at` | 404 |
| API-SYN-06 | `GET /v1/sync/status` | Bearer | — | — | `200`：`head_seq`、`record_count`、`bytes_used`、`quota`、`conflict_retention_days`、`snapshot_count` | 401 |

### 5.3 `POST /v1/sync/commit` 语义

请求示例：

```json
{
  "base_cursor": 128,
  "changes": [
    {
      "record_id": "01J8Z3K9V0",
      "base_version": 7,
      "ciphertext_b64": "q83v...",
      "checksum": "9f2c...",
      "deleted": false,
      "client_updated_at": "2026-10-21T12:00:00.000Z"
    },
    {
      "record_id": "01J8Z3K9V1",
      "base_version": null,
      "ciphertext_b64": "",
      "checksum": "e3b0...",
      "deleted": true,
      "client_updated_at": "2026-10-21T12:00:01.000Z"
    }
  ]
}
```

处理规则：

| 情况 | 服务端行为 |
|---|---|
| `base_version` 为 null 且记录不存在 | 创建，`version=1` |
| `base_version` 为 null 但记录已存在 | 视为冲突（`both_created`），不应用 |
| `base_version` 等于当前 `version` | 应用，`version+1` |
| `base_version` 小于当前 `version` | 冲突，返回服务端当前密文 |
| 同一次提交内重复 `record_id` | 422 `VALIDATION_FAILED` |
| `deleted=true` | 写墓碑并 `version+1`；不要求 ciphertext（可为空） |
| 记录已在更早版本删除，`base_version` 匹配 | 允许再次更新（“恢复”），`version+1`、`deleted=false` |
| 单条密文 > 8 MiB | 413 `PAYLOAD_TOO_LARGE` |
| 变更总数 > 500 | 413 |
| `checksum` 与密文不符 | 422 `VALIDATION_FAILED` |

事务性：
- 一个事务内按请求顺序逐条校验并应用；接受项全部提交，冲突项返回但不回滚已接受项。
- 分配一个 `seq` 给整个提交（同一提交内多条变更共享 `seq`；`/changes` 以 `seq` 为游标返回整批）。
- 并发提交：SQLite `BEGIN IMMEDIATE` 或 Postgres `SERIALIZABLE`；同 Vault 串行化，不同 Vault 并行。
- 幂等键命中时返回首次结果（包括冲突列表），不重复分配版本。

响应示例（部分成功）：

```json
{
  "applied": [
    { "record_id": "01J8Z3K9V0", "version": 8, "seq": 129 }
  ],
  "conflicts": [
    {
      "record_id": "01J8Z3K9V2",
      "server_version": 12,
      "server_ciphertext_b64": "K2f...",
      "server_checksum": "a1b2...",
      "server_device_id": "01J8Y..."
    }
  ],
  "new_cursor": 129,
  "head_seq": 129
}
```

冲突响应状态：存在冲突时返回 `200`（便于客户端一次拿到 accepted 与 conflicts），不使用 409；仅当整个请求无法处理（如 `base_cursor` 超前于 `head_seq`）返回 409 `SYNC_CONFLICT`。**客户端必须同时处理 `applied` 与 `conflicts`。**

### 5.4 冲突解决策略（客户端权威）

| 冲突类型 | 判定 | 解决 |
|---|---|---|
| 同记录并发修改 | `base_version` 落后且双方均未删除 | 客户端用本地 base 明文快照做三方合并；可合并则生成新密文并提交（`base_version=server_version`）；不可合并则保留本地为**冲突副本**（新 `record_id`）并接受服务端版本 |
| 删除 vs 修改 | 服务端已删除、本地修改 | 删除生效；本地修改生成为冲突副本（不静默丢弃） |
| 修改 vs 删除 | 服务端已修改、本地删除 | 服务端修改生效；删除进入冲突面板由用户确认，可再次提交墓碑 |
| 双方新建同 ID | 极小概率（ID 冲突） | 保留服务端，客户端重新生成 ID 提交 |
| 幂等重试 | 同键同体 | 返回首次结果，不产生新版本 |

确定性收敛要求：
- 所有设备最终以服务端 `version` 为准，冲突副本有独立 ID，因此各端收敛到相同记录集合。
- 服务端不做“最后写入胜出”，不静默覆盖。
- 墓碑保留 90 天；离线超过 90 天的设备需全量重建（拉取所有记录并本地比对）。

### 5.5 增量拉取与游标

- `cursor` 为该 Vault 的 `seq`；客户端只在成功应用整批后推进。
- 同一 `seq` 的多条变更必须整批应用（事务），避免只应用一半。
- `has_more=true` 时立即继续拉取，直到 false。
- 客户端应保存 `last_cursor` 与每条记录的 `version`；发现本地 `version` 大于服务端（异常）时以服务端为准并记录审计。
- 全量重建：`cursor=0` 分页拉取，客户端按 `record_id` 与本地数据比对。

### 5.6 记录大小与填充

| 项 | 值 |
|---|---|
| 单条记录最大密文 | 8 MiB |
| 推荐填充 | 密文填充到 4 KiB 的整数倍（减少大小侧信道）；`size` 返回填充后大小 |
| 单次提交最大 | 16 MiB 或 500 条，先到者为准 |
| 快照单段最大 | 8 MiB（分片上传，见 §6.4） |

---

## 6. 快照、历史与回滚（API-SNP）

### 6.1 端点

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-SNP-01 | `POST /v1/vault/snapshots` | Bearer | 必须 | `snapshot_id`(客户端生成 ULID)、`label`(≤64)、`manifest`{`record_count`,`bytes`,`checksum`}、`records[]`{`record_id`,`ciphertext_b64`,`checksum`,`deleted`}（≤500 条/请求） | `201`：`snapshot_id`、`created_at`、`record_count`、`bytes`；重复提交同 ID 同内容返回 200 | 409 `SNAPSHOT_EXISTS`、413、429 |
| API-SNP-02 | `POST /v1/vault/snapshots/{snapshot_id}/parts` | Bearer | 必须 | `part_index`(0–1023)、`records[]`（同上，≤500 条） | `202`：`part_index`、`received_records`、`total_records` | 409（快照已封存）、413 |
| API-SNP-03 | `POST /v1/vault/snapshots/{snapshot_id}/finalize` | Bearer | 必须 | `record_count`、`bytes`、`manifest_checksum` | `200`：快照对象 | 409（计数不符）、404 |
| API-SNP-04 | `GET /v1/vault/snapshots` | Bearer | — | Query：`limit`(1–100,默认 20)、`before`(ISO 时间) | `200`：`snapshots[]`{`snapshot_id`,`label`,`record_count`,`bytes`,`created_at`,`device_id`}、`has_more` | 401 |
| API-SNP-05 | `GET /v1/vault/snapshots/{snapshot_id}` | Bearer | — | Query：`part`(0–1023,可选)、`limit`(≤500) | `200`：快照头 + `records[]`（密文） | 404 |
| API-SNP-06 | `DELETE /v1/vault/snapshots/{snapshot_id}` | Bearer | 必须 | — | `204` | 404、409（正在回滚） |
| API-SNP-07 | `POST /v1/vault/rollback` | Bearer + 最近认证 | 必须 | `snapshot_id`、`expected_head_seq`、`mode`(`restore` 默认)、`create_pre_restore_snapshot`(bool,默认 true) | `202`：`new_head_seq`、`restored_records`、`deleted_records`、`pre_restore_snapshot_id` | 404、409 `VERSION_CONFLICT`、422 |

### 6.2 回滚语义

| 步骤 | 行为 |
|---|---|
| 1 | 校验 `expected_head_seq == vault.head_seq`，否则 409（防止覆盖新变更） |
| 2 | 若 `create_pre_restore_snapshot=true`，先创建当前头的加密快照（客户端已在请求前上传，或由服务端复制当前 `record` 密文生成，二者选一；实现必须只复制密文，不解密） |
| 3 | 对快照内每条记录，若当前不存在或密文不同：写入新 `version`（`version+1`），`device_id=发起设备`；若当前存在但快照中不存在：写墓碑 |
| 4 | 分配新的 `commit.seq`（`kind=snapshot_restore`），所有变更属于该提交 |
| 5 | 返回 `new_head_seq`；其他设备通过常规 `/changes` 拉取到恢复结果 |

注意：
- 回滚**不删除历史**；只是把旧密文以新版本重新发布。
- 回滚不会让服务端获得明文。
- 客户端在回滚后需重新拉取并重建本地索引。
- 快照本身不可变；`DELETE` 只删除快照及其分片（不改变当前记录）。

### 6.3 历史保留

| 项 | 默认 | 可配置 |
|---|---|---|
| 每记录历史版本数 | 50 | `HISTORY_VERSIONS` |
| 历史保留天数 | 90 | `HISTORY_DAYS` |
| 墓碑保留天数 | 90 | `TOMBSTONE_DAYS` |
| 快照数量 | 20 | `SNAPSHOT_LIMIT` |
| 快照大小 | 256 MiB | `SNAPSHOT_MAX_BYTES` |

GC 每天执行一次；删除历史不影响当前头。审计事件保留 180 天。

### 6.4 分片上传

- 快照按 `part_index` 从 0 连续上传；服务端校验连续性，缺片返回 409 `PRECONDITION_FAILED`。
- `finalize` 校验总记录数与 `manifest_checksum`（对按 `record_id` 升序拼接的每条 `checksum` 计算 SHA-256）。
- 未在 24 小时内 finalize 的快照自动清理。
- 上传幂等：同一 `(snapshot_id, part_index)` 重复提交且内容一致返回 202；内容不同返回 409。

---

## 7. 更新分发（API-UPD）

### 7.1 目标标识

| `target` | 平台 | 架构 | 产物类型 |
|---|---|---|---|
| `windows-x86_64` | Windows 10/11 | x86_64 | `nsis`、`msi` |
| `windows-arm64` | Windows 11 | arm64 | `nsis`（P2） |
| `macos-universal` | macOS 12+ | universal | `dmg` |
| `linux-x86_64` | Linux | x86_64 | `appimage`、`deb` |
| `linux-arm64` | Linux | arm64 | `appimage`、`deb` |

### 7.2 端点

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-UPD-01 | `GET /updates/{target}/{version}` | 无（可选 `X-Install-Id`） | — | 路径：`target`、`version`（语义版本或 `latest`）；头：`If-None-Match`、`X-Install-Id`、`X-Channel`(`stable/beta`，默认 stable)、`X-Current-Version` | `200` 清单（见 7.3）；`304` 无变化 | 400 `INVALID_REQUEST`、404、429 |
| API-UPD-02 | `GET /downloads/{artifact_id}` | 无 | — | 头：`Range`(可选) | `200`/`206` 二进制；`Content-Length`、`Content-Disposition`、`ETag` | 404、416 |
| API-UPD-03 | `GET /updates/revocations/{target}` | 无 | — | — | `200`：`revoked_versions[]`、`min_supported_version`、`updated_at` | 404（无列表） |
| API-UPD-04 | `GET /updates/channels/{target}` | 无 | — | — | `200`：`channels[]`{`name`,`latest_version`,`rollout_percent`} | 404 |

### 7.3 清单字段

```json
{
  "manifest_version": 1,
  "target": "windows-x86_64",
  "channel": "stable",
  "version": "1.2.0",
  "previous_version": "1.1.4",
  "min_supported_version": "1.0.0",
  "min_os": "10.0.17763",
  "released_at": "2026-10-20T08:00:00.000Z",
  "mandatory": false,
  "rollout": { "percent": 25, "seed": "2026-10" },
  "notes_url": "https://example.invalid/releases/1.2.0",
  "artifacts": [
    {
      "id": "win-nsis-1.2.0",
      "kind": "nsis",
      "url": "https://example.invalid/downloads/win-nsis-1.2.0.exe",
      "size": 24117248,
      "sha256": "9f2c...",
      "signature_b64": "MEUCIQ...",
      "signing_key_id": "k1"
    }
  ],
  "revoked_versions": [],
  "rollback": { "allowed": true, "to_version": "1.1.4" },
  "signature_b64": "MEUCIQ...",
  "signing_key_id": "k1"
}
```

字段语义：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `manifest_version` | int | 是 | 清单结构版本，当前 1 |
| `target` / `channel` | string | 是 | 与路径/请求一致 |
| `version` | string | 是 | 语义版本 `MAJOR.MINOR.PATCH[-pre]` |
| `previous_version` | string | 否 | 上一稳定版本，用于回滚 |
| `min_supported_version` | string | 是 | 低于此版本必须强制升级 |
| `min_os` | string | 否 | 最低系统版本 |
| `mandatory` | bool | 是 | 是否强制更新 |
| `rollout.percent` | int 0–100 | 是 | 灰度比例 |
| `rollout.seed` | string | 是 | 分桶种子 |
| `notes_url` | string | 否 | 发布说明 |
| `artifacts[]` | array | 是 | 至少 1 个 |
| `artifacts[].url` | string | 是 | 绝对 HTTPS URL 或同源路径 |
| `artifacts[].sha256` | string | 是 | 小写十六进制 |
| `artifacts[].signature_b64` | string | 是 | 对产物字节的 Ed25519 签名 |
| `revoked_versions` | array | 是 | 已知不安全版本 |
| `rollback` | object | 否 | 是否允许回退及目标版本 |
| `signature_b64` | string | 是 | 对清单（去掉 `signature_b64` 字段）的规范化 JSON 签名 |
| `signing_key_id` | string | 是 | 客户端按 ID 选择内置公钥 |

### 7.4 校验与灰度

| 规则 | 实现 |
|---|---|
| 清单签名 | RFC 8785（JCS）规范化，去掉 `signature_b64` 后 Ed25519 验签；失败必须拒绝 |
| 公钥固定 | 客户端内置至少 2 个公钥（当前/备用）；不在运行时下载公钥 |
| 产物校验 | 下载后校验 `sha256` 与 `signature_b64`；任一失败删除文件并报错 |
| 灰度分桶 | `bucket = SHA-256(install_id + ":" + version)[0..8] mod 100`；`bucket < percent` 才提示 |
| 撤销 | 当前版本 ∈ `revoked_versions` 时即使非强制也提示升级/回退 |
| 回滚 | 安装失败时客户端保留旧版本；服务端可将 `previous_version` 指向可回退产物 |
| 缓存 | `ETag` + `Cache-Control: max-age=300`；`If-None-Match` 支持 304 |
| 降级保护 | `version` 低于当前且 `rollback.allowed=false` 时客户端不得自动降级 |

### 7.5 更新检查策略（客户端侧契约）

- 默认仅手动检查；可在设置开启“每日检查”，首次检查在启动 60 秒后（避免影响冷启动）。
- 请求只携带 `X-Install-Id`、当前版本、目标、通道；不携带账号、邮箱、设备 ID、会话数据。
- 手动检查失败必须给出错误码；自动检查失败静默记录，不打断用户。
- 任意清单/签名校验失败：不安装，显示“更新包校验失败”，提供“查看详情”。

---

## 8. 可选中继（API-RLY，P2，默认关闭）

### 8.1 能力与边界

| 项 | 约定 |
|---|---|
| 用途 | 客户端经自建公网服务器转发 TCP，访问内网 SSH/RDP/HTTP 等 |
| 默认状态 | 关闭（`RELAY_ENABLED=false`）；关闭时相关端点返回 403 `RELAY_DISABLED` |
| 鉴权 | 登录账号 + 设备 + 一次性票据（单次使用、短 TTL） |
| 目标控制 | 服务端配置 CIDR 允许列表；默认仅允许 RFC1918 私网与用户显式配置的目标 |
| 内容可见性 | 中继转发加密字节流（SSH/TLS 本身加密）；服务端仍可见源/目的 IP、端口、流量大小、时间 |
| 审计 | 记录连接元数据；不记录载荷 |
| 限额 | 每设备并发 2 条；单条带宽 16 Mbit/s；空闲 300 s 断开；单票据 1 GiB 上限 |

### 8.2 端点

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-RLY-01 | `POST /v1/relay/tickets` | Bearer + 设备签名 | 必须 | `dest_host`(string)、`dest_port`(1–65535)、`protocol`(`tcp`)、`ttl_sec`(30–300,默认 120)、`bytes_limit`(≤1 GiB,默认 256 MiB) | `201`：`ticket_id`、`ticket`(不透明)、`ws_url`、`expires_at`、`max_bytes`、`max_idle_sec` | 403 `RELAY_DISABLED`/`DESTINATION_NOT_ALLOWED`、429、422 |
| API-RLY-02 | `GET /v1/relay/stream`（WebSocket Upgrade） | 票据 | — | Query：`ticket`；头：`Sec-WebSocket-Protocol: openshell.relay.v1` | `101` 切换协议；之后见 8.3 | 401、403、404（票据无效/已用/过期） |
| API-RLY-03 | `DELETE /v1/relay/tickets/{ticket_id}` | Bearer | 必须 | — | `204`（撤销未使用票据） | 404 |

### 8.3 WebSocket 帧协议

| 帧 | 方向 | 内容 |
|---|---|---|
| 文本 `{"type":"open","dest_host":"...","dest_port":22}` | 客户端→服务端 | 可选；若票据已绑定目标则忽略 |
| 文本 `{"type":"opened","remote_addr":"..."}` | 服务端→客户端 | TCP 建连成功 |
| 二进制 | 双向 | 原始 TCP 载荷；一个 WS 二进制帧对应一段字节流，不额外加长度前缀 |
| 文本 `{"type":"half_close","direction":"c2s"}` | 双向 | 半关闭 |
| 文本 `{"type":"close","code":1000,"reason":"..."}` | 双向 | 关闭隧道 |
| 文本 `{"type":"error","code":"UPSTREAM_UNREACHABLE","message":"..."}` | 服务端→客户端 | 建连/转发错误 |
| Ping/Pong | 双向 | 每 30 s；90 s 无 Pong 断开 |

规则：
- 票据单次使用：握手成功后立即标记已用；断开后不可复用。
- 服务端在握手阶段完成鉴权与目标策略校验，失败返回 HTTP 403 而非 WS 帧。
- 服务端不得记录二进制载荷；调试日志上限 0 字节载荷内容。
- 客户端必须校验 `ws_url` 与配置的服务器同源；不接受清单/响应中的任意第三方地址。

### 8.4 审计与风控

| 事件 | 记录字段 |
|---|---|
| 票据签发 | `account_id`、`device_id`、`dest_host`、`dest_port`、`bytes_limit`、`at` |
| 隧道建立/关闭 | 同上 + 实际字节数、时长、关闭原因 |
| 策略拒绝 | 目标、规则名、`at` |
| 异常 | 并发超限、票据重用、握手失败（带 IP 哈希） |

---

## 9. 运维接口（API-OPS）

| ID | 方法 路径 | 鉴权 | 幂等键 | 请求字段 | 响应字段 | 主要错误 |
|---|---|---|---|---|---|---|
| API-OPS-01 | `GET /healthz` | 无 | — | — | `200`：`status`(`ok`)、`version`、`uptime_sec`、`time` | 503（进程不健康） |
| API-OPS-02 | `GET /readyz` | 无 | — | — | `200`：`status`(`ready`)、`db`(`ok`)、`migrations`(`ok`)、`relay`(`on/off`)；未就绪 503 | — |
| API-OPS-03 | `GET /metrics` | 默认无（仅监听内网）；可配 Bearer | — | — | `200`：Prometheus 文本 | 401（配置了令牌时） |
| API-OPS-04 | `GET /v1/audit/events` | Bearer | — | Query：`limit`(1–200,默认 50)、`before`(ISO)、`type`(可选) | `200`：`events[]`{`id`,`type`,`device_id`,`at`,`ip_hash`,`metadata`}、`has_more` | 401 |

### 9.1 指标（Prometheus）

| 指标 | 类型 | 标签 | 说明 |
|---|---|---|---|
| `openshell_http_requests_total` | counter | `method`,`route`,`status` | 路由为模板（如 `/v1/sync/commit`），不含 ID |
| `openshell_http_request_duration_seconds` | histogram | `method`,`route` | p50/p95/p99 |
| `openshell_sync_commits_total` | counter | `result`(`ok/conflict/error`) | 提交结果 |
| `openshell_sync_changes_total` | counter | `op`(`put/delete`) | 变更数 |
| `openshell_sync_conflicts_total` | counter | — | 冲突记录数 |
| `openshell_vault_bytes` | gauge | `vault_tier`(size bucket，不含 ID) | 密文总量 |
| `openshell_relay_active_tunnels` | gauge | — | 活跃隧道 |
| `openshell_relay_bytes_total` | counter | `direction` | 中继流量 |
| `openshell_update_requests_total` | counter | `target`,`channel`,`result` | 更新查询 |
| `openshell_auth_failures_total` | counter | `reason` | 登录失败（不含账号标签） |
| `process_*` | — | — | 进程指标 |

约束：禁止把 `account_id`、`device_id`、`vault_id`、IP、主机名放入标签（高基数与隐私）。

### 9.2 审计事件类型

| 类型 | 触发 |
|---|---|
| `auth.register` / `auth.login` / `auth.login_failed` / `auth.refresh_reuse` / `auth.logout` | 认证 |
| `device.register` / `device.revoke` / `device.rename` | 设备 |
| `vault.create` / `vault.key_rotate` | 保险库 |
| `sync.commit` / `sync.conflict` / `sync.quota_exceeded` | 同步 |
| `snapshot.create` / `snapshot.delete` / `vault.rollback` | 快照 |
| `relay.ticket` / `relay.open` / `relay.close` / `relay.denied` | 中继 |
| `update.check` / `update.download` | 更新（可采样） |

审计内容不得包含密文、明文、令牌、密码。IP 仅存 `SHA-256(ip + server_pepper)` 前 16 字节的十六进制。

### 9.3 部署与备份

- `docker compose up -d` 启动 API、数据库（SQLite 卷或 Postgres）、反向代理（Caddy 自动 HTTPS）。
- 反向代理必须传递 `X-Forwarded-For`，服务端仅信任配置的代理网段。
- 备份：Postgres `pg_dump` 每日 + WAL 归档；SQLite 使用在线备份 API；备份文件加密存储。
- 升级：先备份，再滚动重启；数据库迁移向前兼容（至少支持上一个次版本）。
- 恢复演练：文档给出从备份恢复到新实例并验证 `/readyz` 的步骤。

---

## 10. 安全与隐私

### 10.1 服务端可见/不可见

| 数据 | 服务端可见 | 说明 |
|---|---|---|
| 账号邮箱 | 是（需用于登录） | 可配置为用户名替代 |
| 密码 | 否（仅 Argon2id 哈希） | 不可逆 |
| 保险库主密码 | **否** | 从不上传、不参与任何请求 |
| vault key | 否 | 仅包裹后的密文 |
| 记录 ID、版本、大小、时间 | 是 | 元数据 |
| 会话名、主机、用户名、命令、备注 | 否 | 在密文中 |
| 更新安装标识 | 是（随机 UUID） | 与账号无关，可重置 |
| 中继目标 IP/端口 | 是（P2 且启用时） | 审计所需 |
| 载荷内容（中继） | 否（不记录） | 仅转发 |
| 客户端崩溃/使用统计 | 否 | 服务端不提供遥测端点 |

### 10.2 威胁模型

| 威胁 | 影响 | 缓解 |
|---|---|---|
| 服务端数据库泄露 | 密文、元数据泄露 | E2EE；密文不可解密；元数据最小化；可选大小填充 |
| 服务端被完全控制 | 可删除/回滚/拒绝服务；不能读明文 | 客户端快照、版本历史、异常版本检测；用户可迁移服务端 |
| 刷新令牌被盗 | 账号接管 | 短期 access、轮换 refresh、重用检测、设备吊销、密码修改使全部令牌失效 |
| MITM | 篡改 | TLS 1.2+、HSTS、证书校验；清单与产物双重签名 |
| 恶意更新 | 供应链 | 固定公钥、清单与产物独立签名、灰度、撤销列表 |
| 重放提交 | 重复写入 | 幂等键 + 版本号 + TLS |
| 中继滥用 | 内网探测 | 默认关闭、目标 CIDR 白名单、票据单次、并发与带宽限额、审计 |
| 密码喷洒 | 账号枚举 | 统一错误、IP+账号限速、Argon2id |
| 客户端设备丢失 | 本地数据泄露 | 保险库加密、自动锁定、远程吊销设备、密钥轮换 |

### 10.3 隐私承诺

1. 服务端不部署任何第三方分析、广告、崩溃收集 SDK。
2. 服务端日志不记录请求体、Authorization、密文、密码；访问日志仅保留方法、路由模板、状态、耗时、IP 哈希。
3. 更新请求不含账号/设备标识；仅含随机安装 ID、版本、目标、通道。
4. 中继默认关闭，启用需显式配置，并在客户端首次使用时提示服务端可见的元数据。
5. 用户删除账号时，服务端在 30 天内物理删除该 Vault 的全部记录、快照、审计与设备（法律要求保留的除外）；客户端本地数据由用户自行删除。

### 10.4 合规与实现约束

- 所有加密原语使用成熟库（RustCrypto 等宽松许可），不自研密码学。
- 密码学参数集中在配置与 `crypto_suite` 中，可升级；禁止静默降级。
- 服务端不得实现任何授权/激活/付费墙逻辑；账号仅为自建同步服务使用。
- OpenAPI 文档必须标注每个端点的鉴权、幂等与错误码，并与本文件一致。

---

## 11. 假设与待确认

| 编号 | 假设 | 验证方式 |
|---|---|---|
| API-A1 | 单用户部署是默认场景，注册在首个账号后关闭 | 部署脚本默认值与 SYNC-002 验收 |
| API-A2 | SQLite 在单用户、512 MiB 配额下足够；多用户可切换 Postgres | 压测 100k 记录、1 GiB 历史 |
| API-A3 | 服务端在密文层可完成回滚（复制密文 + 版本递增），无需解密 | API-SNP-07 端到端测试 |
| API-A4 | 客户端可保留 base 明文快照以支持三方合并 | SYNC-007 冲突用例 |
| API-A5 | 反向代理终止 TLS，服务端只信任配置网段 | 部署测试 + 伪造 `X-Forwarded-For` 拒绝用例 |
| API-A6 | 更新清单与产物可由同一或不同密钥签名，客户端内置 2 个公钥 | 签名轮换演练 |
