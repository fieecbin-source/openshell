# OpenShell

<p align="center">
  <img src="frontend/public/logo.svg" width="96" height="96" alt="OpenShell Logo" />
</p>

<p align="center">
  <strong>新一代企业级开源轻量 SSH / SFTP 客户端与端到端加密同步服务</strong><br />
  <em>无限速 · 功能简约 · 跨平台 · 开源免费 · 零知识数据安全</em>
</p>

<p align="center">
  <a href="https://github.com/fieecbin-source/openshell/releases"><img src="https://img.shields.io/github/v/release/fieecbin-source/openshell?color=0071e3&style=flat-square" alt="GitHub Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-orange?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/Rust-1.80%2B-red?style=flat-square&logo=rust" alt="Rust" />
  <img src="https://img.shields.io/badge/Tauri-v2-cyan?style=flat-square&logo=tauri" alt="Tauri" />
  <img src="https://img.shields.io/badge/E2EE-Argon2id%20%2B%20AES--256--GCM-green?style=flat-square" alt="Security" />
</p>

<p align="center">
  <a href="README.en.md"><strong>English</strong></a> | <strong>简体中文</strong>
</p>

---

## 💡 为什么选择 OpenShell？

市面上的很多终端工具（如 FinalShell、Xshell、MobaXterm、Termius 等）存在功能臃肿、商业限速、按月收费、内存占用高或闭源同步安全隐患。**OpenShell** 专为追求极致性能与安全的数据中心运维、后端开发者与 DevOps 工程师打造：

1. **⚡ 无限速与极致轻量**：基于 Rust + WebGL 硬件加速引擎，毫秒级冷启动，瞬时加载海量输出，绝无任何商业限速套路。
2. **🎯 功能简约克制**：摒弃多余复杂杂乱的商业推广与过度包装，专注终端会话、SFTP 传输、端口转发与实时无侵入式监控。
3. **🔒 零知识端到端加密 (E2EE)**：主机凭据与密钥本地使用 Argon2id + AES-256-GCM 硬件加密保护；自建服务端仅中继盲密文，哪怕数据库遭入侵也无法获知任何 IP 与密码。
4. **🌐 跨平台开箱即用**：提供 Windows / macOS (Apple Silicon & Intel) / Linux 原生桌面端安装包与免安装便携版。
5. **🪶 自建极简云同步**：单二进制服务端支持一键单用户初始化，免邮箱限制直接账号登录，配合 systemd 或 Docker 秒级部署。

---

## 🌟 核心功能特性

### 1. 终端与多协议连接
- **多协议调度**：原生支持 SSH（密码、带口令私钥、键盘交互、SSH-Agent、跳板机 ProxyJump）、本地 Shell（PowerShell / CMD / WSL / bash / zsh）与串口 Serial。
- **视图随心切换**：全终端、上下分屏、独立 SFTP 视图一键平滑切换，工作区常驻不中断底层连接。
- **高效多标签与全屏**：支持 `F11` / `Esc` 终端全屏沉浸模式，双击标签重命名、拖拽排序、快速复制副本与右键防误触保护。
- **动态字号缩放**：支持快捷键 `Ctrl/Cmd +` 放大、`Ctrl/Cmd -` 缩小、`Ctrl/Cmd 0` 重置字号；右键快捷清屏。

### 2. 交互式 SFTP 文件传输
- **流式分块传输**：基于 `russh-sftp` 64 KiB 流式分块传输，支持暂停、续传与实时速度统计。
- **目录智能联动**：内置 OSC 7 解析，终端命令行 `cd` 跳转时 SFTP 侧边栏秒级自动跟随同步。
- **远程文件即时修改**：内置轻量代码编辑器，支持 `Ctrl+S` 修改后自动回传远端覆盖。

### 3. 免 Agent 无侵入式监控大屏
- **零 Agent 探针**：连接 SSH 后周期非阻塞采集 Linux `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df -P`, `ps -eo`，服务器无需安装任何 Agent。
- **一键往返无感切换**：顶栏或快捷键唤出酷炫监控大屏，再次点击随时返回终端，会话输入输出零丢失。
- **指标实时动效**：多核 CPU 负载、物理内存 / Swap、网络瞬时上行/下行速率、磁盘挂载点容量实时图表与进程管理器。

