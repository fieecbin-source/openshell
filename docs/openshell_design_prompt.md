# GOAL：用 REA 分析 MobaXterm 与 FinalShell，重新设计并实现一款轻量、跨平台、功能全的 SSH/终端工具（含自建同步服务端）

> 把本文件整体作为 goal 提示词交给主控 agent（Claude Code / Codex 等均可）。主控 agent 自行拆分子 agent、循环迭代，直到满足第 9 节的验收条件。

---

## 0. 背景与最终目标

我是用户（下称"我"），本机已安装下面两款软件，我有权使用并分析它们的功能与设计：

- `D:\Program Files (x86)\Mobatek\MobaXterm`
- `D:\Program Files\finalshell`

目标：**分析这两款软件"功能是怎么设计的"**，取长补短，**重新设计并从零实现**一个新的 App：

- 轻量（安装包与内存占用显著小于 Electron 全家桶方案）、启动快、界面清晰
- 功能全（见第 5 节）
- **跨平台**：Windows / macOS / Linux 一套代码，CI 自动出三平台安装包
- 需要联网的部分（配置同步、更新分发、可选中继）**由我自己的公网服务器提供**，服务端我自己部署，代码与部署文件一并交付

---

## 1. 硬性约束（合规与边界，不可违反）

这是"分析功能设计后重新实现"，不是破解或换皮。REA 官方定位也是用于合法研究、互操作和分析自己有权检查的软件。

1. **洁净室原则**：分析阶段只产出"行为与设计规格文档"（功能清单、交互流程、数据模型、文件/配置格式语义、网络接口语义）。实现阶段的 agent **只能读规格文档，不得直接参照/拷贝**反编译出的代码、字符串表、图标、图片、字体、文案、品牌名、配色方案。新软件使用**全新的名字、Logo、UI 风格和自己编写的代码**。
2. **不做授权绕过**：不分析、不复现、不绕过任何许可证校验、激活、试用限制、付费墙、反调试/加壳保护；不仿冒官方授权服务器。服务端只做"我自己的同步/更新/中继"，不做对方的授权或账号体系仿制。
3. **只用我自己的账号与数据**做网络行为观察；不抓取他人数据，不对 MobaXterm / FinalShell 的官方服务器做压测、爆破或越权探测。
4. **只在本地分析**；不把对方安装包、二进制或反编译产物上传到任何第三方服务或提交进新项目仓库（分析产物放在 `analysis/` 并加入 `.gitignore`，仅规格文档可入库）。
5. 新项目的所有第三方依赖必须是宽松开源许可（MIT/Apache-2.0/BSD/MPL 等），在 `THIRD_PARTY_NOTICES.md` 中列出；避免 GPL 传染（如需用 GPL 组件，必须独立进程调用并说明）。
6. 凭据安全：不得把我的任何密码、密钥、Token 写入仓库或日志。

遇到上述边界之外的灰区，选择更保守的做法并在 `docs/decisions.md` 里记录理由。

---

## 2. 环境准备（缺什么自己下载安装，不要问我）

先检测、再安装，全部记录到 `docs/env.md`：

- Node.js（满足 REA 要求：22.19+ / 24.11+ / 26+）、npm、pnpm
- **REA**：`npx rea-agents setup`，给当前 agent 注册 MCP 并安装配套工作流，然后重启/重载 agent；官方来源只认 https://github.com/morluto/rea 、https://rea.tools 、npm 包 `rea-agents`
- 用 `rea --help` 与 REA 文档（`docs/installation.md`、`docs/cli.md`、`docs/desktop-applications.md`、`docs/javascript-application-workflows.md`、`docs/managed-code-analysis.md`、`docs/web-network-captures.md`、`docs/browser-observation.md`）确认可用命令
- 反编译/分析后端按目标类型选择：
  - 原生二进制：Ghidra（免费，需 JDK）；Windows 上 REA 的 Ghidra 支持为实验性，先读 `docs/windows-ghidra-p0.md`
  - Java 程序（FinalShell 通常是 Java + 自带 JRE，以 REA 探测结果为准）：用 REA 做安装目录探测，再下载 JADX / CFR / Vineflower 之类对 jar 做静态分析
  - .NET 组件：REA 自带静态 .NET 分析
  - 网络行为：mitmproxy 或浏览器/HAR 抓包，配合 REA 的网络捕获分析
