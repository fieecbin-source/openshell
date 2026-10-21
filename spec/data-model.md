# 数据模型规格（Data Model Specification）

| 项 | 值 |
|---|---|
| 文档编号 | SPEC-DM-001 |
| 版本 | 1.0（M1 冻结） |
| 依赖 | `spec/product.md`（SEC、SYNC、IMP 域）、`spec/sync-api.md` |
| 存储建议 | SQLite（WAL 模式）+ 加密值列；JSON 列用于协议扩展与 UI 状态。本文不绑定具体 ORM。 |
| 洁净室声明 | 本文为自设计模型，不含任何第三方产品的字段编码、类名或私有格式。 |

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 主键 | `id`：ULID 文本（26 字符，Crockford Base32，按时间可排序）。对服务端而言是不透明字符串，不得从中推断内容。 |
| 外键 | 同类型 ULID；删除采用软删除（`deleted_at`），物理清除由保留策略执行。 |
| 时间 | 全部为 Unix 毫秒（UTC），字段后缀 `_at`；显示时按用户时区与 locale 格式化。 |
| 布尔 | SQLite 存 `INTEGER 0/1`，语义层为布尔。 |
| 版本 | `version` 为记录级单调递增整数（由服务端在提交成功时分配）；本地未同步修改使用 `dirty=1` + 本地 `local_rev`。 |
| 同步字段 | 所有可同步实体均含：`version`、`updated_at`、`deleted_at`、`origin_device_id`、`dirty`。`version=0` 表示尚未推送的新记录。 |
| 排序 | `sort_order` 为整数，同级内升序；间隔 1024，耗尽时重排。 |
| 命名 | 数据库列 `snake_case`；JSON 键 `snake_case`；API 字段同名（见 sync-api）。 |
| 字符集 | 全部 UTF-8；会话名、分组名长度 ≤ 128 字符（Unicode 码点），备注 ≤ 4,096。 |
| 敏感数据 | 见 §6。字段名以 `_ref` 结尾者指向加密秘密表，不含明文。 |
| schema 版本 | `PRAGMA user_version` 保存整数版本；JSON 导入文件另有 `schema_version`。 |

### 1.1 实体总览

| 实体 | 表名（建议） | 可同步 | 说明 |
|---|---|---|---|
| Vault（Workspace） | `vault` | 部分（密钥槽元数据） | 一个本地保险库；单用户默认 1 个 |
| Group | `session_group` | 是 | 会话与片段的分组树 |
| Session | `session` | 是 | 连接配置 |
| Credential | `credential` | 是 | 凭据元数据；秘密在 `secret` 表 |
| SshKey | `ssh_key` | 是 | 密钥元数据；私钥在 `secret` 表 |
| KnownHost | `known_host` | 是 | 主机公钥信任库 |
| Snippet / Macro | `snippet` | 是 | 片段与宏共用表，`kind` 区分 |
| PortForwardRule | `port_forward` | 是 | 转发规则 |
| Settings | `setting` | 是（用户偏好可选） | 键值 + JSON 值 |
| Device | `device` | 否（服务端权威） | 已登录设备 |
| SyncMetadata | `sync_meta`、`sync_record` | 否（本地状态） | 光标、版本表、冲突队列 |
| Secret（辅助） | `secret` | 是 | 加密秘密块（密码/私钥/口令） |

ER 关系（文字）：

```
Vault 1─n Group 1─n Session 1─n PortForwardRule
Vault 1─n Credential 1─n Secret
Vault 1─n SshKey 1─n Secret
Session n─1 Credential（可空）
Session n─1 SshKey（可空）
Session n─n PortForwardRule（规则可绑定会话，也可独立）
Session n─n KnownHost（按 host:port 关联，弱引用）
Group 1─n Snippet
Vault 1─n Device（仅服务端权威副本）
Vault 1─1 SyncMetadata
```

---

## 2. 实体定义

### 2.1 Vault（保险库 / Workspace）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 保险库 ID（ULID）；同步时作为不透明 `vault_id` | — |
| `name` | TEXT(64) | 是 | 显示名 | `默认保险库` / `Default Vault`（按 locale） |
| `schema_version` | INTEGER | 是 | 本地数据模型版本，迁移用 | 1 |
| `crypto_suite` | TEXT(32) | 是 | 加密套件标识，如 `xchacha20poly1305-v1` | `xchacha20poly1305-v1` |
| `kdf_alg` | TEXT(16) | 是 | 密钥派生算法标识 | `argon2id` |
| `kdf_mem_kib` | INTEGER | 是 | 内存参数（KiB） | 65536 |
| `kdf_time` | INTEGER | 是 | 迭代次数 | 3 |
| `kdf_parallelism` | INTEGER | 是 | 并行度 | 1 |
| `kdf_salt` | BLOB(16) | 是 | 随机盐 | 随机生成 |
| `wrapped_vault_key` | BLOB | 是 | 被主密码派生密钥包裹的 vault key（AEAD 信封） | — |
| `key_check` | BLOB | 是 | 解锁校验（对固定串加密的结果）；不可逆 | — |
| `keychain_ref` | TEXT(128) | 否 | 系统钥匙串条目引用（不含密钥本身） | NULL |
| `created_at` | INTEGER | 是 | 创建时间 | 当前时间 |
| `updated_at` | INTEGER | 是 | 更新时间 | 当前时间 |
| `last_opened_at` | INTEGER | 否 | 最近解锁时间 | NULL |
| `sync_enabled` | INTEGER | 是 | 是否启用同步 | 0 |
| `server_url` | TEXT(256) | 否 | 自建服务端地址（HTTPS） | NULL |
| `account_id` | TEXT(64) | 否 | 服务端账号标识（不透明） | NULL |
| `quota_bytes` | INTEGER | 否 | 服务端配额（最近一次获取） | NULL |

