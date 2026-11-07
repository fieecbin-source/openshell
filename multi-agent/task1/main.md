# Task 1 统一任务书

- 任务编号：Task 1
- 状态：进行中
- 返工自：无
- 发布者：项目 CEO

## 一、项目背景

**OpenShell**（仓库根目录 `e:\projects\openshell`）是一个基于 **Tauri v2 + Rust Workspace（后端）** 与 **React 18 + TypeScript + Zustand + TailwindCSS + xterm.js（前端）** 的现代化跨平台桌面终端与服务器管理工具。

项目 CEO 已使用 **[morluto/rea](https://github.com/morluto/rea)** (`rea-agents` v6.8.0) 对本地 FinalShell 安装目录（`D:\programfile\finallshell\finalshell`，含 `finalshell.exe`、`finalshell.jar` 构件图谱及 `conn/*.json`、`config.json` 配置结构）完成了静态逆向分析，识别出当前 OpenShell 相对 FinalShell 的核心缺失功能与布局差距：

1. **新建连接类型缺失**：
   - 缺少 **Windows 远程桌面 (`rdp`)** 连接（端口 3389、全屏 `fullscreen`、自定义分辨率 `custom_size`/`width`/`height`、磁盘驱动器映射 `drivestoredirect`、代理绑定、凭据自动注入 `cmdkey` + `mstsc.exe` 启动）。
   - 虽然底层枚举定义了 `local_shell`（本地终端）和 `telnet`，但前端 `SessionModal.tsx` 仅展示了 `SSH 主机` 和 `串口 (Serial)` 两个按钮，且后端缺少 `local_shell_open` 与 `telnet_open` 的真实流桥接实现。
2. **代理服务器（HTTP / SOCKS4 / SOCKS5）与跳板机（Jump Host）未闭环**：
   - `SessionInput` / `SessionPatch` 漏掉了 `proxy_id` 等字段，`SessionRepo::create` 将 `proxy_id` 硬编码为 `None`。
   - 缺少全局代理服务器管理弹窗（支持 HTTP / SOCKS4 / SOCKS5 代理增删改查与连通性测试）及新建连接弹窗中的代理选择器。
   - `SessionModal.tsx` 中「跳板机 (ProxyJump)」下拉框被写死 `disabled`，且后端 `openshell-ssh` 尚未实现通过 HTTP/SOCKS 代理流或跳板机 `direct-tcpip` 通道建立 SSH 连接。
3. **隧道 / 端口转发 (`隧道`) 缺失项**：
   - 后端 `backend/crates/forward/src/manager.rs` 中远端反向端口转发（`PortForwardType::Remote` / `-R`）直接返回未实现报错。
   - 新建/编辑连接弹窗 `SessionModal.tsx` 内缺少「隧道 / 端口转发」Tab（FinalShell 支持在连接配置弹窗内直接管理该连接的 `-L` / `-R` / `-D` 规则），且独立 `PortForwardModal.tsx` 缺少对已有规则的编辑功能。
4. **SSH 高级终端配置与 FinalShell 导入器补全**：
   - 新建连接缺少启动命令 (`startup_command`)、工作目录 (`working_dir`)、压缩 (`compression`)、Agent 转发 (`agent_forwarding`)、自动重连 (`auto_reconnect`)、Exec 监控通道开关 (`exec_channel_enable`)、退格/Delete 键序列 (`backspace_key_sequence` / `delete_key_sequence`)。
   - `FinalShellParser` 需支持识别 FinalShell 的 RDP 连接 (`conection_type`)、代理 (`proxy_id`)、内嵌端口转发 (`port_forwarding_list`) 与分辨率配置。
5. **终端布局优化（参考 FinalShell 经典布局）**：
   - FinalShell 采用 **左侧系统监控/主机列表侧边栏 + 右上终端主视图 + 右中命令输入与历史/快捷命令栏 (`command_input` + `cmd_history` + `quick_commands`) + 右下 SFTP 双栏文件管理器** 的三段式垂直布局。
   - 当前 OpenShell 默认只显示单终端视图，缺少位于终端与 SFTP 之间的仿 FinalShell **底部命令输入与历史栏 (`CommandInputBar`)**，非 SSH 标签页无法展开左侧主机列表，且标签栏 `+` 按钮缺少快速打开本地终端/新建各类连接/打开代理与隧道管理的快捷菜单。

## 二、本次总目标

在 **Task 1** 中，通过前后端与布局三线并行协作，一次性补全 **Windows 远程桌面 (`rdp`)、本地终端 (`local_shell`)、Telnet (`telnet`)、代理服务器管理与代理/跳板建连、内嵌隧道配置与远端转发 (`-R`)、SSH 高级参数**，并参考 FinalShell 经典三段式终端布局完成工作区升级。

## 三、整体验收标准

- [ ] 新建/编辑连接弹窗支持 **SSH 主机 (`ssh`)、Windows 远程桌面 (`rdp`)、本地终端 (`local_shell`)、Telnet (`telnet`)、串口 (`serial`)** 五大类连接类型，表单字段完整并能持久化到数据库。
- [ ] **代理服务器管理 (`ProxyManagerModal`)** 支持 HTTP / SOCKS4 / SOCKS5 代理的增删改查与连通性测试；SSH 连接支持绑定代理服务器 (`proxy_id`) 和跳板机 (`proxy_jump_json`) 并真实通过代理/跳板建连。
- [ ] **隧道 / 端口转发** 在新建连接弹窗内提供「隧道」Tab（可增删改查该会话绑定的 `-L`/`-R`/`-D` 规则），独立 `PortForwardModal` 支持编辑规则与选择所属会话，且后端支持本地 (`-L`)、远端 (`-R`)、动态 (`-D`) 三种转发。
- [ ] **Windows 远程桌面 (`rdp`)**、**本地终端 (`local_shell`)**、**Telnet (`telnet`)** 均能从主页或标签栏打开并正常运行（RDP 生成 `.rdp` 并通过 `cmdkey` + `mstsc.exe` 启动且在标签页内展示状态面板；本地终端与 Telnet 接入 `TerminalRouter` 在 `XtermView` 中交互）。
- [ ] 主工作区参考 FinalShell 布局：SSH 会话默认采用 **左监控/主机侧边栏 + 上终端 + 中部命令输入与历史/快捷命令栏 (`CommandInputBar`) + 下 SFTP 文件管理器** 的经典分栏布局，各区域可折叠或拖拽调节比例。
- [ ] 后端 `cargo check` / `cargo test` 通过，前端 `npx tsc --noEmit` / `npm run build` 通过。

## 四、团队与分工概览

| 序号 | 员工 | 本任务角色 | 任务文档 | 是否参与 |
|---|---|---|---|---|
| 1 | gemini4 | 新建连接全协议弹窗、代理服务器管理器、隧道配置增强与首页卡片适配 | gemini41.md | 参与 |
| 2 | gtp | Rust 后端全链路实现（RDP/LocalShell/Telnet 运行时、HTTP/SOCKS 代理与跳板机建连、远端端口转发 `-R`、FinalShell 导入增强） | gtp2.md | 参与 |
| 3 | trae | 仿 FinalShell 经典三段式终端布局、中部命令输入与历史栏 (`CommandInputBar`)、RDP 会话视图与多协议标签页调度 | trae3.md | 参与 |

## 五、分流表（请对号入座）

请根据**你自己的身份**找到对应行，**只阅读并执行**该行指向的文档，不要阅读或执行其他员工的文档：

| 如果你是 | 请阅读 |
|---|---|
| gemini4 | multi-agent/task1/gemini41.md |
| gtp | multi-agent/task1/gtp2.md |
| trae | multi-agent/task1/trae3.md |

无法确定自己是谁、或找不到对应文档：立即停止并告诉用户，不要猜测。

## 六、所有权矩阵与共享约定

| 文件/模块/资源 | 负责员工 | 其他员工是否可改 |
|---|---|---|
| `frontend/src/components/SessionModal.tsx` | gemini4（员工1） | 否 |
| `frontend/src/components/ProxyManagerModal.tsx` | gemini4（员工1） | 否 |
| `frontend/src/components/PortForwardModal.tsx` | gemini4（员工1） | 否 |
| `frontend/src/components/HomeHub.tsx` | gemini4（员工1） | 否 |
| `frontend/src/components/ui/HostIcon.tsx` | gemini4（员工1） | 否 |
| `frontend/src/lib/hostIcons.ts` | gemini4（员工1） | 否 |
| `backend/**`（`backend/crates/**`、`backend/desktop/**`） | gtp（员工2） | 否 |
| `frontend/src/components/AppLayout.tsx` | trae（员工3） | 否 |
| `frontend/src/components/TerminalTabs.tsx` | trae（员工3） | 否 |
| `frontend/src/components/TerminalHost.tsx` | trae（员工3） | 否 |
| `frontend/src/components/XtermView.tsx` | trae（员工3） | 否 |
| `frontend/src/components/CommandInputBar.tsx`（新建） | trae（员工3） | 否 |
| `frontend/src/components/RdpSessionView.tsx`（新建） | trae（员工3） | 否 |
| `frontend/src/components/SessionTree.tsx` | trae（员工3） | 否 |
| `frontend/src/stores/terminalStore.ts` | trae（员工3） | 否 |
| `frontend/src/types/ipc.ts`、`frontend/src/lib/ipc.ts`、`frontend/src/components/ui/icons.tsx` | 项目 CEO（已预先写好共享契约） | **否（全员只读）** |

### 接口契约 / 数据结构 / 命名约定（CEO 已锁定，全员严格遵守）

1. **共享前端类型与 IPC 包装函数已由 CEO 预先写入 `frontend/src/types/ipc.ts` 与 `frontend/src/lib/ipc.ts`**（全员直接 import 使用，切勿修改这两个文件）：
   - `Protocol`: `"ssh" | "sftp" | "telnet" | "serial" | "local_shell" | "rdp"`
   - `SessionInput` 与 `SessionPatch` 已补充：`proxy_id`, `startup_command`, `working_dir`, `auto_reconnect`, `reconnect_max`, `compression`, `agent_forwarding`, `x11_forwarding`。
   - 协议专属 `protocol_options_json` 结构：
     - `RdpProtocolOptions`: `{ fullscreen?: boolean; custom_size?: boolean; width?: number; height?: number; drivestoredirect?: boolean; redirect_clipboard?: boolean; redirect_printers?: boolean; redirect_audio?: "local" | "remote" | "none"; domain?: string | null; admin_session?: boolean; }`
     - `LocalShellProtocolOptions`: `{ shell_kind?: "powershell" | "pwsh" | "cmd" | "wsl" | "bash" | "zsh" | "custom"; shell_path?: string | null; args?: string[]; env?: Record<string, string>; }`
     - `TelnetProtocolOptions`: `{ login_prompt?: string | null; password_prompt?: string | null; auto_login?: boolean; newline_mode?: "crlf" | "lf" | "cr"; local_echo?: boolean; }`
     - `SshProtocolOptions`: `{ accelerate?: boolean; exec_channel_enable?: boolean; backspace_key_sequence?: "ascii_del" | "ctrl_h" | "auto"; delete_key_sequence?: "vt220" | "ascii_del" | "auto"; forwarding_auto_reconnect?: boolean; }`
   - 跳板机配置 `proxy_jump_json`: `ProxyJumpConfig` (`{ session_id: string }`) 或 `null`。
   - 代理服务器配置 `ProxyServerConfig`:
     ```ts
     export type ProxyType = "http" | "socks4" | "socks5";
     export interface ProxyServerConfig {
       id: string;
       name: string;
       proxy_type: ProxyType;
       host: string;
       port: number;
       username?: string | null;
       password?: string | null;
       notes?: string | null;
       created_at?: number;
       updated_at?: number;
     }
     ```
2. **新增 Tauri IPC 命令契约（后端 `gtp` 实现，前端通过 `lib/ipc.ts` 调用）**：
   - `proxy_list_get()` -> `Result<Vec<ProxyServerConfig>, IpcError>`（对应前端 `proxyListGet()`，存储在 `settings` 表 `scope = "global", key = "proxy_list"`）
   - `proxy_list_save(proxies: Vec<ProxyServerConfig>)` -> `Result<Vec<ProxyServerConfig>, IpcError>`（对应前端 `proxyListSave(proxies)`）
   - `proxy_test(proxy: ProxyServerConfig)` -> `Result<ProxyTestResult, IpcError>`（对应前端 `proxyTest(proxy)`，返回 `{ ok: bool, latency_ms: Option<u64>, message: String }`）
   - `rdp_launch(session_id: String, overrides: Option<RdpLaunchOverrides>)` -> `Result<RdpLaunchResult, IpcError>`（对应前端 `launchRdp(sessionId, overrides)`，返回 `{ session_id, rdp_file_path, pid, host, port }`）
   - `local_shell_open(tab_id: String, cols: u16, rows: u16, on_data: Channel<Vec<u8>>, options: Option<LocalShellOpenOptions>)` -> `Result<String, IpcError>`（对应前端 `openLocalShell(tabId, cols, rows, onData, options)`，接入 `state.terminal.attach_stream`）
   - `telnet_open(tab_id: String, session_id: String, cols: u16, rows: u16, on_data: Channel<Vec<u8>>, overrides: Option<ConnectOverrides>)` -> `Result<String, IpcError>`（对应前端 `openTelnet(tabId, sessionId, cols, rows, onData, overrides)`，接入 `state.terminal.attach_stream`）
3. **跨组件接口约定（`gemini4` 与 `trae` 对接）**：
   - `ProxyManagerModal.tsx`（由 `gemini4` 实现）必须保持如下导出签名：
     ```tsx
     export interface ProxyManagerModalProps {
       open: boolean;
       onClose: () => void;
       onChanged?: (proxies: ProxyServerConfig[]) => void;
     }
     export function ProxyManagerModal({ open, onClose, onChanged }: ProxyManagerModalProps): JSX.Element | null;
     ```
   - `SessionModal.tsx`（由 `gemini4` 维护）保持现有 `SessionModalProps`（`isOpen`, `onClose`, `editingSession`, `initialValues?: Partial<SessionInput>`, `onConnectSession`），当 `initialValues?.protocol` 传入 `"rdp"` / `"local_shell"` / `"telnet"` / `"serial"` / `"ssh"` 时自动预选对应协议。

## 七、全员通用规则

1. 只做自己文档里的任务，不顺手重构，不扩大范围。
2. 发现范围外的问题：只记录到回执，不要修改。
3. 受阻、信息缺失、需要决策：停下该部分，如实写入回执，不要猜测或编造。
4. 完成后把回执写入 `multi-agent/task1/Task 1 Feedback.md` 中属于你自己的小节；只改自己的小节，写完重新读取确认已保存。

## 八、CEO 自留事项

1. 已预先更新共享契约文件 `frontend/src/types/ipc.ts`、`frontend/src/lib/ipc.ts`、`frontend/src/components/ui/icons.tsx`（新增 `MonitorIcon`），并建立了 `frontend/src/components/ProxyManagerModal.tsx` 的初始编译骨架（交由 `gemini4` 完整实现）。
2. 待三位员工全部提交回执后，负责跨模块联调审查与收口验收。