### 4. 端口转发与安全审计
- **集中网络隧道**：本地端口转发（-L）、远端反向转发（-R）、动态 SOCKS5 代理（-D RFC 1928/1929）。
- **SOCKS5 安全认证**：支持无密码与 RFC 1929 用户名口令认证。
- **安全审计告警**：绑定通配地址 `0.0.0.0` 时强制弹出风险确认，防范资产全网暴露。

### 5. 跨平台云同步与自建服务
- **单用户极简开箱**：服务端启动时自动初始化单用户模式，无需邮箱验证，直接输入账号密码即可登录。
- **无锁版本仲裁**：客户端与服务端自动检测版本差异，提供快速同步与本地重置清理。
- **生产级部署生态**：提供详细的 systemd 守护进程脚本、Docker Compose 模板与自动 SSL 证书反向代理方案。

---

## 📦 客户端下载矩阵

前往 [GitHub Releases](https://github.com/fieecbin-source/openshell/releases) 获取最新正式版：

| 操作系统 | 安装包类型 | 说明与适用架构 |
| :--- | :--- | :--- |
| **Windows** | `.exe` (NSIS 安装包) | Windows 10 / 11 / Server (x86_64) |
| **Windows** | `.zip` (**便携免安装版**) | 解压即用，适合 U 盘携带或免管理员权限环境 |
| **macOS** | `.dmg` (Universal 安装包) | 同时原生支持 Apple Silicon (M1/M2/M3/M4) 与 Intel 架构 |
| **macOS** | `.zip` (**便携解压版**) | 解压后包含 `OpenShell.app`，直接双击运行 |
| **Linux** | `.AppImage` | 免安装单文件，赋予执行权限后直接运行 |
| **Linux** | `.deb` | 适用于 Debian / Ubuntu / Mint 等发行版 |
| **服务端** | `.tar.gz` (Linux 独立二进制) | 包含 `openshell-server`、`deploy/` 与快速配置脚本 |

每个发布版本均附带 `SHA256SUMS.txt` 哈希校验清单。

---

## 🚀 自建同步服务端快速上手

个人用户推荐 Linux x86_64 二进制 + systemd + 已有 HTTPS 反向代理。部署仅传输服务端程序与配置，不上传前端或桌面客户端。

**当前状态：域名、账号、密码可用于登录；桌面端的跨设备解密与业务数据还原入口尚需接通，不能把登录成功当作完整同步完成。**

### 方式 1：Systemd 守护进程部署 (推荐)

```bash
# 先按完整指南创建 /opt/openshell/deploy/.env，设置自己的同步账号密码。
# GitHub Actions → Deploy Server (Self-Hosted Sync) → Run workflow
# 不勾选 deploy：只测试与构建；勾选 deploy：只上传并安装服务端产物。
# 客户端地址示例：https://sync.example.com，选择“登录”。
```

### 方式 2：Docker Compose 容器化部署

```bash
cd deploy
cp .env.example .env
docker compose up -d --build openshell-server
```

完整的首次安装、域名 HTTPS、GitHub Secrets、CI/CD、Docker 迁移和同步限制详见 [个人服务端部署指南](docs/SYNC.md)。

---

## ⌨️ 常用快捷键速查

| 快捷键 | 功能操作 |
| :--- | :--- |
| `Ctrl + K` / `Cmd + K` | 打开快速命令面板 (全局搜索会话、直连与切换主题) |
| `F11` | 切换终端沉浸全屏模式 |
| `Esc` | 退出全屏 / 关闭监控大屏返回终端 |
| `Ctrl + +` / `Cmd + +` | 放大终端字体 |
| `Ctrl + -` / `Cmd + -` | 缩小终端字体 |
| `Ctrl + 0` / `Cmd + 0` | 恢复终端默认字体大小 |
| `Ctrl + F` / `Cmd + F` | 终端文本增量与正则高亮搜索 |
| 标签双击 | 重命名当前会话标签 |

---

## 🛠️ 本地开发与代码贡献

请参阅我们的 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详细的开发环境准备、代码规范、测试验证与 PR 流程。

```bash
# 1. 安装前端依赖
cd frontend
npm install

# 2. 运行前端开发环境
npm run dev

# 3. 运行 Tauri 桌面端热重载
cd ..
npm run tauri dev
```

---

## 📄 开源许可证与社区规范

- **许可证**：本项目采用 [Apache License 2.0](LICENSE) 开源协议。
- **行为准则**：本项目遵循 [Contributor Covenant 2.1](CODE_OF_CONDUCT.md)。
- **安全策略与漏洞披露**：详见 [SECURITY.md](SECURITY.md)。