约束：
- 单用户默认仅允许 1 个 Vault；多 Vault 为 P2，需 `vault` 表和所有实体加 `vault_id`（本版所有实体隐含同一 Vault，预留 `vault_id` 列）。
- `kdf_*` 与 `crypto_suite` 变更必须走迁移流程，旧参数需保留在 `vault_key_history`（可选表）以支持旧备份解锁。

索引：`UNIQUE(name)`；`INDEX(sync_enabled)`。

### 2.2 Group（分组）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 分组 ID | — |
| `parent_id` | TEXT(26) | 否 | 父分组；NULL 表示根 | NULL |
| `name` | TEXT(128) | 是 | 显示名；同级唯一（不区分大小写） | `未命名分组` |
| `kind` | TEXT(16) | 是 | `session`（会话分组）/ `snippet`（片段分组） | `session` |
| `sort_order` | INTEGER | 是 | 同级排序 | 1024 |
| `color` | TEXT(7) | 否 | 标签色（`#RRGGBB`），仅用于分组标识 | NULL |
| `icon_key` | TEXT(32) | 否 | 内置图标键（自有图标集） | `folder` |
| `expanded` | INTEGER | 是 | UI 展开状态（本地偏好，可选同步） | 1 |
| `notes` | TEXT(1024) | 否 | 备注 | NULL |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是/是/否 | 生命周期 | 当前/当前/NULL |
| `version` / `origin_device_id` / `dirty` | INTEGER/TEXT/INTEGER | 是 | 同步元数据 | 0/NULL/1 |

约束：`parent_id` 不得形成环（应用层校验，深度 ≤ 8）；删除分组时子项移动到父级（`deleted_at` 仅标记分组）。
索引：`INDEX(parent_id, sort_order)`、`UNIQUE(parent_id, name COLLATE NOCASE)`（`deleted_at IS NULL` 部分索引）。

### 2.3 Session（会话）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 会话 ID | — |
| `group_id` | TEXT(26) | 否 | 所属分组 | NULL（根） |
| `name` | TEXT(128) | 是 | 显示名 | `<user>@<host>` |
| `protocol` | TEXT(16) | 是 | `ssh` / `sftp` / `telnet` / `serial` / `local_shell` | `ssh` |
| `host` | TEXT(255) | 条件 | 主机名或 IP（`local_shell`/`serial` 为空） | NULL |
| `port` | INTEGER | 条件 | 端口（1–65535）；协议默认见下表 | 22 |
| `username` | TEXT(128) | 条件 | 登录用户名 | NULL |
| `auth_method` | TEXT(24) | 条件 | `password` / `publickey` / `keyboard_interactive` / `agent` / `none` | `password` |
| `credential_id` | TEXT(26) | 否 | 引用 Credential（密码或键盘交互响应集） | NULL |
| `ssh_key_id` | TEXT(26) | 否 | 引用 SshKey | NULL |
| `host_key_policy` | TEXT(16) | 是 | `strict`（默认）/ `accept_new` / `insecure` | `strict` |
| `proxy_jump_json` | JSON | 否 | 跳板链数组，见 §2.3.1 | NULL |
| `proxy_id` | TEXT(26) | 否 | 引用代理配置（`setting` 中的 profile，或独立表 P2） | NULL |
| `terminal_profile_id` | TEXT(26) | 否 | 引用终端配置（字体/配色/回滚，存 `setting`） | NULL |
| `encoding` | TEXT(16) | 是 | 终端编码 | `UTF-8` |
| `startup_command` | TEXT(1024) | 否 | 登录后执行命令（SSH/本地）；空表示交互 shell | NULL |
| `working_dir` | TEXT(512) | 否 | 初始工作目录（本地 Shell/可选远端） | NULL |
| `keepalive_sec` | INTEGER | 是 | 保活间隔，0 关闭；范围 0–300 | 30 |
| `keepalive_max_miss` | INTEGER | 是 | 连续无响应判定阈值 | 3 |
| `auto_reconnect` | INTEGER | 是 | 是否自动重连 | 0 |
| `reconnect_max` | INTEGER | 是 | 最大重试次数（1–20） | 7 |
| `compression` | INTEGER | 是 | SSH 压缩 | 0 |
| `agent_forwarding` | INTEGER | 是 | 是否转发 agent | 0 |
| `x11_forwarding` | INTEGER | 是 | 预留（本版固定 0） | 0 |
| `tags_json` | JSON | 否 | 标签数组，≤ 16 个，每个 ≤ 32 字符 | `[]` |
| `favorite` | INTEGER | 是 | 收藏置顶 | 0 |
| `color` | TEXT(7) | 否 | 会话标签色 | NULL |
| `icon_key` | TEXT(32) | 否 | 内置图标键 | NULL |
| `notes` | TEXT(4096) | 否 | 备注 | NULL |
| `protocol_options_json` | JSON | 否 | 协议专属字段，见 §2.3.2 | NULL |
| `last_used_at` | INTEGER | 否 | 最近连接时间（用于“最近”） | NULL |
| `last_result` | TEXT(16) | 否 | `success` / `failed` / `cancelled`（仅本地，不同步） | NULL |
| `use_count` | INTEGER | 是 | 使用次数（本地统计，不同步） | 0 |
| `sort_order` | INTEGER | 是 | 同级排序 | 1024 |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：
- `protocol=ssh/sftp/telnet` 时 `host`、`port`、`username` 必填；`local_shell` 忽略 `host/port`；`serial` 使用 `protocol_options_json.device`。
- `auth_method=password|keyboard_interactive` 时 `credential_id` 必填；`publickey` 时 `ssh_key_id` 必填。
- `host_key_policy=insecure` 需在 UI 二次确认并在会话列表显示风险标识。
- 同一 `group_id` 下 `name` 唯一（不区分大小写）。

索引：`INDEX(group_id, sort_order)`、`INDEX(last_used_at DESC)`、`INDEX(favorite, sort_order)`、`INDEX(deleted_at)`、`INDEX(dirty, updated_at)`。

#### 2.3.1 `proxy_jump_json`

