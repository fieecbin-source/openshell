# ADR-001：桌面外壳选型 —— Tauri 2 vs Electron

- 状态：已接受（M1）
- 日期：2026-10-21
- 关联：`docs/architecture.md` §2、§17；ADR-008

## 背景

产品目标是"轻量、跨平台、启动快"：安装包 ≤ 25 MB、冷启动 ≤ 1.5 s、空闲内存 ≤ 150 MB。桌面端需要：系统托盘/单实例、原生对话框、自动更新、签名打包、可访问本地文件与串口、能承载 xterm.js 终端并保持高吞吐。SSH/SFTP/转发等重活计划放在 Rust 侧，前端只负责视图与输入。

可选外壳：

1. Electron（捆绑 Chromium + Node.js）
2. Tauri 2（系统 WebView + Rust 后端，IPC 命令/事件）
3. 纯原生（Qt / egui / Flutter）

## 选项对比

| 维度 | Electron | Tauri 2 | 原生 UI |
|---|---|---|---|
| 安装包基线 | 80–150 MB | 8–20 MB | 10–40 MB |
| 空闲内存 | 150–300 MB | 70–150 MB | 40–120 MB |
| 渲染一致性 | 完全一致（自带 Chromium） | 依赖系统 WebView，存在差异 | 完全一致 |
| 前端生态（xterm.js） | 原生支持 | 原生支持 | 需自绘/嵌入 WebView |
| 后端能力 | Node/原生模块 | Rust 直接编译进二进制 | 取决于框架 |
| 自动更新 | electron-updater（成熟） | tauri-plugin-updater（签名清单） | 自建 |
| 安全面 | 大（Node 集成需加固） | 小（命令白名单 + capabilities） | 最小 |
| 维护成本 | 中（Chromium 版本跟进） | 中（WebView 兼容矩阵） | 高 |

## 决策

采用 **Tauri 2**。

理由：

1. 体积与内存目标只有 Tauri 能满足；Electron 的基线已接近或超过全部预算。
2. SSH/SFTP/加密/PTY 本来就要用 Rust 实现，Tauri 让这些能力零代价进入同一进程，避免 Node 原生模块的 ABI 与打包负担。
3. 命令白名单（capabilities）+ 无 Node 运行时，显著缩小攻击面；前端拿不到任意文件/网络能力。
4. 更新器原生支持签名清单与三平台安装包，符合目标文档要求。

不选 Electron 的补充理由：即使为"Chromium 特性"保留 Electron，本项目也没有必须依赖 Chromium 专有 API 的功能（终端、文件树、图表均为标准 Web 能力）。

不选纯原生的理由：终端仿真与文本排版需要成熟的 xterm.js 生态；自绘终端（ANSI 解析、真彩色、连字、选择、IME）成本远高于收益，且会让 UI 迭代变慢。

## 后果

**正面**

- 安装包与内存有希望达标；CI 三平台产物简单。
- Rust 核心 crate 可复用于未来 CLI/服务端工具。
- 权限模型清晰：前端只能调用显式注册的命令。

**负面与缓解**

| 后果 | 缓解 |
|---|---|
| WebView 差异（WebKitGTK 的渲染/IME/WebGL 缺陷，WebView2 版本碎片） | 只用标准 Web API；启动时做能力探测；WebGL 失败降级 canvas（ADR-008）；Linux 固定最低 webkit2gtk 4.1；CI 跑 e2e |
| macOS 不支持 `tauri-driver`，E2E 覆盖弱 | macOS 以构建 + 冒烟 + 手工清单补足；核心逻辑下沉到 Rust 单测 |
| Linux 打包依赖复杂（webkit2gtk、appindicator） | 固定 Ubuntu 22.04 构建镜像；AppImage 兜底；deb 显式声明依赖 |
| Windows 10 可能缺 WebView2 Runtime | 安装器检测并引导安装 Evergreen Bootstrapper；离线场景提供固定版本分发说明 |
| IPC 高频小消息开销 | 终端走二进制 Channel + 合并写 + 信用窗口（§7） |

## 验证与退出条件

- M2 结束前在三平台各测一次：冷启动、空闲内存、安装包体积、WebGL 可用性、输入法输入中文。
- 若 Linux WebKitGTK 无法稳定支撑终端渲染（例如持续崩溃或吞吐 < 2 MB/s），触发复议：可为**终端视图**单独引入轻量原生渲染方案，或整体迁移到 Electron（需新 ADR，不得静默更换）。