- 开发工具链：Rust stable（rustup）、Tauri 2 CLI、pnpm、Docker、Git；Windows 额外需要 MSVC Build Tools 与 WebView2；Linux CI 需要 webkit2gtk 等依赖
- 初始化 git 仓库，约定分支策略：`main` 保持可构建，各 agent 在独立 worktree/分支工作，合并前必须通过 CI 检查

---

## 3. 多 Agent 协作与循环机制

主控 agent（Orchestrator）负责规划、派发、合并、验收，**自己不陷入细节**。用 Agent 工具并行派发独立任务，用 SendMessage 继续已有子 agent 的上下文。

### 角色

| 角色 | 职责 | 产出 |
|---|---|---|
| Recon-A（MobaXterm 分析） | 用 REA 探测安装目录、组件、配置文件格式、功能入口、会话/凭据存储方式 | `analysis/mobaxterm/*.md` + 规格摘要 |
| Recon-B（FinalShell 分析） | 同上，另加：监控面板、云同步/账号相关的网络行为（仅我自己的账号） | `analysis/finalshell/*.md` + 规格摘要 |
| Spec-Writer（洁净室隔离层） | 读取两份分析，提炼并去重，写出**与实现无关**的产品规格和 API 规格 | `spec/product.md`、`spec/data-model.md`、`spec/sync-api.md`、`spec/ux.md` |
| Architect | 定架构、模块边界、接口契约、目录结构 | `docs/architecture.md`、ADR |
| Core-Dev（Rust） | SSH/SFTP/端口转发/本地终端/串口/加密保险库等核心 | `crates/*` |
| UI-Dev | 前端界面、主题、交互 | `apps/desktop/src` |
| Server-Dev | 自建同步/更新/中继服务端 | `server/` |
| QA | 单元/集成/E2E 测试、跨平台冒烟、性能基线 | `tests/`、`docs/test-report.md` |
| Security-Reviewer | 凭据存储、加密、传输、依赖许可证与漏洞审计 | `docs/security-review.md` |
| Release | CI/CD、三平台打包、自动更新、版本发布 | `.github/workflows/*`、安装包 |

**隔离规则**：Core-Dev、UI-Dev、Server-Dev 的任务描述里**只引用 `spec/` 与 `docs/`，不引用 `analysis/`**。

### 循环

```
for 每个里程碑 M0..M5:
    Orchestrator 拆分任务 → 并行派发（互不依赖的任务一次派发）
    各 agent 实现 → 自测 → 提交到各自分支
    QA 跑测试并出报告；Security-Reviewer 审计
    Orchestrator 合并 → 对照验收清单 → 未达标则生成修复任务，回到派发
    达标 → 更新 docs/progress.md（做了什么 / 没做什么 / 风险），进入下一里程碑
```

规则：
- 每轮结束必须更新 `docs/progress.md` 与任务清单，保证中断后能续跑。
- 同一问题连续 3 轮修不好：停止硬改，换方案或降级范围，并在 `docs/decisions.md` 记录。
- 验证由"没参与实现的 agent"做（QA / Reviewer），不要自己给自己打分。
- 不要停下来问我是否继续；只有遇到**不可逆且确有分歧**的决定（例如要删除我本机文件、需要我提供公网服务器地址或密钥）才向我提问，并把问题一次问完。

---

## 4. 里程碑

- **M0 分析**：Recon-A/B 并行跑 REA，输出分析文档。必须包含证据（REA 返回的模块/文件/调用线索）和"不确定项"清单。
- **M1 规格与架构**：Spec-Writer 产出规格；Architect 产出架构；我（用户）可在此处查看但不必审批，agent 自行推进。
- **M2 核心骨架**：Tauri 应用跑起来，多标签终端 + SSH 连接 + 会话管理器 + 加密保险库。
- **M3 功能补全**：SFTP 双栏文件管理、端口转发、片段/宏、多服务器同步输入、服务器监控面板、本地终端/串口、导入器。
- **M4 服务端与同步**：同步服务、更新分发、（可选）中继，端到端加密同步打通。
- **M5 打磨与发布**：性能优化、UI 打磨、三平台安装包、自动更新、文档。