```json
[
  {
    "order": 1,
    "mode": "session_ref",
    "session_id": "01J...A",
    "host": null, "port": null, "username": null,
    "auth_method": null, "credential_id": null, "ssh_key_id": null
  },
  {
    "order": 2,
    "mode": "inline",
    "session_id": null,
    "host": "10.0.0.5", "port": 22, "username": "ops",
    "auth_method": "publickey",
    "credential_id": null, "ssh_key_id": "01J...K"
  }
]
```

约束：`order` 从 1 连续递增，最多 5；`mode=session_ref` 时仅允许 `session_id`，其他字段为 null；禁止自引用或循环引用。

#### 2.3.2 `protocol_options_json`（按协议）

| 协议 | 字段 | 类型 | 语义 | 默认 |
|---|---|---|---|---|
| ssh | `kex_algorithms` | array<string> | 覆盖默认算法顺序（空 = 默认） | `[]` |
| ssh | `host_key_algorithms` | array<string> | 主机密钥算法顺序 | `[]` |
| ssh | `cipher_algorithms` | array<string> | 加密算法顺序 | `[]` |
| ssh | `auth_order` | array<string> | 认证尝试顺序 | `["agent","publickey","keyboard_interactive","password"]` |
| ssh | `identities_only` | bool | 仅使用指定密钥 | false |
| telnet | `terminal_type` | string | 终端类型 | `xterm-256color` |
| telnet | `newline_mode` | string | `lf` / `crlf` / `auto` | `auto` |
| telnet | `telnet_options` | object | 回显/NAWS 等开关 | `{}` |
| serial | `device` | string | 端口路径（如 `COM3`、`/dev/ttyUSB0`） | — |
| serial | `baud` | int | 波特率 | 115200 |
| serial | `data_bits` | int | 5–8 | 8 |
| serial | `stop_bits` | int | 1 / 2 | 1 |
| serial | `parity` | string | `none` / `even` / `odd` | `none` |
| serial | `flow_control` | string | `none` / `rtscts` / `xonxoff` | `none` |
| local_shell | `shell` | string | `auto` / `powershell` / `cmd` / `wsl:<distro>` / `bash` / `zsh` / `fish` | `auto` |
| local_shell | `env` | object | 追加环境变量 | `{}` |

### 2.4 Credential（凭据）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 凭据 ID | — |
| `name` | TEXT(128) | 是 | 显示名（如“生产机只读账号”） | — |
| `kind` | TEXT(24) | 是 | `password` / `keyboard_interactive` / `passphrase` | `password` |
| `username` | TEXT(128) | 否 | 关联用户名（仅用于展示/自动填充提示） | NULL |
| `secret_id` | TEXT(26) | 是 | 指向 `secret`（加密载荷） | — |
| `hint` | TEXT(128) | 否 | 用户可见提示（不得包含秘密片段） | NULL |
| `save_policy` | TEXT(16) | 是 | `always` / `ask` / `never`（会话未覆盖时使用） | `ask` |
| `expires_at` | INTEGER | 否 | 凭据有效期提示（仅提醒，不自动删除） | NULL |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：`kind=keyboard_interactive` 时秘密载荷为“挑战→响应”映射（JSON），不保证能覆盖多轮动态挑战，需在 UI 说明。
索引：`INDEX(name COLLATE NOCASE)`、`INDEX(dirty, updated_at)`。

### 2.5 SshKey（SSH 密钥）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 密钥 ID | — |
| `name` | TEXT(128) | 是 | 显示名 | — |
| `algorithm` | TEXT(24) | 是 | `ed25519` / `rsa` / `ecdsa` | — |
| `key_size` | INTEGER | 否 | RSA 位数或 ECDSA 曲线位数 | NULL |
| `public_key` | TEXT | 是 | OpenSSH 单行公钥（`type base64 comment`），非秘密 | — |
| `fingerprint_sha256` | TEXT(64) | 是 | SHA-256 指纹（Base64，无 `SHA256:` 前缀） | — |
| `secret_id` | TEXT(26) | 是 | 指向 `secret`（加密私钥，OpenSSH/PEM 原文） | — |
| `passphrase_credential_id` | TEXT(26) | 否 | 私钥口令（引用另一 Credential） | NULL |
| `has_passphrase` | INTEGER | 是 | 是否有口令（UI 展示用） | 0 |
| `comment` | TEXT(256) | 否 | 公钥注释 | NULL |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：`fingerprint_sha256` 与 `public_key` 必须一致（导入时计算并校验）；删除密钥前必须检查引用（引用存在时改为“标记待删除”并提示）。
索引：`UNIQUE(fingerprint_sha256)`、`INDEX(name COLLATE NOCASE)`。

### 2.6 KnownHost（已知主机）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 记录 ID | — |
| `host` | TEXT(255) | 是 | 主机名或 IP（规范化小写；IPv6 原样） | — |
| `port` | INTEGER | 是 | 端口（同主机不同端口分别信任） | 22 |
| `key_type` | TEXT(32) | 是 | 如 `ssh-ed25519`、`rsa-sha2-512`、`ecdsa-sha2-nistp256` | — |
| `public_key` | TEXT | 是 | Base64 公钥 blob | — |
| `fingerprint_sha256` | TEXT(64) | 是 | SHA-256 指纹 | — |
| `status` | TEXT(16) | 是 | `trusted` / `changed` / `revoked` | `trusted` |
| `previous_fingerprint` | TEXT(64) | 否 | 最近一次变更前的指纹 | NULL |
| `first_seen_at` | INTEGER | 是 | 首次信任时间 | 当前时间 |
| `last_seen_at` | INTEGER | 是 | 最近连接成功时间 | 当前时间 |
| `changed_at` | INTEGER | 否 | 检测到变更的时间 | NULL |
| `source` | TEXT(16) | 是 | `prompt` / `import` / `manual` / `sync` | `prompt` |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：`UNIQUE(host, port, key_type)`；`status=changed` 时连接必须阻断；同一 `(host, port)` 允许存在多条不同 `key_type` 记录（算法协商不同）。
索引：`UNIQUE(host, port, key_type)`、`INDEX(status)`。

