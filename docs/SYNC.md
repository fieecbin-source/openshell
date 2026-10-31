# 个人同步服务端：域名、账号、密码与 CI/CD

个人用户推荐使用 **Linux x86_64 + 单个 `openshell-server` 二进制 + systemd + 已有 HTTPS 反向代理**。
服务端不需要桌面客户端、Node.js、前端页面、Tauri、GTK/WebKit 或外部数据库。

## 先区分部署、登录和真正同步

服务端的 `SYNC_USERNAME` / `SYNC_PASSWORD` 用于登录；客户端填写 HTTPS 根地址、该账号、该密码，选择“登录”，不需要注册。
设置这两个环境变量后，服务端启动时创建账号；以后修改密码并重启会更新该账号密码哈希。不要随意更换账号名，否则会创建另一个账号。

**当前客户端尚不能承诺只填三项就完成跨设备数据还原。** `SyncService::sync_now()` 仍走旧接口，拉取后只更新同步元数据，
尚未接通 `sync_codec::apply_remote_records()`，也未完整处理新设备的远端保险库密钥导入。
因此“登录成功”“推送数量大于零”不能作为完整同步验收结果。本地保险库还需设置并解锁；服务端登录密码不会自动变成本地保险库密码。
协议 v2 的客户端、服务端与编解码模块已有独立测试，但实际桌面入口还需要集成验证。

## 1. 一次性准备服务器

下面以 Ubuntu 22.04/24.04 x86_64、安装位置 `/opt/openshell`、API 端口 8085 为例。
CI 的 glibc 二进制不适用于 Alpine 或 ARM64；这些环境请使用匹配的构建产物或自行构建。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl python3
sudo install -d -m 0755 /opt/openshell/deploy
sudo test -f /opt/openshell/deploy/.env || sudo install -m 0600 /dev/null /opt/openshell/deploy/.env
sudo nano /opt/openshell/deploy/.env
```

将下列内容写入该文件，替换自己的账号、密码。真实文件只留在服务器上，不提交 Git，也不写到客户端安装包。
密码包含空格、`#`、`$` 等字符时用单引号包围，不要在密码中放换行。

```dotenv
SYNC_USERNAME=my_account
SYNC_PASSWORD='replace_with_your_own_password'
HOST=127.0.0.1
PORT=8085
DATA_DIR=/opt/openshell/data
ARTIFACTS_DIR=/opt/openshell/data/artifacts
JWT_SECRET=
ALLOW_MULTI_USER=false
RELAY_ENABLED=false
RUST_LOG=openshell_server=info,tower_http=info
```

`JWT_SECRET` 留空时，服务端首次生成随机值并保存在 `data/.jwt_secret`，后续部署保留它。
部署脚本创建 `openshell` 系统用户，以该用户运行服务；SSH 部署用户需要 root 或免交互 sudo 权限。
自定义目录只支持 `/opt/...` 或 `/srv/...`，并需同步修改 `.env` 的两个数据路径。

### 首次手动安装 Release 服务端包

