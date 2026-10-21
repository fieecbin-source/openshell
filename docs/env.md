# 开发环境记录（docs/env.md）

> 最后更新：2026-10-21（M0 环境准备）

## 1. 系统

| 项 | 值 |
|---|---|
| OS | Windows 10/11 x64（主机 `E:\Projects\openshell`） |
| PowerShell | 7+ |
| 时区 | Asia/Shanghai |

## 2. 已检测到的工具链

| 工具 | 版本 | 状态 | 说明 |
|---|---|---|---|
| Node.js | v24.21.0 | ✅ 满足 | REA 要求 24.11+，满足 |
| npm | 11.19.0 | ✅ | |
| pnpm | 12.5.1 | ✅ | 桌面端前端将使用 pnpm |
| Git | 2.55.0.windows.5 | ✅ | 仓库已初始化，`main` 为可构建分支 |
| JDK | OpenJDK 21.0.12.1 LTS | ✅ | 供 JADX / Ghidra 使用 |
| winget | v1.29.380 | ✅ | 用于自动安装缺失组件 |
| Rust (rustup/cargo) | rustup 1.29.1，stable 工具链安装中 | ⏳ | 已装 MSVC；`rustup toolchain install stable` 进行中 |
| MSVC Build Tools | 17.14.42（VCTools） | ✅ | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` |
| Docker Desktop | 未安装 | ❌ | M4/CI 前安装；用于本地 SSH 测试容器与 `docker compose` |
| REA (`rea-agents`) | 6.7.0 | ✅ | 全局安装；`rea setup --all-detected` 已完成 |
| JADX | 1.5.6 | ✅ | `E:\Tools\jadx-1.5.6\bin\jadx.bat` |
| Ghidra | 12.1.4 下载中断 | ⏳ | 570MB，`E:\Tools\ghidra_12.1.4.zip` 不完整；M0 未使用 |

## 3. REA 安装与注册

- 来源：npm 包 `rea-agents`（官方 GitHub: https://github.com/morluto/rea ，官网 https://rea.tools ）
- 安装命令：`npx rea-agents setup`
- 注册内容：为当前 agent 注册 MCP server 并安装配套工作流（slash commands / skills）
- 状态：执行中。完成后需重启/重载当前 IDE 的 agent/MCP 才能使用 REA 工具；届时暂停并请用户确认一次。

## 4. 目标分析对象（本机已安装，用户授权）

| 软件 | 安装目录 | 初步画像（仅目录名/大小，未反编译） |
|---|---|---|
| MobaXterm | `D:\Program Files (x86)\Mobatek\MobaXterm` | 原生 Windows 程序 + Cygwin 插件（`CygUtils*.plugin`）、`MobaXterm.exe`、`MobaRTE.exe`、`MobaXterm_installer.dat`、`version.dat` |
| FinalShell | `D:\Program Files\finalshell` | Java 程序（`finalshell.jar` ~49 MB + `jre/`），`config.json`、`conn/`、`sync/`、`theme/`、`knownhosts.json`、`finalshell.exe` 启动器 |

> 具体结论以 REA 探测结果与 `analysis/*` 文档为准。

## 5. 待办（环境侧）

- [ ] Rust + MSVC 安装完成后 `rustup default stable`，验证 `cargo --version`
- [ ] 安装 Docker Desktop（M4 前）
- [ ] 安装 Tauri 2 CLI（`cargo install tauri-cli` 或使用 npm `@tauri-apps/cli`）
- [ ] 安装 JADX / CFR / Vineflower（FinalShell jar 静态分析）
- [ ] 安装 Ghidra（MobaXterm 原生二进制，实验性）
- [ ] mitmproxy（联网行为观察，备用）