### 2.7 Snippet（片段与宏）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 片段 ID | — |
| `group_id` | TEXT(26) | 否 | 片段分组（`Group.kind=snippet`） | NULL |
| `kind` | TEXT(16) | 是 | `snippet` / `macro` | `snippet` |
| `name` | TEXT(128) | 是 | 显示名 | — |
| `body` | TEXT(8192) | 条件 | 片段正文；支持 `${var}` 占位（`kind=snippet`） | NULL |
| `variables_json` | JSON | 否 | 变量定义 `[{name, label, default, required, secret}]` | `[]` |
| `macro_steps_json` | JSON | 条件 | 宏步骤数组（`kind=macro`），见 §2.7.1 | NULL |
| `send_mode` | TEXT(12) | 是 | `insert`（不回车）/ `execute`（回车） | `insert` |
| `shortcut` | TEXT(32) | 否 | 快捷键字符串（平台无关表示，如 `Ctrl+Alt+1`） | NULL |
| `sort_order` | INTEGER | 是 | 排序 | 1024 |
| `tags_json` | JSON | 否 | 标签 | `[]` |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：`kind=snippet` 必须有 `body`；`kind=macro` 必须有 `macro_steps_json`；同一分组内名称唯一。
索引：`INDEX(group_id, sort_order)`、`INDEX(kind)`。

#### 2.7.1 `macro_steps_json`

```json
[
  { "type": "text",  "value": "cd /var/log", "per_key_delay_ms": 0 },
  { "type": "key",   "value": "Enter", "modifiers": [] },
  { "type": "wait",  "match": "regex", "pattern": "\\$ $", "timeout_ms": 5000 },
  { "type": "sleep", "ms": 500 },
  { "type": "call",  "snippet_id": "01J...B" }
]
```

约束：`type` ∈ {text,key,wait,sleep,call}；`wait.pattern` 长度 ≤ 512；`call` 深度 ≤ 5（防递归）。
安全：宏内容不得被自动执行；`send_mode=execute` 与危险命令规则（TERM-014）同样适用。

### 2.8 PortForwardRule（端口转发规则）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 规则 ID | — |
| `session_id` | TEXT(26) | 否 | 绑定会话（NULL 表示独立规则，需指定连接方式） | NULL |
| `name` | TEXT(128) | 是 | 显示名 | — |
| `type` | TEXT(12) | 是 | `local` / `remote` / `dynamic` | `local` |
| `bind_host` | TEXT(64) | 是 | 监听地址（local/dynamic 为本机；remote 为远端绑定） | `127.0.0.1` |
| `bind_port` | INTEGER | 是 | 监听端口（1–65535；0 表示由系统分配，仅 local/dynamic） | — |
| `dest_host` | TEXT(255) | 条件 | 目标主机（local/remote；dynamic 为空） | NULL |
| `dest_port` | INTEGER | 条件 | 目标端口 | NULL |
| `auto_start` | INTEGER | 是 | 会话连接后自动启动 | 0 |
| `auto_reconnect` | INTEGER | 是 | 断线自动重连 | 1 |
| `reconnect_max` | INTEGER | 是 | 最大重试次数 | 7 |
| `socks_auth` | TEXT(12) | 是 | `none` / `userpass`（仅 dynamic） | `none` |
| `socks_username` | TEXT(64) | 否 | SOCKS 用户名（非秘密） | NULL |
| `socks_password_ref` | TEXT(26) | 否 | SOCKS 密码秘密引用 | NULL |
| `expose_warning_ack` | INTEGER | 是 | 已确认通配绑定风险 | 0 |
| `sort_order` | INTEGER | 是 | 排序 | 1024 |
| `created_at` / `updated_at` / `deleted_at` | INTEGER | 是 | 生命周期 | — |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据 | 0/NULL/1 |

约束：
- `type=local|remote` 时 `dest_host`、`dest_port` 必填；`dynamic` 时二者必须为 NULL。
- 同一 `session_id` 下 `(bind_host, bind_port)` 唯一（`bind_port=0` 除外）。
- `bind_host` 为 `0.0.0.0` 或 `::` 时 `expose_warning_ack` 必须为 1。
索引：`INDEX(session_id, sort_order)`、`UNIQUE(session_id, bind_host, bind_port)`（`bind_port>0`）。

### 2.9 Settings（设置）

采用“作用域 + 键 + JSON 值”模型，避免频繁改表。

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 记录 ID | — |
| `scope` | TEXT(16) | 是 | `global` / `terminal_profile` / `shortcut_profile` / `monitor_profile` | `global` |
| `scope_id` | TEXT(26) | 否 | 子配置 ID（如终端配置 ID）；`global` 为 NULL | NULL |
| `key` | TEXT(128) | 是 | 点分键名，如 `ui.theme`、`terminal.font_size` | — |
| `value_json` | JSON | 是 | 值（任意 JSON 标量/对象） | — |
| `value_type` | TEXT(12) | 是 | `string` / `number` / `boolean` / `json` | `json` |
| `syncable` | INTEGER | 是 | 是否参与同步（设备相关偏好设为 0） | 1 |
| `updated_at` | INTEGER | 是 | 更新时间 | 当前 |
| `version` / `origin_device_id` / `dirty` | — | 是 | 同步元数据（`syncable=0` 时为 0/NULL/0） | — |

约束：`UNIQUE(scope, scope_id, key)`。
不同步的键（示例）：`window.*`、`ui.sidebar_width`、`update.skipped_versions`、`telemetry.*`。
索引：`UNIQUE(scope, scope_id, key)`、`INDEX(dirty)`。