---

## 5. 目标产品规格（以分析结果为准做增减，下列为基线）

**会话与连接**
- 协议：SSH（密码 / 公钥 / 键盘交互 / agent 转发 / 跳板机 ProxyJump）、Telnet、Serial、本地 Shell；RDP/VNC 作为后续扩展，不放入首版
- 会话树：分组、标签、搜索、收藏、最近连接、批量导入（OpenSSH `~/.ssh/config`、MobaXterm 会话导出文件、FinalShell 连接配置的导出格式，**导入器只按文件格式规格自己写解析器**）
- 连接保活、自动重连、断线恢复、超时与重试策略

**终端**
- 多标签 + 分屏 + 可拖拽重排；基于 xterm.js（WebGL 渲染）
- 256 色/真彩色、字体连字、可配置快捷键、回滚缓冲、搜索、复制即选中、链接识别、会话日志、终端内置命令历史搜索
- 命令片段与宏、命令补全提示、多会话同步输入（类似 MultiExec）

**文件**
- 终端旁的 SFTP 侧边栏 + 独立双栏文件管理器；拖拽上传下载、断点续传、队列与限速、远程编辑后自动回传、权限编辑、压缩/解压

**网络**
- 本地/远程/动态（SOCKS）端口转发管理器，可持久化、可随会话启动
- X11 转发列为可选项（跨平台成本高，放 M5 之后）

**服务器监控**
- 连接后通过 SSH 采集 CPU/内存/磁盘/网络/进程/负载并实时图表展示，**无需在服务器安装 agent**，采集命令兼容主流 Linux 发行版，其他系统优雅降级

**安全**
- 本地保险库：主密码 → Argon2id 派生密钥 → XChaCha20-Poly1305/AES-GCM 加密；可选系统钥匙串集成
- 支持 SSH 密钥生成/导入/管理、已知主机指纹校验与变更告警
- 日志与崩溃报告默认脱敏

**体验**
- 界面清晰：浅色/深色/跟随系统，信息密度可切换，首次使用向导，全程键盘可操作，中英文界面
- 目标指标：安装包 ≤ 25 MB（Tauri），冷启动 ≤ 1.5 s，空闲内存 ≤ 150 MB，100 条会话列表滚动不卡

---

## 6. 技术栈（默认值，Architect 可用 ADR 论证后修改）

- **桌面端**：Tauri 2（Rust 后端 + 系统 WebView），前端 TypeScript + React（或 Svelte）+ xterm.js + Tailwind
  - 选 Tauri 而不是 Electron：体积和内存更小，更符合"轻量"；Rust 侧直接做 SSH/SFTP，性能与安全性更好
  - 若分析表明某功能必须依赖 Chromium 特性，才允许对该功能使用 Electron，并写 ADR
- **Rust 核心库**（独立 crate，便于以后做 CLI/移动端）：`russh` + `russh-sftp`（或 `ssh2`/`libssh2` 作为备选）、`tokio`、`serde`、`argon2`、`chacha20poly1305`、`rusqlite`/`sled`、`serialport`、`portable-pty`
- **服务端**：Rust（axum + tokio + sqlx/SQLite 或 PostgreSQL），单二进制 + Docker Compose；反向代理用 Caddy 自动 HTTPS
- **CI/CD**：GitHub Actions 矩阵构建 Windows(msi/nsis)/macOS(dmg，通用二进制)/Linux(AppImage + deb)，Tauri updater 签名更新

---

## 7. 服务端设计（"需要上服务器的部分"）

**分析方法**：
1. 用 REA 静态分析 FinalShell（及 MobaXterm 如有联网功能）里涉及联网的模块，识别"哪些功能依赖服务器"（如：账号、配置/会话云同步、更新检查、公告等）。
2. 用我自己的账号，通过 REA 的浏览器/HAR/网络捕获工作流观察这些功能的**接口语义与数据模型**（有哪些资源、字段含义、冲突如何处理）。
3. 只抽取"需要什么能力"，写入 `spec/sync-api.md`。**不复刻对方的私有协议、加密方案或授权逻辑**；新服务端的 API 是我自己设计的。

