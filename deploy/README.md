# 服务端部署

完整流程集中在 [个人同步服务端部署与 CI/CD](../docs/SYNC.md)。

- 推荐：Linux x86_64 二进制 + systemd + 已有 HTTPS 反代。
- 配置模板：[`systemd.env.example`](systemd.env.example)。真实 `.env` 只放服务器。
- CI/CD：[Deploy Server](../.github/workflows/deploy-server.yml) 只打包与传输服务端文件；普通 push 不写服务器，手动勾选 deploy 才安装。
- 客户端使用 `https://自己的域名`、`SYNC_USERNAME`、`SYNC_PASSWORD` 登录，无需注册。
- 当前桌面完整跨设备还原流程仍需接通，登录成功不能替代同步验收；具体限制见完整文档。
- 可选：[Docker Hub 公共镜像](../docs/DOCKER.md)，只拉取运行，无需源码和编译环境。

Docker 备选：

```bash
cd deploy
cp .env.example .env
nano .env
docker compose up -d --build openshell-server
```

必须填写自己的账号密码。默认只在本机 8085 提供 API，使用现有 HTTPS 反代；不需要前端、桌面壳或额外数据库。
不要同时运行 systemd 和 Docker 两个 OpenShell 实例，也不要把本机的数据目录压缩成安装包。
