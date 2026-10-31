# Docker Hub 镜像部署（可选）

<img src="assets/docker.svg" alt="Docker" width="32" />

Docker Hub 是其中一种部署方式。仍可选择 [二进制与 systemd](SYNC.md) 或自行从源码构建 Docker 镜像。
这里的镜像由 OpenShell 项目维护，不代表 Docker Official Images 认证。

## 用户：拉取后直接运行

公开镜像：[yilecbin/openshell-server](https://hub.docker.com/r/yilecbin/openshell-server)。镜像同时支持 `linux/amd64` 和 `linux/arm64`。
服务器只需 Docker，无需 Node.js、Rust、前端源码或本地编译。

先创建自己的 `openshell.env`（不要提交到 Git）：

```dotenv
SYNC_USERNAME=your_account
SYNC_PASSWORD=replace_with_your_strong_password
```

把两个值换成自己的账号和长密码。此文件用于 `docker --env-file`，值无需添加引号。
镜像没有预设账号、密码、数据库、连接或缓存，示例密码不会被允许启动。

```bash
docker pull yilecbin/openshell-server:1.1.3
docker run -d --name openshell-server --restart unless-stopped \
  --env-file ./openshell.env \
  -p 127.0.0.1:8085:8080 \
  -v openshell-server-data:/data \
  yilecbin/openshell-server:1.1.3
```

也可以使用下列一条命令；先将账号、密码替换为自己的值（示例密码会被拒绝启动）：

```bash
docker run -d --name openshell-server --restart unless-stopped \
  -e SYNC_USERNAME=your_account \
  -e SYNC_PASSWORD=replace_with_your_strong_password \
  -p 127.0.0.1:8085:8080 -v openshell-server-data:/data \
  yilecbin/openshell-server:1.1.3
```

具名数据卷保存数据库与随机 JWT 密钥，重启、拉取新镜像不会清空账号或同步数据。
需要锁定版本时，把 `latest` 换成已发布版本号或镜像 digest。

已有 HTTPS 网站只需将**自己的域名**反向代理到 `127.0.0.1:8085`：

```caddy
sync.example.com {
    reverse_proxy 127.0.0.1:8085
}
```

客户端填写 `https://sync.example.com`（换成自己的域名）、自己的账号、自己的密码，选择“登录”。
Docker 容器不会修改 DNS、接管其它站点或安装额外反代。默认不对公网暴露 8085。

检查：

```bash
docker logs --tail 100 openshell-server
docker inspect --format '{{.State.Health.Status}}' openshell-server
curl -fsS http://127.0.0.1:8085/readyz
```

**应用能力限制仍见 [同步验收说明](SYNC.md#5-客户端与同步验收)**：镜像部署成功和账号登录成功，不能替代当前桌面跨设备还原入口的集成工作。

## 可选：只拉镜像的 Compose

下载仓库 `deploy/compose.image.yml`，将 `openshell.env` 放在同一目录，执行：

```bash
OPENSHELL_IMAGE=yilecbin/openshell-server:1.1.3 \
  docker compose -f compose.image.yml up -d
```

该文件没有 `build`，不会拉取项目源码，也不包含桌面壳或其它业务服务。
不要与已有的 systemd / Docker 实例重复占用同一个端口；旧数据迁移按 [迁移说明](SYNC.md#4-已有-docker-实例迁移与-docker-备选) 操作。

## 维护者：构建、验证与发布

GitHub Actions 的 **Docker Hub Server Image** 流水线：

1. 原生 amd64、arm64 runner 分别构建仅含服务端的镜像。
2. 检查非 root 运行、无内置账号和源码；验证实际登录、数据与 JWT 密钥重启持久化。
3. 测试通过后使用 Docker 官方 login/build-push actions 推送两个架构。
4. 合并为同一个多架构版本标签，稳定版同时更新 `latest`。已发布的版本标签不覆盖。

配置 `DOCKERHUB_USERNAME`（Actions Variable 或 Secret）和 `DOCKERHUB_TOKEN`（Read/Write PAT，Actions Secret）。
令牌只用于 CI 登录 Docker Hub，不进入 Dockerfile、镜像层或用户安装包。
普通 push 只构建测试；手动 Run workflow 勾选 `publish` 或发布新 GitHub Release 才推送镜像。
通过 `published-server-image` artifact 可读取实际镜像地址和架构信息。

Docker 官方 MCP 可在本地查询镜像与管理仓库，但用户拉取公共镜像不需要 MCP，也不需要 Docker Hub 登录。

## 图标来源

本页 Docker SVG 来自 [Docker 官方品牌资源](https://www.docker.com/company/newsroom/media-resources/)，保持原始图形与品牌色；
应用功能图标使用 [Lucide](https://lucide.dev/) 标准 SVG，许可见 `THIRD_PARTY_NOTICES.md`。不使用生成式图片或自创品牌替身。
