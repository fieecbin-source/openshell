# 服务端部署

完整流程集中在 [个人同步服务端部署与 CI/CD](../docs/SYNC.md)。

- 推荐：Docker Hub 公共镜像 + 服务器私有 env + 已有 HTTPS 反代；无需在服务器编译。
- 配置模板：[`systemd.env.example`](systemd.env.example)。真实 `.env` 只放服务器。
- CI/CD：[Deploy Server](../.github/workflows/deploy-server.yml) 只打包与传输服务端文件；普通 push 不写服务器，手动勾选 deploy 才安装。
- 客户端使用 `https://自己的域名`、`SYNC_USERNAME`、`SYNC_PASSWORD` 登录，无需注册。
- 1.1.3 登录会导入同步保险库并完成首次同步；旧保险库首次绑定与密码变更的限制见完整文档。
- 镜像 CI：[Deploy Server (Docker Hub Image)](../.github/workflows/deploy-server-image.yml)，只上传辅助脚本并拉取运行镜像。

Docker 备选：

```bash
cd deploy
cp .env.example .env
nano .env
docker compose up -d --build openshell-server
```

必须填写自己的账号密码。默认只在本机 8085 提供 API，使用现有 HTTPS 反代；不需要前端、桌面壳或额外数据库。
不要同时运行 systemd 和 Docker 两个 OpenShell 实例，也不要把本机的数据目录压缩成安装包。
