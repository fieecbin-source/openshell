# OpenShell 自建服务端部署指南（deploy/README.md）

> 目标：提供单二进制 + Docker Compose + Caddy 自动化 HTTPS 的极简自建同步与分发服务端。
> 协议合规：遵循 `spec/sync-api.md`（SPEC-API-001）与 ADR-007 服务端架构决策。

---

## 1. 架构总览

- **运行时**：Rust 单二进制（Axum + Tokio + SQLite WAL / optional PostgreSQL），单进程极低内存占用（约 15MB 内存）。
- **反向代理**：Caddy 2.8 自动获取 Let's Encrypt / ZeroSSL 证书并终止 TLS，提供 HSTS 与 WebSocket 桥接。
- **数据保密性**：端到端加密（E2EE），服务端仅存储不透明的密文快照、增量变更集、版本号及审计元数据，**完全无法解密会话、密码、私钥、命令文本或主机名**。
- **默认模式**：单用户自建模式（`ALLOW_MULTI_USER=false`），首个账号注册后自动关闭公网注册入口，防止公网端口扫描滥用。

---

## 2. 快速启动（一键部署）

### 2.1 准备环境与配置文件

在部署服务器（Linux / VPS）上执行：

```bash
git clone https://example.invalid/openshell.git /opt/openshell
cd /opt/openshell/deploy

# 拷贝并填写环境变量
cp .env.example .env
nano .env
```

修改 `.env` 中的关键配置：
```dotenv
# 对外端口（高位端口，默认 8085，不占用 80/443）
SERVER_PORT=8085
# 是否启用 Caddy 自动 HTTPS（需要 80/443 空闲 + 域名已解析）
ENABLE_TLS=false
JWT_SECRET=YOUR_SUPER_SECRET_RANDOM_KEY_AT_LEAST_32_CHARS_LONG
BOOTSTRAP_TOKEN=your_one_time_bootstrap_token
```

### 2.2 启动服务

默认只启动 `openshell-server`，直接暴露在 `${SERVER_PORT}`（默认 8085）：

```bash
docker compose up -d
```

查看运行状态与健康检查：
```bash
docker compose ps
docker compose logs -f openshell-server
curl -fsSL http://127.0.0.1:8085/healthz
# 响应：{"status":"ok","version":"0.1.0","uptime_sec":12,"time":"2026-10-22T08:00:00.000Z"}
```

客户端「服务端地址」填：`http://<你的域名>:8085`（或 `http://<公网IP>:8085`），
并确保云厂商安全组 / 本机防火墙放行 8085。

### 2.3 可选：Caddy 自动 HTTPS（80/443 空闲时）

```dotenv
ENABLE_TLS=true
DOMAIN=sync.yourdomain.com
SITE_ADDRESS=sync.yourdomain.com
```

```bash
docker compose --profile tls up -d
curl -fsSL https://sync.yourdomain.com/healthz
```

此时客户端直接填 `https://sync.yourdomain.com`。
若机器 80/443 已被其它站点占用，请保持 `ENABLE_TLS=false`，用 8085 直连。

---

## 3. 首账号注册与引导

1. **首次注册**：
   在客户端设置面板中输入服务端地址 `https://sync.yourdomain.com`，点击“注册”。
   若设置了 `BOOTSTRAP_TOKEN`，在邀请码栏中填入该 Token。
2. **注册自动关闭**：
   单用户模式下，首个账号注册成功后，服务端自动将后续注册请求阻断并返回 `403 REGISTRATION_CLOSED`。

如需开启团队多用户注册：
在 `.env` 中设置 `ALLOW_MULTI_USER=true`，可选 `REQUIRE_INVITE=true` + `INVITE_CODE=custom_code`，随后执行 `docker compose up -d` 重新加载。

---

## 4. 数据备份与灾难恢复

### 4.1 SQLite 在线热备份（推荐每日定时执行）

SQLite 在 WAL 模式下提供原子一致性备份，无需停机：

```bash
#!/bin/bash
BACKUP_DIR="/data/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 在容器内安全执行 .backup
docker compose exec openshell-server sqlite3 /data/openshell-server.db ".backup '${BACKUP_DIR}/openshell-server.db'"

# 压缩归档
gzip "${BACKUP_DIR}/openshell-server.db"
echo "Backup completed: ${BACKUP_DIR}/openshell-server.db.gz"
```

### 4.2 灾难恢复演练

当需要从备份恢复时：
1. 停止服务：`docker compose down`
2. 解压备份并替换数据库文件：
   ```bash
   gunzip -c /data/backups/20261022_080000/openshell-server.db.gz > /var/lib/docker/volumes/deploy_server-data/_data/openshell-server.db
   ```
3. 启动并验证就绪端点：
   ```bash
   docker compose up -d
   curl -fsSL https://sync.yourdomain.com/readyz
   # 预期返回: {"status":"ready","db":"ok","migrations":"ok","relay":"off"}
   ```

---

## 5. 自动更新清单分发

服务端内置支持 OpenShell 客户端自动更新检查与安装包分发。

将构建产物放在 `/data/artifacts/` 目录中，在数据库中写入签名清单：
- 清单端点：`GET /updates/{target}/{version}`
- 产物下载：`GET /downloads/{artifact_id}`（支持断点续传 HTTP Range）
- 灰度发布：清单包含 `rollout: { percent: 25, seed: "2026-10" }`，客户端根据匿名安装 ID 自动分桶。

---

## 6. 可选中继服务（WebSocket TCP 隧道）

当需要穿越双重 NAT 访问内网 SSH 服务器时，可启用中继转发：
1. 在 `.env` 中设置 `RELAY_ENABLED=true`
2. 配置允许访问的网段：
   ```dotenv
   RELAY_ALLOWED_NETS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
   ```
3. 重启服务：`docker compose up -d`
4. 客户端连接时选择通过此服务器中继，建立 `Sec-WebSocket-Protocol: openshell.relay.v1` 加密字节流隧道。服务端仅记录流量字节数与连接耗时，不留存解密载荷。
