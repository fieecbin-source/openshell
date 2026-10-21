# ADR-003：SSH 协议栈 —— russh vs ssh2/libssh2

- 状态：已接受（M1）
- 日期：2026-10-21
- 关联：`docs/architecture.md` §4.3、§7、§19 R1

## 背景

SSH 是本产品的核心能力，需要：密码/公钥/键盘交互/agent 认证、ProxyJump 多级跳板、多通道复用（shell、exec、SFTP 子系统、direct-tcpip、remote forward）、keepalive、主机密钥校验、可取消的异步连接、跨平台静态构建（Windows/macOS/Linux，含 arm64）。

候选：

1. `russh`（纯 Rust，async，Apache-2.0）+ `russh-sftp`
2. `ssh2`（libssh2 的 Rust 绑定，C 库，阻塞 API，BSD-3-Clause 底层）
3. 调用系统 `ssh` 子进程（OpenSSH，GPL 生态与进程控制复杂）
4. 自研协议栈（不可接受的成本与安全风险）

## 选项对比

| 维度 | russh | ssh2/libssh2 | 系统 ssh 子进程 |
|---|---|---|---|
| 语言/构建 | 纯 Rust，交叉编译简单 | C 依赖，需工具链/系统库 | 依赖目标机 OpenSSH |
| 并发模型 | async/tokio 原生 | 阻塞，需线程池包装 | 进程 + 管道 |
| 多通道/转发 | 原生支持 shell/exec/direct-tcpip/remote forward | 支持，但绑定层抽象较重 | 需命令行参数编排，控制力弱 |
| SFTP | `russh-sftp` 同栈 | libssh2 sftp | 外部 sftp 进程 |
| 主机密钥 | 自行实现策略（灵活性高） | 有 known_hosts 辅助 | 复用系统配置 |
| 稳定性 | API 仍在小版本演进 | 极成熟 | 极成熟 |
| 许可证 | Apache-2.0 | BSD-3-Clause（libssh2） | OpenSSH 为 BSD，但发行版生态含 GPL 工具 |
| 体积/分发 | 静态链接，无运行时依赖 | 需链接 libssh2（可静态） | 依赖用户环境 |

## 决策

采用 **`russh` + `russh-sftp`**，并用 `ChannelOpener` / `ByteStream` trait 将实现完全隔离在 `crates/ssh` 内。

理由：

1. 与 Tokio 同构：连接、通道、keepalive、取消都能用 `select!` 与 `CancellationToken` 统一编排，不需要为每个连接维护阻塞线程。
2. 纯 Rust 静态构建，满足三平台与 arm64 交叉编译；不引入 C 工具链与系统 libssh2 版本差异。
3. 同栈 SFTP 便于"同连接多通道"（终端 + SFTP + 监控 exec 共享认证），这是产品的核心工作流。
4. 主机密钥、认证顺序、重连退避需要自定义策略，纯 Rust 栈更容易精确控制与测试。

不选 `ssh2` 的理由：阻塞 API 与 async 编排之间需要线程桥接，通道生命周期/取消语义更难保证；C 依赖增加 CI 与分发复杂度。

不选系统 `ssh` 子进程的理由：无法可靠实现多通道复用、转发管理与错误分类；进程注入/凭据传递会带来额外安全面；跨平台行为差异大。

## 后果

**正面**

- 连接对象可被 Tauri 命令层直接 `await` 与取消；每连接一个 supervisor 任务即可管理 keepalive/重连/通道配额。
- 无外部运行时依赖，安装包可控。

**负面与缓解**

| 后果 | 缓解 |
|---|---|
| `russh` API 在小版本间可能破坏性变更 | `Cargo.toml` 精确 pin 到补丁版本（`=x.y.z`）；升级走独立 PR + 全量集成测试；不在业务代码直接 `use russh::*`，只经 `crates/ssh` 暴露自有类型 |
| 某些服务器算法/扩展兼容性（老旧 KEX、部分 agent 转发细节） | M2 建立"兼容性矩阵"集成测试（OpenSSH 8.x/9.x、常见嵌入式 sshd）；不支持项显式报 `AUTH_FAILED`（`details.reason = "auth_method_unsupported"`），不静默降级算法 |
| 主机密钥需自实现（无内置 `known_hosts` 解析） | 在 `crates/ssh` 内实现指纹校验状态机 + `known_host` 仓储接口，测试覆盖"未知/匹配/变更"三态 |
| agent 转发能力受限 | 首版支持"使用本机 agent 认证"；服务端 agent 转发（`forward_agent`）作为可选，若库能力不足则明确标注不支持，不影响核心验收 |
| 性能未知（高吞吐） | 终端吞吐基准作为 M2 门槛；必要时调整通道窗口与读缓冲 |

## 验证与退出条件

M2 结束前必须通过以下集成测试（Docker `openssh-server`）：

1. 密码、公钥、keyboard-interactive 三种认证；
2. ProxyJump 两级跳板；
3. 同一连接上同时打开 shell + exec + SFTP + direct-tcpip；
4. local/remote/dynamic 三种转发的建立与关闭；
5. keepalive 与断线后指数退避重连；
6. 主机密钥未知/变更时的阻断与确认流程。

若上述任一项在 `russh` 上被证明**无法在 M2 内以可接受成本实现**（尤其是 remote forward 或 agent 转发），则启用备选：新增 `crates/ssh-libssh2` 实现同一组 trait，由装配根切换；切换需新 ADR，不改动上层契约。
