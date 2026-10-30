# OpenShell 跨平台同步协议与自建服务端指南

OpenShell 提供完全开源、自建轻量的跨平台同步服务。用户只需在客户端输入**服务器地址 + 账号 + 密码**即可实现 Windows、macOS 与 Linux 多端数据一致。

---

## 1. 核心架构与端到端加密（Zero-Knowledge E2EE）

```
[客户端 A]                               [自建服务端]                             [客户端 B]
    │                                          │                                         │
    ├─ 1. 本地密码派生主密钥 (Argon2id)        │                                         │
    ├─ 2. 敏感凭据/密码/私钥端到端加密        │                                         │
    │    (XChaCha20-Poly1305 / AES-256-GCM)   │                                         │
    │                                          │                                         │
    ├─ 3. 推送增量密文变更 ───────────────────►│ (只持久化不可读密文)                   │
    │    (id, revision, seq, deviceId)         │                                         │
    │                                          │◄── 4. 拉取未同步变更 ───────────────────┤
    │                                          │    (since_seq, schemaVersion=2)         │
    │                                          │                                         │
    │                                          │                                         ├─ 5. 本地主密钥解密还原
    │                                          │                                         └─ 6. 冲突合并与版本递增
```

- **服务端零知识**：服务端只存储哈希密码与加密密文，即使服务器被完全攻破或数据库泄漏，攻击者也无法解密出用户的 SSH 密码、私钥明文或连接凭证。
- **增量同步与墓碑（Tombstone）机制**：每条记录带有全局递增的 `seq`、`revision` 与 `updated_at`；被删除的数据标记为墓碑，防止其它离线设备重连后“复活”已删除的主机。
- **冲突策略**：以单条记录为粒度，默认“后修改者胜”（Last-Write-Wins），同时在客户端自动保留旧版本到本地冲突备份并在界面提示。

---

## 2. 单用户自用服务端部署

服务端采用 Rust 单一二进制进程，内存占用低（~15MB RSS），内置 SQLite WAL 存储，无需配置外部大型数据库或复杂依赖。

### 2.1 环境变量配置 (`.env`)

复制 `deploy/.env.example` 到 `deploy/.env`：

```bash
# 1. 你的自用同步账号与登录密码（必填）
SYNC_USERNAME=admin
SYNC_PASSWORD=MySecurePassword123456!

# 2. 监听端口（默认 8085，避开常见的 80/443）
PORT=8085

# 3. 数据持久化目录（存放 SQLite 数据库与持久化密钥）
DATA_DIR=/opt/openshell/data

# 4. JWT 鉴权密钥（至少 32 字符，缺省则首次启动自动生成并写入 $DATA_DIR/.jwt_secret）
JWT_SECRET=
```

### 2.2 Systemd 服务运行 (推荐)

1. 创建运行用户并准备目录：
   ```bash
   sudo useradd -r -s /bin/false openshell || true
   sudo mkdir -p /opt/openshell/bin /opt/openshell/deploy /opt/openshell/data
   sudo chown -R openshell:openshell /opt/openshell
   ```

2. 部署服务文件：
   ```bash
   sudo cp deploy/openshell-server.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openshell-server
   ```

3. 检查运行状态与日志：
   ```bash
   systemctl status openshell-server
   journalctl -u openshell-server -f
   ```

### 2.3 反向代理配置（HTTPS / TLS）

建议在公网通过 Caddy 或 Nginx 提供 HTTPS 支持。

#### Caddy 示例
```caddy
sync.yourdomain.com {
    reverse_proxy 127.0.0.1:8085
}
```

#### Nginx 示例
```nginx
server {
    listen 443 ssl http2;
    server_name sync.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/sync.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.yourdomain.com/privkey.pem;

    client_max_body_size 64M;

    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 3. GitHub Actions 自动化部署 (`deploy-server.yml`)

在 GitHub 仓库的 **Settings -> Secrets and variables -> Actions** 中配置以下 Secrets：

| Secret 键名 | 说明 | 示例 |
|---|---|---|
| `DEPLOY_HOST` | 服务器公网 IP 或域名 | `1.2.3.4` / `sync.yourdomain.com` |
| `DEPLOY_PORT` | SSH 连接端口 | `22` |
| `DEPLOY_USER` | 具备部署权限的用户 | `root` / `ubuntu` |
| `DEPLOY_SSH_KEY` | 对应的私钥文本 | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `DEPLOY_PATH` | 远程部署路径 | `/opt/openshell`（默认） |

配置完成后，向 `main` 分支提交代码或在 Actions 页面手动点击 **Run workflow**，即可自动编译并原子热替换远程服务，失败自动回滚。

---

## 4. API 列表与协议结构 (Schema Version 2)

所有同步接口均带有统一的 JWT Bearer 鉴权与协议版本头。

| 接口 | 方法 | 描述 |
|---|---|---|
| `/healthz` | GET | 服务端健康检查探针 |
| `/v1/auth/login` | POST | 客户端鉴权（支持单用户用户名/密码）返回 Access + Refresh Token |
| `/v1/auth/refresh` | POST | 刷新已过期的 Access Token |
| `/v1/sync/v2/commit` | POST | 增量推送实体变更（带 schemaVersion、tombstone、revision） |
| `/v1/sync/v2/changes` | GET | 拉取增量变更列表（带 since_seq 参数） |
| `/v1/sync/head` | GET | 查询服务端当前最新全局序列号 |

---

## 5. 常见问题 (FAQ)

- **Q: 忘记了同步密码怎么办？**  
  A: 如果修改了服务端的 `SYNC_PASSWORD`，服务端重启时会自动更新哈希。注意如果客户端修改了本地主保险库口令，需要输入新口令重新派生端到端加密密钥。
- **Q: 离线断网时操作会丢失吗？**  
  A: 不会。客户端为离线优先架构（Offline-First），所有新建与修改会话均立即持久化在本地 SQLite WAL 中，网络恢复后自动防抖推送到云端。