**新服务端要提供的能力**（按优先级）：
- P0 账号与设备：注册/登录（Argon2id 密码哈希 + JWT 访问令牌 + 刷新令牌）、设备列表与吊销
- P0 **端到端加密同步**：客户端加密整个保险库（会话、凭据、片段、设置），服务端只存密文与版本号；多设备增量同步、基于版本向量/乐观锁的冲突处理、历史版本回滚
- P1 更新分发：`/updates/{target}/{version}` 返回签名更新清单，安装包存放本机或对象存储
- P1 运维：限流、审计日志、备份脚本、`/healthz`、Prometheus 指标
- P2 可选中继：WebSocket 隧道，让客户端经我的公网服务器访问内网主机（默认关闭，需显式配置，带强鉴权与访问控制）
- 单用户自用为默认；多用户为配置开关

**交付**：`server/`（源码）、`deploy/docker-compose.yml`、`deploy/Caddyfile`、`.env.example`、`deploy/README.md`（含域名/DNS/防火墙/TLS/备份/升级步骤）、OpenAPI 文档、客户端侧"服务器地址"配置项与连接测试。
**公网服务器地址与域名由我部署时填写，不要写死；需要我提供的信息统一列在 `deploy/README.md` 的"部署前需要准备"里。**

---

## 8. 分析阶段具体要求（M0）

对 MobaXterm 与 FinalShell 各自产出：

1. **安装目录画像**：用 REA 的桌面安装探测，列出运行时类型（原生 / Java / .NET / Electron 等）、主要组件与依赖、配置与数据文件位置
2. **功能清单与入口**：菜单、工具栏、右键菜单、设置项逐项列出，标注"高频/低频/鸡肋"
3. **数据模型**：会话、分组、凭据、片段、设置的存储格式（字段语义；凭据只描述保护方式的类别，**不做任何破解或提取我之外的口令**）
4. **关键功能设计推断**：SFTP 与终端联动、监控采集方式、多执行、端口转发、会话恢复等"是怎么做的"，每条结论带证据与置信度
5. **联网行为清单**：每个联网功能的触发条件、请求/响应的语义结构（脱敏）
6. **优缺点对比表**与"新软件取舍建议"：保留什么、砍掉什么、哪里做得更好

所有分析文档以"证据 + 结论 + 不确定项"格式书写；REA 返回的限制说明要如实记录，不能把推测写成事实。

---

## 9. 验收标准（全部满足才算完成）

1. `analysis/`（不入库）与 `spec/`（入库）齐全；`spec/` 中不含任何对方代码、字符串、图标或文案
2. 桌面应用在 **Windows / macOS / Linux** 均能通过 CI 构建并启动；至少在 Windows（本机）与一个 Linux 环境实际跑通冒烟测试
3. 能：连接我提供的/本地起的测试 SSH 服务（CI 里用 Docker 的 openssh-server）→ 打开多标签终端 → SFTP 上传下载 → 配置端口转发 → 查看监控面板
4. 保险库加密可验证：落盘文件无明文凭据；错误主密码无法解密；有单元测试覆盖
5. 服务端 `docker compose up` 一键起，客户端完成：注册 → 登录 → 加密同步 → 另一设备拉取 → 冲突处理 → 更新检查，有端到端自动化测试
6. 性能指标达到第 5 节目标，QA 给出实测数据
7. 依赖许可证扫描通过，`THIRD_PARTY_NOTICES.md` 完整；Security-Reviewer 的高危项全部关闭
8. 文档完整：`README.md`（中英）、用户手册、`docs/architecture.md`、`deploy/README.md`、`docs/progress.md`、`docs/decisions.md`
9. Release agent 产出三平台安装包与一份发布说明

---

## 10. 汇报方式

- 平时不要刷屏，用 `docs/progress.md` 与任务清单体现进度
- 每个里程碑结束，给我一段简短总结：做完了什么、哪些没做及原因、下一步、需要我提供的东西（如服务器信息）
- 全部完成后给出：安装包位置、服务端部署步骤摘要、已知限制与后续路线图
