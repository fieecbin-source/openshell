# Contributing to OpenShell

感谢你对 OpenShell 开源项目的关注与贡献！OpenShell 致力于打造一款**无限速、功能简约、跨平台、开源免费**的企业级现代化 SSH / SFTP 客户端与端到端加密同步服务。

我们非常欢迎来自社区的 Issue 报告、文档改进、代码优化与新功能实现。在提交贡献前，请花几分钟阅读以下指南。

---

## 🛠️ 环境准备

开发 OpenShell 需要本地具备以下基础工具链：

- **Rust**: 1.80.0 及以上稳定版本（推荐通过 [rustup.rs](https://rustup.rs/) 安装）
- **Node.js**: 20.x LTS 及以上（推荐 20 或 22）
- **npm / pnpm**: npm 10+
- **C/C++ 构建工具**:
  - Windows: Visual Studio C++ 生成工具 / MSVC
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential`, `libssl-dev`, `pkg-config`, `libwebkit2gtk-4.1-dev` (Tauri v2 依赖)

---

## 📁 仓库代码结构

```text
openshell/
├── backend/
│   ├── crates/            # 核心 Rust 模块库
│   │   ├── auth/          # 凭据保护与主保险库密钥派生 (Argon2id + AES-GCM)
│   │   ├── store/         # 本地 SQLite 存储、事务与版本迁移
│   │   ├── ssh/           # SSH/SFTP 协议引擎与底层会话管理
│   │   ├── tunnel/        # 端口转发 (-L / -R / -D) 与网络隧道
│   │   ├── sysinfo/       # Linux 远程服务器硬件指标探针采集
│   │   └── client_sync/   # 端到端加密客户端同步引擎
│   ├── desktop/           # Tauri v2 桌面壳工程 (跨平台桌面应用胶水层)
│   └── server/            # 跨平台自建同步服务端 (Actix-web + SQLite)
├── frontend/              # 现代前端 (React 18 + TypeScript + TailwindCSS + Vite)
├── deploy/                # 服务端生产部署脚本、systemd 配置与示例环境变量
├── docs/                  # 官方开发、升级与同步部署文档
└── scripts/               # 跨平台发布与打包自动化构建脚本
```

---

## 💻 本地开发与调试流程

### 1. 运行自建同步服务端 (可选)

```bash
cd backend/server
cargo run
```
默认监听 `http://127.0.0.1:8080`，首次启动会自动初始化单用户账号模式（可通过环境变量 `SYNC_USERNAME` 与 `SYNC_PASSWORD` 自定义）。

### 2. 运行前端开发服务器

```bash
cd frontend
npm install
npm run dev
```

### 3. 运行 Tauri 桌面端热重载

```bash
# 在项目根目录执行
npm run tauri dev
```

---

## 🌿 分支与提交规范

### 分支命名
- 新特性：`feat/<feature-name>`
- 问题修复：`fix/<bug-description>`
- 文档优化：`docs/<doc-topic>`
- 性能优化与重构：`refactor/<target-module>`

### Conventional Commits 提交格式
所有 Git Commit 消息遵循约定式提交规范：

```text
<type>(<scope>): <subject>

[可选 body 正文]
[可选 footer 关联 issue]
```

常用 `<type>`：
- `feat`: 新增特性或功能
- `fix`: 修复缺陷或错误
- `refactor`: 重构或代码清理（不影响外在行为）
- `perf`: 性能优化
- `docs`: 仅文档更新
- `test`: 增加或修改测试
- `ci`: CI/CD 自动化流水线修改

示例：
```text
feat(terminal): relocate view switcher above terminal and add fullscreen
fix(monitor): preserve terminal session when toggling monitor screen
docs(sync): add single-user bootstrap and deployment workflow
```

---

## ✅ 提交 PR 前的验证清单

在推送代码并创建 Pull Request 之前，必须在本地完整运行并确认以下检查项全部通过：

1. **Rust 检查与测试**:
   ```bash
   cargo check --workspace
   cargo test --workspace
   ```
2. **前端代码质量与构建测试**:
   ```bash
   cd frontend
   npm test
   npm run build
   ```
3. **格式与规范**:
   ```bash
   cargo fmt --check
   ```

---

## 🔒 安全与零知识架构约束

OpenShell 秉承极致的端到端数据安全：
- **永远不在服务端明文存储**：主机凭据、私钥、密码、连接历史在客户端本地经过主密钥派生加密后再传输。
- **不得引入泄露风险的埋点或第三方追踪**。
- 若发现任何可能危及凭据安全性的隐患，请勿公开发布 Issue，请参考 [SECURITY.md](SECURITY.md) 中的负责任披露指引进行私信反馈。

感谢你与我们一同让 OpenShell 更加出色！