从 [GitHub Releases](https://github.com/fieecbin-source/openshell/releases) 下载
`openshell-server-<版本>-linux-x86_64.tar.gz` 和 `SHA256SUMS.txt`，在下载目录执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS.txt
mkdir server-unpacked
tar -xzf openshell-server-<版本>-linux-x86_64.tar.gz -C server-unpacked
id openshell >/dev/null 2>&1 || sudo useradd --system --shell /usr/sbin/nologin openshell
sudo install -d -m 0755 /opt/openshell/bin
sudo install -d -o openshell -g openshell -m 0700 /opt/openshell/data /opt/openshell/data/artifacts
sudo install -m 0755 server-unpacked/openshell-server /opt/openshell/bin/openshell-server
sudo install -m 0644 server-unpacked/deploy/openshell-server.service /etc/systemd/system/openshell-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now openshell-server
curl --noproxy '*' -fsS http://127.0.0.1:8085/readyz
```

将命令中的 `<版本>` 换成实际下载版本。不要把 Windows/macOS 安装包或整个源码目录上传到服务器。
已有实例升级时推荐下面的 CI/CD，它会先备份数据库并检查启动结果。

## 2. 接入自己的 HTTPS 域名

客户端应填写 `https://sync.example.com`，不添加 `/v1`、`/v2`、`/healthz` 或 `:8085`。
DNS 解析只是第一步，还需让该域名的 HTTPS 站点反向代理到 `127.0.0.1:8085`。

服务器已经运行 Nginx/Caddy/面板网站时，在原有反代里添加站点即可，不要再启动一个占用 80/443 的代理容器。
CI 不会安装、重启或覆盖现有反代，也不会操作其它服务。

Caddy 站点示例：

```caddy
sync.example.com {
    reverse_proxy 127.0.0.1:8085
}
```

Nginx 的现有 HTTPS `server` 块中加入：

```nginx
server_name sync.example.com;
client_max_body_size 16m;
location / {
    proxy_pass http://127.0.0.1:8085;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
}
```

Nginx 的证书路径和 443 监听沿用现有站点配置；上面不是完整的证书申请配置。
Cloudflare 使用 Full (strict) 模式时，源站也需有有效证书。客户端只访问 HTTPS 443，API 的 8085 不必对公网开放。

```bash
curl -fsS https://sync.example.com/healthz
curl -fsS https://sync.example.com/readyz
```

## 3. GitHub Actions：只构建与部署服务端

唯一服务端流水线为 [deploy-server.yml](../.github/workflows/deploy-server.yml)。旧的 `cd.yml` 已移除，避免 Docker 与 systemd 两套部署同时抢占端口。

```text
main 的服务端变更 / 手动运行
  → cargo test/clippy -p openshell-server
  → cargo build --release -p openshell-server
  → 仅打包二进制、安装脚本、systemd unit、配置模板 + SHA-256
  → 上传 Actions artifact
  → 仅手动勾选 deploy：SSH 上传 artifact → 校验 → 备份 → 替换 → /readyz 验证
```

构建不执行 `--workspace`，不安装桌面依赖、不编译前端。部署 job 不检出仓库、不 rsync 源码；
服务器不会收到 `frontend/`、桌面二进制、`node_modules/`、Rust `target/`、测试文件、本地缓存、数据库或密码。
普通 push 只构建和验证。只有手动运行并勾选 **deploy** 才修改服务器，客户端 Release 流水线不会触发服务端部署。

### 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 或 `production` environment 中配置：

| Secret | 内容 |
| --- | --- |
| `SERVER_HOST` | **源站真实 IP 或可直连 SSH 的主机名**，不能填 Cloudflare 橙云代理地址 |
| `SERVER_USER` | SSH 用户，具备 root 或免交互 sudo 权限 |
| `SERVER_PORT` | SSH 端口，默认 22；不是 API 端口 8085 |
| `SERVER_SSH_KEY` | 对应 SSH 私钥，完整多行文本 |
| `DEPLOY_DIR` | 可选，默认 `/opt/openshell` |
| `SERVER_KNOWN_HOSTS` | 可选，已核对指纹的 SSH known_hosts 内容；留空时使用 ssh-keyscan |

兼容旧配置 `DEPLOY_HOST / DEPLOY_USER / DEPLOY_PORT / DEPLOY_SSH_KEY / DEPLOY_PATH`，这些名称优先于上表同类项。
仓库现有的 `SERVER_*` 与 `DEPLOY_DIR` 可继续使用；同步账号密码直接在服务器 `.env` 设置，不需要发给 CI。

### 操作步骤

1. 在服务器完成 `.env` 和域名反代的一次性准备。
2. GitHub **Actions → Deploy Server (Self-Hosted Sync) → Run workflow**。
3. 选择包含这些文件的分支，勾选 **deploy** 后运行；不勾选只构建验证。
4. 查看 `Test and build server only`、`Install server on personal host` 两个 job。
5. 远端安装脚本校验 `.env`，创建运行用户，备份 SQLite，替换二进制与 unit，重启并等待 `/readyz`。
6. 本机执行公网 HTTPS 的健康检查，再用自己的账号在客户端选择“登录”。

启动失败会尝试恢复上一份二进制与 systemd unit；数据库不会自动降级，部署前快照保存在 `data/backups/`，
如涉及不兼容数据库升级，需停服后人工选择一致的数据库备份恢复。配置不完整时会在重启前退出，不拿模板密码启动服务。
此流水线没有自动配置 DNS、证书、防火墙或修改服务器上的反代。

## 4. 已有 Docker 实例迁移与 Docker 备选

systemd 与 Docker 只选一个。已有实例不可直接创建一个空数据库后称为“升级”。

迁移前先确认当前容器、Compose 项目及数据卷；用 SQLite backup API 导出一致快照，同时保留 `.jwt_secret` 与实际 `.env`。
停止**该 OpenShell 容器**后，再将数据复制到 `/opt/openshell/data` 并设置 `openshell:openshell` 所有者。
确认原来的 8085 端口已释放，再启动 systemd。不要删除 Docker 数据卷，也不要停止同机其它网站或杀占用端口的未知进程。
部署脚本发现其它实例占用端口时会失败，不会自行停掉该进程。

如继续使用 Docker，在源码仓库中：

```bash
cd deploy
cp .env.example .env
nano .env
# 填写 SYNC_USERNAME、SYNC_PASSWORD；已有 HTTPS 反代时保持 ENABLE_TLS=false
docker compose up -d --build openshell-server
```

Compose 已将这两个账号变量传入服务端，并默认只绑定 `127.0.0.1:8085`。
服务器没有 Docker 时，按前面的二进制方案部署，不必额外安装 Docker。

## 5. 客户端与同步验收

| 客户端字段 | 个人域名示例 |
| --- | --- |
| 服务器地址 | `https://sync.example.com` |
| 账号 / 用户名 | 服务器 `SYNC_USERNAME` |
| 密码 | 服务器 `SYNC_PASSWORD` |
| 操作 | 登录；单用户模式不用注册或邀请码 |

本地保险库密码是另一把解密密码。当前需要自行初始化、解锁；不要为了实现“三项登录”而把所有设备设置为公开的空密码，
也不能把开发机保险库打包给用户。新用户安装包没有预设保险库密码。

完整同步发布前必须用两套独立用户数据目录验证：A 新增主机/凭据 → B 能还原并连接；B 修改 → A 能收到；
删除与离线重连不复活旧记录；重启能恢复登录状态。当前版本的完整桌面入口尚未通过这一闭环，详见本文开头的限制。

现有 v2 路由是 `/v2/sync/commit`、`/v2/sync/changes`，不是 `/v1/sync/v2/...`。
排查命令：`systemctl status openshell-server`、`journalctl -u openshell-server -n 100 --no-pager`、
`curl --noproxy '*' -fsS http://127.0.0.1:8085/readyz`。不要把含密码、令牌的 `.env` 或请求正文贴到公开 issue。