### 2.10 Device（设备）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `id` | TEXT(26) | 是 | 设备 ID（客户端生成 ULID；服务端权威） | — |
| `name` | TEXT(64) | 是 | 设备显示名（默认主机名，可改） | 主机名 |
| `platform` | TEXT(16) | 是 | `windows` / `macos` / `linux` | — |
| `arch` | TEXT(16) | 是 | `x86_64` / `arm64` | — |
| `app_version` | TEXT(32) | 是 | 应用版本 | — |
| `device_public_key` | TEXT | 是 | 设备签名公钥（Ed25519，Base64）；用于中继票据与设备绑定 | — |
| `created_at` | INTEGER | 是 | 注册时间 | — |
| `last_seen_at` | INTEGER | 是 | 最近活动时间 | — |
| `last_sync_at` | INTEGER | 否 | 最近成功同步时间 | NULL |
| `revoked_at` | INTEGER | 否 | 吊销时间；非空即失效 | NULL |
| `revoke_reason` | TEXT(64) | 否 | `user` / `admin` / `security` | NULL |

约束：本地仅保存当前设备与服务端返回的设备列表快照；吊销由服务端执行，客户端在刷新令牌时获知。
索引：`INDEX(last_seen_at DESC)`、`INDEX(revoked_at)`。

### 2.11 SyncMetadata（同步元数据）

#### `sync_meta`（单行）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `vault_id` | TEXT(26) | 是 | 保险库 ID | — |
| `server_url` | TEXT(256) | 否 | 当前服务端 | NULL |
| `account_id` | TEXT(64) | 否 | 账号 | NULL |
| `device_id` | TEXT(26) | 否 | 当前设备 | NULL |
| `last_cursor` | INTEGER | 是 | 已应用的提交序号 | 0 |
| `last_push_at` | INTEGER | 否 | 最近成功推送 | NULL |
| `last_pull_at` | INTEGER | 否 | 最近成功拉取 | NULL |
| `last_error_code` | TEXT(64) | 否 | 最近同步错误 | NULL |
| `conflict_count` | INTEGER | 是 | 待解决冲突数（派生缓存） | 0 |
| `next_retry_at` | INTEGER | 否 | 退避重试时间 | NULL |
| `sync_state` | TEXT(16) | 是 | `idle` / `syncing` / `offline` / `conflict` / `error` / `paused` | `idle` |

#### `sync_record`（本地版本表）

| 字段 | 类型 | 必填 | 语义 | 默认值 |
|---|---|---|---|---|
| `record_id` | TEXT(26) | 是 | 记录 ID（与实体表主键对应） | — |
| `record_type` | TEXT(24) | 是 | `session` / `group` / `credential` / `ssh_key` / `known_host` / `snippet` / `port_forward` / `setting` / `secret` | — |
| `base_version` | INTEGER | 是 | 本地已知的服务端版本 | 0 |
| `local_rev` | INTEGER | 是 | 本地修改序号（每次本地写入 +1） | 0 |
| `server_checksum` | TEXT(64) | 否 | 最近一次服务端密文的 SHA-256 | NULL |
| `sync_state` | TEXT(16) | 是 | `clean` / `dirty` / `conflict` / `deleted` | `clean` |
| `conflict_json` | JSON | 否 | 冲突上下文（本地/远端密文副本引用、字段差异） | NULL |
| `updated_at` | INTEGER | 是 | 最近本地变更时间 | 当前 |

约束：`UNIQUE(record_id)`；实体写入与 `sync_record` 更新必须同一事务。
索引：`UNIQUE(record_id)`、`INDEX(sync_state, updated_at)`。

#### 冲突队列（可复用 `sync_record.conflict_json`）

```
conflict_json = {
  "kind": "same_field" | "delete_vs_modify" | "both_created",
  "local_ciphertext_ref": "rowid/or与本地快照",
  "remote_ciphertext_b64": "...",
  "remote_version": 42,
  "remote_device_id": "01J...",
  "detected_at": 1730000000000
}
```

---

## 3. 关系与外键约束

| 主体 | 关系 | 客体 | 删除行为 |
|---|---|---|---|
| Session | n→1 | Group | 分组删除时子项上移 |
| Session | n→1 | Credential | 凭据删除前检查引用；被引用时禁止删除或转“待替换” |
| Session | n→1 | SshKey | 同上 |
| Session | 1→n | PortForwardRule | 会话删除时规则标记删除（同步墓碑） |
| Credential | 1→1 | Secret | 同事务删除 |
| SshKey | 1→1 | Secret | 同事务删除 |
| Snippet | n→1 | Group(kind=snippet) | 分组删除时上移 |
| KnownHost | 弱引用 | Session.host:port | 不级联 |
| Device | — | 服务端 | 本地快照不级联 |

外键建议开启 `PRAGMA foreign_keys=ON`；跨实体删除由应用层事务保证同步墓碑一致性（先写实体 `deleted_at`，再写 `sync_record.sync_state=deleted`）。

---

## 4. 索引与查询特征

| 场景 | 查询 | 索引 |
|---|---|---|
| 会话树加载 | `WHERE deleted_at IS NULL AND group_id=? ORDER BY sort_order` | `(group_id, sort_order)` |
| 搜索 | 名称/主机/用户名模糊 | 建议 FTS5 影子表 `session_fts(name, host, username, tags)`；或前缀索引 + 应用层过滤 |
| 最近连接 | `ORDER BY last_used_at DESC LIMIT 20` | `(last_used_at DESC)` |
| 待同步 | `WHERE dirty=1 ORDER BY updated_at` | `(dirty, updated_at)` |
| 冲突 | `WHERE sync_state='conflict'` | `(sync_state)` |
| 未知主机校验 | `WHERE host=? AND port=?` | `UNIQUE(host, port, key_type)` |
| 转发自动启动 | `WHERE session_id=? AND auto_start=1` | `(session_id, auto_start)` |
| 设置读取 | `WHERE scope=? AND scope_id=? AND key=?` | 唯一索引 |

FTS 约束：FTS 表只索引非秘密字段；不使用分词器存储原始凭据。

---

## 5. 建议 SQLite 表与 JSON 列

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE vault (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  crypto_suite TEXT NOT NULL,
  kdf_alg TEXT NOT NULL,
  kdf_mem_kib INTEGER NOT NULL,
  kdf_time INTEGER NOT NULL,
  kdf_parallelism INTEGER NOT NULL,
  kdf_salt BLOB NOT NULL,
  wrapped_vault_key BLOB NOT NULL,
  key_check BLOB NOT NULL,
  keychain_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  account_id TEXT,
  quota_bytes INTEGER
);

