# OpenShell

<p align="center">
  <strong>轻量、极速、安全的新一代跨平台 SSH / 终端 / 串口 / SFTP / 监控客户端</strong>
</p>

<p align="center">
  <a href="https://github.com/fieecbin-source/openshell/releases"><img src="https://img.shields.io/github/v/release/fieecbin-source/openshell?color=blue&style=flat-square" alt="GitHub Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-green.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-orange?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/Rust-1.80%2B-red?style=flat-square&logo=rust" alt="Rust" />
  <img src="https://img.shields.io/badge/Tauri-v2-cyan?style=flat-square&logo=tauri" alt="Tauri" />
</p>

---

## 🌟 核心特性总览

OpenShell 是一款轻量、高性能、高安全的下一代跨平台桌面运维终端工作台，为对齐并超越 FinalShell、MobaXterm 等传统终端工具的核心体验而生：

### 1. 会话管理与连接调度
- **多协议连接**：原生支持 SSH（密码、带口令私钥、键盘交互、SSH-Agent、跳板机 ProxyJump）、本地系统 Shell（PowerShell / CMD / WSL / bash / zsh）与串口 Serial。
- **层级会话树**：支持多级嵌套分组、多维度毫秒级模糊检索、最近连接列表与收藏夹。
- **状态感知**：完整的连接状态机可视化与智能指数退避重连机制。

### 2. 终端极致体验
- **硬件加速渲染**：基于 xterm.js + WebGL GPU 硬件加速，支持 24-bit 真彩色与连字字体。
- **多标签与分屏**：支持无限标签卡、水平 / 垂直 / 四分屏灵活布局。
- **生产力套件**：
  - 增量与正则高亮搜索（`Ctrl+F`）；
  - 命令片段（Snippets）：参数占位符 `${VAR:-DEF}` 自动识别与交互替换填参；
  - 多会话同步输入（MultiExec）：跨标签实时广播输入，配备高危命令拦截防火墙（`rm -rf`, `mkfs`, `dd` 等二次安全确认）；
  - 8 套精选专业深色主题无缝切换与持久化。

### 3. 文件系统与 SFTP
- **双模文件管理**：终端旁 SFTP 侧边栏与独立文件管理器自由切换。
- **分块传输与断点续传**：基于 `russh-sftp` 64 KiB 流式分块传输，支持暂停 / 继续 / 取消与实时速率统计。
- **终端智能联动**：内置 OSC 7 解析器，终端 `cd` 切换目录时侧栏目录秒级自动跟踪同步。
- **远程文件编辑**：内置轻量代码编辑器，支持 `Ctrl+S` 修改后自动回传远端覆盖。

### 4. 零 Agent 服务器监控仪表盘
- **免安装探针**：连接 SSH 后周期非阻塞采集 Linux `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df -P`, `ps -eo`，服务器无需安装任何 Agent。
- **实时动效图表**：多核 CPU 负载、物理内存 / Swap、网络瞬时上行/下行速率、磁盘挂载点容量实时图表。
- **进程树与管控**：Top 进程过滤排序，支持 SIGTERM 与 SIGKILL 安全二次确认结束。

### 5. 端口转发与代理
- **集中转发管理**：本地端口转发（-L）、远端反向转发（-R）、动态 SOCKS5 代理（-D RFC 1928/1929）。
- **安全审计告警**：监听通配地址 `0.0.0.0` 时强制弹出安全警示弹窗。

### 6. 端到端加密（E2EE）保险库与自建同步服务端
- **银行级本地保护**：主密码通过 Argon2id 派生 KEK，数据记录使用 XChaCha20-Poly1305 AEAD 加密，强制绑定 AAD，数据库落盘零明文，内存离开作用域硬件级 zeroize 擦除。
- **备份与迁移**：支持导出 `.osvault` 加密备份包、兼容导入标准 OpenSSH `config` 与 FinalShell 历史连接。
- **自建同步服务端**：Axum 0.7 单二进制服务端，提供端到端密文同步、乐观锁版本冲突解决、差异快照回滚。配套生产级 Docker Compose + Caddy 自动 HTTPS 部署物料。

---

## 📦 跨平台安装包下载

前往 [GitHub Releases](https://github.com/fieecbin-source/openshell/releases) 获取最新预编译安装包：

| 平台 | 安装包格式 | 适用系统 |
|---|---|---|
| **Windows** | `OpenShell-<version>-windows-x86_64.exe` (NSIS) / `.msi` | Windows 10 / 11 / Server 2019+ (x86_64) |
| **macOS** | `OpenShell-<version>-macos-universal.dmg` (Universal) | macOS 12 Monterey 及以上（Apple Silicon & Intel） |
| **Linux** | `OpenShell-<version>-linux-x86_64.AppImage` / `.deb` | 主流 Linux 发行版（Ubuntu, Debian, Fedora, Arch 等） |

每个 Release 同时提供 `SHA256SUMS.txt` 校验清单与 `update-meta.json`、`latest.json` 更新元数据。

---

## 🔄 内置更新与数据保护

客户端自带应用内更新（无需手动下载重装）：

- **检查**：点击顶栏更新图标，或在「设置 → 关于与更新」中检查；默认启动 30 秒后自动检查、每 6 小时一次。
- **下载**：断点续传 + 进度/速度显示 + 磁盘空间预检，校验收到的安装包 sha256（下载后与安装前各一次）。
- **安装**：安装前自动把本地数据库快照到用户数据目录的 `backups/`，然后再拉起安装器。
- **数据永不随更新丢失**：连接配置、密钥与历史记录都在用户数据目录，与安装目录隔离；
  schema 升级失败会自动回滚并从快照恢复，本地数据版本高于客户端时拒绝覆盖。
- **可替换数据源**：内置 GitHub Release 源，支持备用清单源（`latest.json`）、下载镜像与代理设置，
  方便在内网或 GitHub 不稳定时使用。

安装包完整性、`update-meta.json` 字段、状态机与已知限制详见 [docs/UPDATE.md](docs/UPDATE.md)；
发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。

---

## 🚀 自建服务端快速部署

```bash
cd deploy
cp .env.example .env
# 编辑 .env 中的 DOMAIN 与 ADMIN_TOKEN
docker compose up -d
```
Caddy 将自动申请并配置 HTTPS 证书，服务端默认启用 SQLite WAL 并发池与健康检查端点。

---

## 🛠️ 本地开发与构建

### 前置环境
- Rust 1.80+ (`rustup default stable`)
- Node.js 20+ & pnpm (`npm install -g pnpm`)

### 启动开发环境
```bash
# 安装前端依赖
pnpm install

# 启动前端热重载开发服务器
pnpm dev

# 启动桌面端调试
pnpm tauri dev
```

### 构建生产包
```bash
# 格式化与静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# 构建桌面可执行文件
pnpm desktop:build
```

### 版本与发布

```bash
# 改版本号只改 frontend/package.json，然后同步其余两处
pnpm version:write
pnpm version:check

# 发布前检查（版本 + tag + CHANGELOG 一致性）
pnpm release:check
```

---

## 📄 开源许可证

本项目采用双重许可证：[MIT OR Apache-2.0](LICENSE)。