CREATE TABLE session_group (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES session_group(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'session',
  sort_order INTEGER NOT NULL DEFAULT 1024,
  color TEXT,
  icon_key TEXT,
  expanded INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES session_group(id),
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  username TEXT,
  auth_method TEXT,
  credential_id TEXT,
  ssh_key_id TEXT,
  host_key_policy TEXT NOT NULL DEFAULT 'strict',
  proxy_jump_json JSON,
  proxy_id TEXT,
  terminal_profile_id TEXT,
  encoding TEXT NOT NULL DEFAULT 'UTF-8',
  startup_command TEXT,
  working_dir TEXT,
  keepalive_sec INTEGER NOT NULL DEFAULT 30,
  keepalive_max_miss INTEGER NOT NULL DEFAULT 3,
  auto_reconnect INTEGER NOT NULL DEFAULT 0,
  reconnect_max INTEGER NOT NULL DEFAULT 7,
  compression INTEGER NOT NULL DEFAULT 0,
  agent_forwarding INTEGER NOT NULL DEFAULT 0,
  x11_forwarding INTEGER NOT NULL DEFAULT 0,
  tags_json JSON NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  icon_key TEXT,
  notes TEXT,
  protocol_options_json JSON,
  last_used_at INTEGER,
  last_result TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  username TEXT,
  secret_id TEXT NOT NULL,
  hint TEXT,
  save_policy TEXT NOT NULL DEFAULT 'ask',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ssh_key (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_size INTEGER,
  public_key TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL UNIQUE,
  secret_id TEXT NOT NULL,
  passphrase_credential_id TEXT,
  has_passphrase INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE known_host (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trusted',
  previous_fingerprint TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  changed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'prompt',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  UNIQUE(host, port, key_type)
);

CREATE TABLE snippet (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES session_group(id),
  kind TEXT NOT NULL DEFAULT 'snippet',
  name TEXT NOT NULL,
  body TEXT,
  variables_json JSON NOT NULL DEFAULT '[]',
  macro_steps_json JSON,
  send_mode TEXT NOT NULL DEFAULT 'insert',
  shortcut TEXT,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  tags_json JSON NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE port_forward (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  dest_host TEXT,
  dest_port INTEGER,
  auto_start INTEGER NOT NULL DEFAULT 0,
  auto_reconnect INTEGER NOT NULL DEFAULT 1,
  reconnect_max INTEGER NOT NULL DEFAULT 7,
  socks_auth TEXT NOT NULL DEFAULT 'none',
  socks_username TEXT,
  socks_password_ref TEXT,
  expose_warning_ack INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE setting (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  key TEXT NOT NULL,
  value_json JSON NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'json',
  syncable INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, scope_id, key)
);

CREATE TABLE secret (
  id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  aad BLOB NOT NULL,
  crypto_suite TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT
);

CREATE TABLE sync_meta (
  vault_id TEXT PRIMARY KEY,
  server_url TEXT,
  account_id TEXT,
  device_id TEXT,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  last_push_at INTEGER,
  last_pull_at INTEGER,
  last_error_code TEXT,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'idle'
);

CREATE TABLE sync_record (
  record_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  base_version INTEGER NOT NULL DEFAULT 0,
  local_rev INTEGER NOT NULL DEFAULT 0,
  server_checksum TEXT,
  sync_state TEXT NOT NULL DEFAULT 'clean',
  conflict_json JSON,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_group_parent ON session_group(parent_id, sort_order);
CREATE INDEX idx_session_group ON session(group_id, sort_order);
CREATE INDEX idx_session_recent ON session(last_used_at DESC);
CREATE INDEX idx_session_dirty ON session(dirty, updated_at);
CREATE INDEX idx_snippet_group ON snippet(group_id, sort_order);
CREATE INDEX idx_forward_session ON port_forward(session_id, sort_order);
CREATE INDEX idx_setting_lookup ON setting(scope, scope_id, key);
CREATE INDEX idx_sync_state ON sync_record(sync_state, updated_at);
```

JSON 列一览：`session.proxy_jump_json`、`session.tags_json`、`session.protocol_options_json`、`snippet.variables_json`、`snippet.macro_steps_json`、`snippet.tags_json`、`setting.value_json`、`sync_record.conflict_json`。

---

## 6. 凭据与密钥保护边界

### 6.1 密钥层级

```
主密码（用户输入，仅内存）
  └─ Argon2id(salt, m=64MiB, t=3, p=1) → KEK(32B)
       └─ 包裹 VaultKey(32B 随机)：XChaCha20-Poly1305(wrapped_vault_key)
            └─ HKDF-SHA256(VaultKey, salt=record_id) → RecordKey(32B)
                 └─ 记录/秘密载荷：XChaCha20-Poly1305(ciphertext, nonce, AAD)
```

| 对象 | 加密方式 | 存放位置 | 服务端可见性 |
|---|---|---|---|
| VaultKey | 由 KEK 包裹 | `vault.wrapped_vault_key` | 可见密文 |
| 普通记录（会话/分组/片段/设置/转发） | RecordKey + AEAD | `*` 表外的密文列或 `record_blob`（实现可把整条 JSON 加密后存 BLOB） | 仅密文 |
| 秘密（密码/私钥/口令） | RecordKey（`secret:<id>`）+ AEAD | `secret` 表 | 仅密文 |
| 公钥、指纹、算法名、端口、时间 | 不加密（元数据） | 各表 | 可见（不含主机名等敏感字段时） |
| 会话主机名/用户名 | 属于记录载荷 | 加密 | 不可见 |

说明：本规格要求“服务端不可解密保险库”；本地数据库允许明文存储非秘密元数据（如 `port`、`protocol`、时间戳），但**主机名、用户名、会话名、备注、命令文本必须位于加密载荷内**。实现可选择“整记录加密 + 少量索引列”或“字段级加密”；无论哪种，§6.2 的边界必须满足。

### 6.2 边界规则（必须满足）

| 规则 | 说明 | 验证 |
|---|---|---|
| B-01 | 主密码、KEK、VaultKey、RecordKey 不得写入磁盘、日志、崩溃转储、网络请求 | SEC-001/004 扫描 |
| B-02 | 秘密载荷只能通过 Vault 接口读写，业务层不得直接访问 `secret.ciphertext` | 代码评审 + 依赖检查 |
| B-03 | 每条密文 nonce 唯一；AAD 必须绑定 `vault_id、record_id、record_type、key_version、schema_version` | SEC-003 篡改测试 |
| B-04 | 解密失败统一返回 `VAULT_DECRYPT_FAILED`，不区分“密码错/数据损坏” | 单元测试 |
| B-05 | 导出加密包使用独立 salt 与密码；不得复用主密码派生结果 | IMP-006 |
| B-06 | 系统钥匙串只存包裹后的 VaultKey 或 KEK 句柄，不存明文主密码 | SEC-006 |
| B-07 | 锁定后内存中的密钥材料尽最大努力清零；不保证防冷启动攻击，需在文档说明 | 代码评审 |
| B-08 | 同步上传的密文与本地密文同一套件；不得为服务端额外生成明文副本 | SYNC-004 |

### 6.3 Vault 接口语义（实现无关契约）

| 接口 | 输入 | 输出/行为 | 约束 |
|---|---|---|---|
| `init(master_password, kdf_params)` | 主密码、参数 | 创建 Vault 记录与密钥槽 | 密码强度校验；salt 随机 |
| `unlock(master_password)` | 主密码 | `UnlockedSession`（内存句柄） | 失败限速；成功后按需解密记录 |
| `lock()` | — | 清除内存密钥与解密缓存 | 幂等 |
| `change_master_password(old, new)` | 旧/新密码 | 重新包裹 VaultKey | 旧密码立即失效 |
| `seal_record(record_type, record_id, plaintext)` | 类型/ID/明文 JSON | `ciphertext, nonce, aad, key_version` | AAD 绑定版本 |
| `open_record(record_type, record_id, envelope)` | 信封 | 明文 JSON | 失败统一错误 |
| `seal_secret(secret_id, bytes)` | 秘密字节 | 信封 | 不记录长度以外信息 |
| `open_secret(secret_id, envelope)` | 信封 | 秘密字节 | 仅认证模块可调用 |
| `export_bundle(password, scope)` | 密码/范围 | `.osvault` 字节流 | 独立 salt；默认不含秘密 |
| `import_bundle(password, bytes)` | 密码/字节流 | 预览结果 | 先校验完整性再写入 |

算法可替换：`crypto_suite` 变化时旧套件仍需可读；不得对未知套件静默降级。

---

## 7. 导入/导出格式规格

### 7.1 OpenSSH config 语义（只读解析）

范围：解析 `Host` 块，生成 Session。语义按 OpenSSH 客户端配置的公开含义实现，不依赖任何第三方产品。

| 指令 | 映射 | 说明 |
|---|---|---|
| `Host` | 触发新会话；名称作为 `name`（别名） | 支持多个模式；通配符（`*`、`?`）不展开，作为标签与警告 |
| `HostName` | `host` | 缺省用 `Host` 别名 |
| `User` | `username` | |
| `Port` | `port` | 缺省 22 |
| `IdentityFile` | `ssh_key_id`（按路径匹配已导入密钥）或警告 | 支持 `~` 展开；不存在则列为警告 |
| `ProxyJump` | `proxy_jump_json` | 解析 `user@host:port` 与逗号分隔多跳；引用的别名在同文件内解析 |
| `LocalForward` | PortForwardRule(type=local) | 解析 `[bind:]port host:port`；支持 IPv6 方括号 |
| `RemoteForward` | PortForwardRule(type=remote) | 同上 |
| `DynamicForward` | PortForwardRule(type=dynamic) | `[bind:]port` |
| `ServerAliveInterval` | `keepalive_sec` | 秒 |
| `ServerAliveCountMax` | `keepalive_max_miss` | |
| `Compression` | `compression` | `yes/no` |
| `Include` | 递归解析 | 深度 ≤ 8；检测循环；通配符按字典序 |
| `Match` | 不支持 | 列入警告，不应用该块内的设置 |
| `ProxyCommand` | 不支持 | 列入警告；该会话仍可导入但不带代理命令 |
| 其他指令 | 忽略 | 在预览页“已忽略指令”中列出（最多 50 条） |

导入规则：
- 同一文件内重复 `(host, port, user)` 视为冲突，按 IMP-002 处理。
- 私钥不复制内容，只建立引用；未找到私钥时 `ssh_key_id=NULL` 并标记“需补充”。
- 导入是事务性的：预览确认后一次性写入或全部回滚。
- 幂等：记录 `import_fingerprint`（文件路径 + 块规范化内容的 SHA-256），重复导入同一文件默认“跳过未变化项”。

### 7.2 自有 JSON 格式（schema v1）

顶层信封：

```json
{
  "format": "openshell-export",
  "schema_version": 1,
  "exported_at": 1730000000000,
  "app_version": "0.1.0",
  "scope": ["sessions", "groups", "snippets", "port_forwards", "settings"],
  "include_secrets": false,
  "entities": {
    "groups": [ ... ],
    "sessions": [ ... ],
    "snippets": [ ... ],
    "port_forwards": [ ... ],
    "settings": [ ... ],
    "known_hosts": [ ... ]
  },
  "warnings": []
}
```

实体字段与 §2 同名同义；导入时可省略 `id`（生成新 ULID）或保留 `id`（需用户选择“合并/替换”）。未知字段保存在 `extra_json` 并告警。
`include_secrets=true` 时不得输出 JSON 明文；必须切换为 §7.4 的加密包格式。

### 7.3 CSV 格式

| 列 | 必填 | 类型 | 映射 |
|---|---|---|---|
| `name` | 是 | string | `session.name` |
| `host` | 是 | string | `session.host` |
| `port` | 否 | int | `session.port`（默认 22） |
| `username` | 是 | string | `session.username` |
| `protocol` | 否 | enum | `ssh/sftp/telnet/serial/local_shell`（默认 ssh） |
| `auth_method` | 否 | enum | 默认 `password` |
| `group_path` | 否 | string | 以 `/` 分隔的分组路径，自动创建 |
| `tags` | 否 | string | 以 `;` 分隔 |
| `notes` | 否 | string | 备注 |
| `credential_name` | 否 | string | 引用已存在凭据；不存在则警告 |
| `key_fingerprint` | 否 | string | 引用已存在密钥指纹 |
| `password` | 否 | string | **忽略并警告**；CSV 明文密码永不导入 |

规则：首行表头可选；编码 UTF-8（含 BOM 兼容）；分隔符 `,`（可通过列映射 UI 改为 `;`/Tab）；空行忽略；字段内引号按 RFC 4180。
导入结果与 CSV 行号一一对应，错误定位到行。

### 7.4 加密导出包 `.osvault`

| 段 | 内容 |
|---|---|
| 魔数 | `OSVLT1`（6 字节 ASCII） |
| 头（明文） | `{ "format":"osvault", "version":1, "kdf":"argon2id", "salt_b64":"...", "mem_kib":65536, "time":3, "parallelism":1, "cipher":"xchacha20poly1305", "nonce_b64":"...", "payload_sha256":"..." }`，长度前缀 4 字节大端 |
| 载荷 | AEAD 加密的 ZIP/JSON 字节；AAD = 头 JSON 规范化字节 |
| 尾部 | 头与载荷的 SHA-256（完整性快速校验） |

规则：密码长度 ≥ 10；错误密码或篡改统一返回“无法打开导出包”；包内禁止出现明文秘密（`include_secrets` 时秘密仍在 AEAD 载荷内二次加密或直接位于载荷内，取决于实现，但外层必须加密）。

### 7.5 迁移与冲突提示

| 场景 | 行为 | 用户可见提示（要点） |
|---|---|---|
| schema_version 升级 | 启动时检测 → 自动备份 `vault.db.bak-<schema>-<ts>` → 事务内迁移 | “正在升级数据格式，已创建备份” |
| 迁移失败 | 回滚事务 → 恢复备份 → 以旧版本只读模式启动 | 错误码 + 备份路径 + “导出诊断” |
| 导入冲突 | 预览页四选项（跳过/覆盖/保留两者/逐项） | 显示冲突字段差异（名称/主机/端口/凭据） |
| ID 冲突 | 保留 ID 但内容不同 → 视为冲突；新建副本使用新 ID | 说明“保留两者会创建副本” |
| 凭据缺失 | 导入后会话标记“需补充凭据” | 会话树显示警示点；连接前提示 |
| 不支持的字段 | 保留到 `extra_json`，不阻断导入 | 预览页“未知字段”计数 |

---

## 8. 生命周期、保留与备份

| 数据 | 保留策略 | 清除方式 |
|---|---|---|
| 软删除记录 | 30 天 | 定时任务物理删除 + 同步墓碑（服务端 TTL 90 天） |
| 终端日志 | 用户指定；默认 30 天/单文件 100 MB/保留 5 份 | 设置页清理 |
| 远程编辑缓存 | 上限 2 GB，LRU | 设置页清空 |
| 崩溃转储 | 默认关闭；开启后保留 5 份 | 诊断页清理 |
| 本地备份 | 每次迁移前 1 份；每日 1 份保留 7 天 | 设置页清理 |
| 监控时序数据 | 24 小时 | 自动清理 |
| 同步冲突副本 | 解决后保留 30 天 | 冲突面板清理 |
| 服务端快照 | 最近 10 个（客户端策略） | 配额面板删除 |

一致性要求：
- 实体写入 + `sync_record` 更新 + `dirty=1` 必须在同一事务。
- 秘密写入与元数据写入必须同一事务；禁止先写元数据后写秘密造成“引用悬空”。
- 备份必须是 SQLite 在线备份 API 或 WAL checkpoint 后的完整副本；禁止直接复制正在写入的 `.db` 文件。

---

## 9. 与同步 API 的字段一致性

| 本地字段 | API 字段 | 说明 |
|---|---|---|
| `sync_record.record_id` | `record_id` | 不透明字符串 |
| 实体 `version` | `version` | 服务端分配 |
| `sync_record.base_version` | `base_version` | 提交时携带 |
| `sync_meta.last_cursor` | `cursor` / `next_cursor` | 单调递增 |
| `deleted_at` | `deleted` + `deleted_at` | 墓碑 |
| `origin_device_id` | `device_id` | 产生该版本的设备 |
| 密文信封 | `ciphertext`（Base64） | 服务端不解析 |
| `server_checksum` | `checksum`（SHA-256） | 传输完整性 |

---

## 10. 假设

| 编号 | 假设 | 验证方式 |
|---|---|---|
| DM-A1 | 单 Vault 足够覆盖首版；多 Vault 仅预留 `vault_id` 列 | 用户访谈 + 数据迁移测试 |
| DM-A2 | SQLite 在 100k 记录、1 GB 数据下仍满足性能目标 | PERF-004 与大数据集压测 |
| DM-A3 | FTS5 在所有目标平台可用（随 SQLite 编译） | CI 三平台构建时检查 |
| DM-A4 | 记录级加密（整条 JSON）不会让冲突合并变得不可实现；客户端保留 base 明文快照用于三方合并 | SYNC-007 自动化用例 |
| DM-A5 | OpenSSH config 的通配符 `Host` 不需要展开为多会话 | IMP-001 样本验证 |
| DM-A6 | 第三方导出格式无法可靠确认字段语义，故不承诺具体适配器 | 仅在提供样本并确认后实现 IMP-007 |
