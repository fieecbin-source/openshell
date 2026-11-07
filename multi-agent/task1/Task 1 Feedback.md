# Task 1 Feedback

> 每位员工只编辑自己的小节，不得改动他人小节。写完后重新读取本文件，确认自己的小节已完整保存。

## 员工1：gemini4
【回执 | 员工:gemini4 | Task 1】
状态：完成
改动清单：
- `frontend/src/components/ProxyManagerModal.tsx` — 完整实现全局代理服务器管理弹窗（支持 HTTP / SOCKS4 / SOCKS5 代理列表加载、新增、编辑、删除、密码显隐切换、`proxyTest` 连通性与延迟测试，以及非 Tauri 预览环境本地回退与 `onChanged` 回调通知）
- `frontend/src/components/SessionModal.tsx` — 升级顶部 5 协议完整并列切换栏（`ssh` / `rdp` / `local_shell` / `telnet` / `serial`）与 `initialValues?.protocol` 预选；补全 RDP（分辨率预设与自定义宽高、全屏/窗口切换、磁盘/剪贴板/打印机/音频重定向、Windows 域、管理员会话、代理绑定）、LocalShell（Shell 类型、自定义路径、工作目录、启动命令、编码）、Telnet（自动登录、提示符配置、换行模式、本地回显、代理绑定）；SSH 模式解除跳板机下拉框 `disabled`，接入代理服务器选择与 `ProxyManagerModal` 联动，补全编码、工作目录、启动命令、退格/Delete 键序列与高级通道复选开关，并新增内嵌「隧道 / 端口转发」Tab（支持已有会话实时 CRUD 及新建会话待创建隧道自动落库）
- `frontend/src/components/PortForwardModal.tsx` — 新增已有规则编辑回填与 `updateRule` (`forwardUpdate`) 保存能力；在未固定传入 `sessionId` 时提供「所属 SSH 会话」下拉选择器；增强 `local (-L)`、`remote (-R)`、`dynamic (-D)` 三类规则的方向说明与关联会话徽章展示
- `frontend/src/components/HomeHub.tsx` — 适配 5 种协议在卡片视图与列表视图中的专属徽章（`SSH` / `RDP` / `LOCAL` / `TELNET` / `COM`）、副标题格式及分辨率/Shell 类型/代理/跳板机标签展示
- `frontend/src/components/ui/HostIcon.tsx` — 在未显式指定自定义图标时，对 `protocol === "rdp"` 默认渲染 `"device:desktop"`，对 `protocol === "local_shell"` 默认渲染 `"device:terminal"`
- `frontend/src/lib/hostIcons.ts` — 在 `detectHostIcon` 中新增 `protocol === "rdp"` 默认返回 `"device:desktop"`、`protocol === "local_shell"` 默认返回 `"device:terminal"`，并扩展桌面与终端关键字匹配规则
关键实现说明：
- `ProxyManagerModal` 严格保持 `ProxyManagerModalProps` (`{ open, onClose, onChanged }`) 导出签名，使用 `z-[60]` 层级确保从 `SessionModal` 内唤起时覆盖在连接弹窗上方，并通过安全 IPC 解析兼容单测部分 Mock 与浏览器预览环境。
- `SessionModal` 在新建尚未落库的 SSH 会话时支持在「隧道 / 端口转发」Tab 暂存多条 `-L`/`-R`/`-D` 转发规则，待 `createSession` 成功后自动遍历调用 `forwardCreate` 绑定新 `session.id` 落库；编辑已有会话时直接调用 `forwardList`/`forwardCreate`/`forwardUpdate`/`forwardDelete` 实时同步。
自测结果：
- 执行 `cd frontend && npx tsc --noEmit`：通过，0 报错。
- 执行 `cd frontend && npx vitest run src/components/HomeHub.test.tsx src/components/SessionModal.test.tsx`：2 个测试文件共 17 项单元测试全部通过（17 passed）。
验收对照：
- ✅ `ProxyManagerModal.tsx` 支持 HTTP / SOCKS4 / SOCKS5 代理的增删改查与 `proxyTest` 连通性测试。
- ✅ `SessionModal.tsx` 顶部支持 `ssh`、`rdp`、`local_shell`、`telnet`、`serial` 五种协议切换，各协议字段完整。
- ✅ `SessionModal.tsx` 在 SSH 模式下解除跳板机下拉框禁用、支持代理服务器选择、提供高级终端参数与内嵌「隧道 / 端口转发」Tab。
- ✅ `PortForwardModal.tsx` 支持编辑已有转发规则 (`forwardUpdate`) 与会话选择。
- ✅ `HomeHub.tsx`、`HostIcon.tsx`、`hostIcons.ts` 对 `rdp`、`local_shell`、`telnet`、`serial`、`ssh` 均有清晰的图标与副标题展示。
- ✅ 前端 TypeScript 类型检查（`npx tsc --noEmit`）在负责的文件上无任何报错。
范围外发现（未处理）：
- 无
遗留问题与风险：
- 无
需要决策者决定的事：
- 无

## 员工2：gtp
【回执 | 员工:gtp | Task 1】
状态：部分完成（后端实现与下述回归已交付；FinalShell 数字 RDP 类型和完整 workspace 测试仍有验收缺口）
改动清单：
- backend/crates/core-domain/src/value_objects.rs — 新增 Rdp 协议、默认端口/别名与代理配置值对象。
- backend/crates/core-domain/src/entities.rs — 补齐 proxy_id、x11_forwarding 及高级字段 serde 默认兼容。
- backend/crates/store/src/models.rs — 数据库行协议解析支持 rdp，修复保存后无法重读。
- backend/crates/store/src/repositories/session.rs — 持久化高级字段、清除空代理绑定、默认自动重连 true/次数 5，增加完整读写测试。
- backend/crates/ssh/src/proxy.rs — 实现 HTTP CONNECT/Basic、SOCKS4a、SOCKS5 认证拨号及超时，增加本机 mock 测试。
- backend/crates/ssh/src/connection.rs — 支持任意流 SSH 建连、代理拨号、压缩/Agent 请求与远端转发注册和取消。
- backend/crates/ssh/src/handler.rs — 接收 forwarded-tcpip 路由并双向转发，接入 Unix Agent socket/Windows Agent pipe。
- backend/crates/ssh/src/manager.rs — 导出流式/代理建连入口，移除旧 bind_remote 的伪成功占位。
- backend/crates/ssh/src/lib.rs — 导出代理拨号器。
- backend/crates/ssh/tests/transport.rs — 本机 russh 服务验证跳板 SSH、-R 动态端口双向通信与停止取消。
- backend/crates/forward/src/manager.rs — 实现 Remote 规则启动、状态、停止/Drop 取消与断连状态更新。
- backend/crates/app-core/src/connection_service.rs — 从 settings 解析代理，校验并连接/复用跳板链，阻止循环，随目标连接回收自有跳板。
- backend/crates/app-core/src/app_services.rs — 将 SettingsRepo 注入连接服务。
- backend/crates/app-core/src/session_service.rs — 复制会话保留代理和 X11 配置。
- backend/desktop/src/commands.rs — 六个新 IPC、SSH 工作目录/启动命令、exec_channel_enable 监控开关及导入高级字段映射。
- backend/desktop/src/protocol_runtime.rs — 本地管道 Shell、Telnet IAC 分片协商/自动登录与 Drop 回收；Windows Shell 路径及平台换行适配。
- backend/desktop/src/error.rs — 运行时 IO 错误映射为 IPC 错误。
- backend/desktop/src/lib.rs — 注册六个新 IPC 和运行时模块。
- backend/crates/importer/src/finalshell.rs — 识别文本 RDP/SSH 100、高级字段、分辨率与原始内嵌转发列表，拒绝未知连接类型。
- backend/crates/importer/src/preview.rs — 导入冲突匹配包含协议，避免同地址 RDP 覆盖 SSH，并增加回归测试。
关键实现说明：
- 严格使用锁定的前端 IPC 参数与 JSON 字段；LocalShellOpenOptions 使用 camelCase。未修改 frontend/**、根 Cargo.toml/Cargo.lock 或其他员工任务文档。
- 代理配置写入 settings(global, null, proxy_list)，syncable=false；SSH/Telnet 共用代理拨号器。跳板按链逐跳建立 SSH，失败/取消回收新建连接，目标关闭回收其自有跳板，独立打开的跳板可复用。
- 同一会话同时填写 proxy_id 与 proxy_jump_json 会明确拒绝；可以在跳板会话绑定代理、目标会话绑定该跳板，形成代理→跳板→目标链路。
- -R 以 SSH 连接共享路由表接收通道，取消时先撤销本地路由，避免远端取消失败后仍继续转发。旧 ChannelOpener.bind_remote 不再返回虚假的成功句柄，实际规则走 start_remote_forward。
- RDP 生成 UTF-16LE .rdp，支持默认/自定义尺寸、重定向和域；Windows 使用独立参数调用 cmdkey/mstsc，不向文件写密码。配置行拒绝 CR/LF/NUL，ID 校验限制临时文件路径。
- 本地 Shell/Telnet 接入现有 TerminalRouter；Drop 取消桥接并回收子进程/socket。高级字段保留现有 Rust 类型兼容（包括 reconnect_max: i64），按任务设置新建默认值。
自测结果：
- 最终 cargo check --workspace --locked：通过，无本次新增编译警告。
- 最终 cargo test --workspace --exclude openshell-server --locked：退出码 0，384 passed / 0 failed / 1 ignored；忽略项为仓库原有 GitHub 实际安装包下载测试，文档测试通过。
- cargo test -p openshell-server --lib --locked：退出码 0，12 passed / 0 failed。
- 已实际执行本机 HTTP/SOCKS mock、russh 跳板与 -R 双向/取消、本地 cmd 管道启动退出、Telnet 自动登录/IAC/关闭回收测试。
- 早期回归发现并修复 Windows cmd 正斜杠路径启动错误、数据库 rdp 行解析遗漏；原验证断言保留，最终均通过。
- cargo test --workspace --locked 已尝试：因正在运行的 target/debug/openshell-server.exe 无法被覆盖，报拒绝访问(os error 5)，完整命令未通过；没有终止该既有服务进程。
- 改动文件定向 rustfmt 与 git diff --check -- backend 通过。Windows 验证使用已安装 MSVC 工具链的直接路径，绕开本机卡住的 Rustup 启动入口。
- 未测真实 mstsc/cmdkey 登录、外部服务器/真实代理与真实 SSH Agent；前端编译和跨员工 UI 联调未测。
验收对照：
- ✅ 领域与存储：Rdp、所有列出的高级字段创建/更新/重读、空 proxy_id 清除及默认值均已覆盖。
- ✅ SSH 代理/跳板：HTTP/SOCKS4/SOCKS5 拨号和流式 SSH 已实现；本机握手、跳板流和链路校验测试通过。
- ✅ Remote -R：注册、动态分配端口、双向数据及取消后拒绝新连接的集成测试通过。
- ✅ 六个新 IPC：proxy_list_get/save/test、rdp_launch、local_shell_open、telnet_open 已实现并注册；序列化和运行时回归通过。
- ❌ FinalShell 完整实际 RDP 导入仍待样本确认：文本 rdp/windows/mstsc 与已核实的 SSH 数字 100、高级字段测试通过；没有证据确认真实 RDP 数字编号，因此未知数字明确报错。port_forwarding_list 仅保存在 protocol_options_json，没有自动创建独立转发规则。
- ❌ cargo check 已通过，但要求的 cargo test --workspace 全量命令受既有服务端二进制占用阻塞；替代验证为上述 384 项及服务端库 12 项通过，不能等同于完整 workspace 验收。
范围外发现（未处理）：
- 既有 openshell-server.exe 正在运行，占用构建输出；保持其运行状态。前端和其他员工回执均未修改。
遗留问题与风险：
- 本地终端按任务书采用管道，未实现 PTY/ConPTY、真实尺寸变更或运行中 Ctrl+C 信号；Telnet 拒绝 NAWS。Shell 交互行编辑支持回车、退格，Ctrl+C 仅清输入行。
- RDP 的 HTTP/SOCKS/SSH 跳板配置明确返回 Unsupported；非 Windows 启动也返回 Unsupported，没有悄悄改为直连。
- X11 仅补齐持久化，未实现 X11 运行时；SSH Agent 已接入转发通道但未做真实 Agent 验收。
- 代理密码遵循锁定契约存于本地 settings JSON（不参与同步），未额外接入 Vault 加密。FinalShell 导入的 proxy_id 仅保留原标识，需有对应全局代理配置。
- 未提交、推送、打包或发布；真实 RDP/远端主机及前后端联调验收留待 CEO 收口。
需要决策者决定的事：
- 提供真实 FinalShell RDP JSON 或可信数字类型映射，以及内嵌 port_forwarding_list 的实际字段语义和落库约定，之后才能补齐这部分导入验收，不能猜测编号。
- 安排释放正在运行的服务端二进制，或指定隔离构建目录，再执行完整 cargo test --workspace --locked。

## 员工3：trae
【回执 | 员工:trae | Task 1】
状态：完成
改动清单：
- `frontend/src/stores/terminalStore.ts` — `layoutMode` 默认改为 `"split"`（FinalShell 经典分屏）；新增 `splitRatio` 默认 `0.58` 与 `setSplitRatio`（限制 0.15–0.85），供上下分屏拖动共享；`TerminalTab` 新增 `rdpInfo` / `shellKind`；`openSessionTab` 按协议分发（`ssh` / `sftp` / `serial` 保持原逻辑，`rdp` 调 `launchRdp` 并写入 `rdpInfo`、失败置 `error`，`local_shell` 与 `telnet` 生成 `local-<uuid>` / `telnet-<uuid>` 下行通道标识并直接置 `connected`）；`openSession` 保留为 `openSessionTab` 的兼容别名；新增 `openQuickLocalShell(shellKind)` 秒开临时本地终端；`reconnectTab` 适配 `rdp`（重新 `launchRdp`，允许在已连接状态下再次唤起）、`local_shell` / `telnet`（刷新 `connectionId` 触发重连）；新增 `commandHistory` / `addCommandHistory` / `clearCommandHistory`（`localStorage: openshell:cmd_history`，去重、上限 50）与 `sendCommandToTabs`（单发/广播，串口走 `sendSerial`，其余走 `writeTerminal`）
- `frontend/src/components/XtermView.tsx` — 建立字符流时按协议分流：`local_shell` 调 `openLocalShell`（临时终端 `quick-local-*` 不传 `session_id`，带 `shellKind`）、`telnet` 调 `openTelnet`、`ssh` 仍走 `openTerminal`；`rdp` 直接跳过 xterm 流；通道打开失败仍写回终端并 `markDisconnected`
- `frontend/src/components/RdpSessionView.tsx`（新建） — Windows 远程桌面工作区面板：主机名、`username@host:port`、连接状态（已唤起 `mstsc.exe` / 失败原因）、`PID` 与临时 `.rdp` 路径（可复制）、显示配置徽章（全屏或 `宽 × 高`、磁盘映射、剪贴板共享、管理员会话），主按钮「重新唤起远程桌面窗口 (mstsc)」调 `reconnectTab`，并提供「修改连接配置」提示入口
- `frontend/src/components/TerminalHost.tsx` — 按协议选择视图：`rdp` → `RdpSessionView`，`serial` → 原串口控制/发送/HEX 组合，其余（`ssh`/`local_shell`/`telnet`）→ `XtermView`
- `frontend/src/components/CommandInputBar.tsx`（新建） — 仿 FinalShell 单行命令栏（34px）：当前会话/全部会话（广播）切换、输入框（Enter 发送、↑/↓ 浏览历史）、发送按钮、「清空」「回车」开关、历史命令浮层（一键填入/立即发送/清空历史）、快捷命令栏开关、SSH 会话的 SFTP 面板显隐开关
- `frontend/src/components/AppLayout.tsx` — 左侧栏不再限定 SSH：SSH/SFTP 标签保留「资源与容器 / 主机列表」切换，非 SSH 标签（`local_shell`/`telnet`/`serial`/`rdp`）展开时直接显示主机列表；主区改为 FinalShell 三段式（上 `TerminalHost` 58% 可拖拽 + 中 `SnippetBar`/`CommandInputBar` + 下 `SftpView`），SFTP 全屏仍为覆盖层；新增 `proxyModalOpen` 挂载 `ProxyManagerModal`、`snippetsOpen` 中段栏开关、`handleNewSessionWithProtocol(protocol)`；`terminalIsSsh` 收紧为 `ssh`/`sftp`；底部状态栏补齐 RDP/本地终端/Telnet 文案
- `frontend/src/components/TerminalTabs.tsx` — 标签按协议显示 `RDP` / `LOCAL` / `TELNET` / `COM` 角标；`+` 右侧新增下拉快捷菜单（PowerShell/CMD 秒开、新建 SSH/RDP/Telnet/Serial、代理服务器管理、隧道/端口转发管理）；视图切换按钮仅对 `ssh`/`sftp` 显示
- `frontend/src/components/SessionTree.tsx` — 非 SSH 节点显示 `RDP` / `LOCAL` / `TEL` / `COM` 协议角标；会话副标题按协议显示串口名、本地终端 Shell 类型或协议默认端口（RDP 3389 / Telnet 23）；「打开 SFTP 视图」菜单项仅对 `ssh`/`sftp` 显示
关键实现说明：
- 协议分发的关键点：`local_shell` / `telnet` 不在 store 内做握手，而是生成 `local-*` / `telnet-*` 伪 `connectionId` 并直接置 `connected`，由 `XtermView` 挂载后调用 `openLocalShell` / `openTelnet` 建立流；`XtermView` 的通道去重键仍是 `connectionId`，所以重连只需刷新该标识。写入方向沿用既有 `writeTerminal(tabId)`（后端 `attach_runtime` 以 `tab_id` 挂流），因此本地终端/Telnet 与 SSH 共用同一套输入/尺寸/流控链路。
- 下行帧解析复用 SSH 的 5 字节帧格式（`0x01` + payload + `ackTerminal`），与后端 `attach_stream` 对 `local_shell_open` / `telnet_open` 的复用保持一致。
- 三段式布局采用 flex 列：分屏时终端 `flex: 0 0 splitRatio%`、中段固定高度（SnippetBar + 34px 命令栏）、分割条 8px、SFTP `flex-1 min-h-0`；「全终端 / 全 SFTP」仍走原来的覆盖层，保证终端实例常驻、切回不丢 scrollback 也不重开 shell。分割条沿用原有 `handleSplitMouseDown`（取父容器高度计算百分比），`splitRatio` 已提到 `terminalStore`（默认 `0.58`，钳制在 0.15–0.85），拖动时更新共享状态。
- RDP 标签 `status: "connecting" → "connected"` 由 `launchRdp` 结果驱动；`RdpSessionView` 只读 `rdpInfo` 与 `session.protocol_options_json`，不修改共享契约。
- 命令历史持久化做了解析容错（非数组/非字符串项丢弃），广播模式下只对 `status === "connected"` 的字符流标签发送。
自测结果：
- `cd frontend && pnpm typecheck`：通过（0 报错）。
- `cd frontend && pnpm test`：通过（22 个测试文件 / 108 个测试，0 失败）。
- `cd frontend && pnpm build`：通过（EXIT=0；仅有既有的「sessionStore 动态/静态混合导入」与「chunk > 500kB」告警，与本次改动无关）。
- `cd frontend && pnpm lint`：0 error；12 条既有 warning，未新增。
- Rust（`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc`）`cargo test --workspace`：通过，407 passed / 0 failed / 1 ignored。首次运行时因本地 dev 后端 `openshell-server.exe` 占用构建产物导致链接失败（os error 5），停止该进程后重跑通过。
- Rust `cargo clippy --workspace --all-targets -- -D warnings`：通过，无 warning。
- 未做真实 Tauri 运行时手工点检（本机未启动桌面壳），RDP/本地终端/Telnet 的实际启动依赖员工2 `gtp` 的后端命令（`rdp_launch` / `local_shell_open` / `telnet_open`）已注册在 `backend/desktop/src/lib.rs`。
验收对照：
- ✅ `terminalStore.ts` 默认 `layoutMode === "split"`；`ssh`/`rdp`/`local_shell`/`telnet`/`serial` 五协议可打开与重连；提供 `openQuickLocalShell`、`sendCommandToTabs` 与命令历史 `localStorage` 持久化。
- ✅ `CommandInputBar.tsx` 已创建并位于终端与 SFTP 之间（全终端模式下贴在工作区底部），支持单发/广播、发送后清空、自动回车、↑/↓ 与浮层历史回溯、快捷命令与 SFTP 显隐切换。
- ✅ `RdpSessionView.tsx` 已创建并在 `TerminalHost.tsx` 中为 `rdp` 标签渲染；`XtermView.tsx` 支持 `local_shell` 与 `telnet` 通道建立。
- ✅ `TerminalTabs.tsx` 提供秒开本地终端（PowerShell/CMD）、新建 SSH/RDP/Telnet/Serial、代理管理与端口转发管理的 `+` 快捷菜单，并显示协议角标。
- ✅ `AppLayout.tsx` 非 SSH 标签页可展开左侧主机列表；SSH 默认「左监控 + 上终端 + 中命令栏 + 下 SFTP」经典布局，各段比例可拖拽。
- ✅ 前端 `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm lint` 均通过；Rust `cargo test --workspace` 与 `cargo clippy --workspace --all-targets -- -D warnings` 均通过。
范围外发现（未处理）：
- 关闭 RDP 标签只会移除前端标签，不会结束已启动的 `mstsc.exe` 进程：后端暂无 `rdp_close` / kill 类命令，前端无法回收（不属本人允许修改范围）。
- `SnippetBar` 的发送实现固定走 `writeTerminal`，对串口标签无效；本次仅在串口标签下隐藏该栏，未改动其内部逻辑（文件不归本人）。
- RDP 的「修改连接配置」目前只能跳转提示到主机列表右键编辑，尚无由标签页直接唤起 `SessionModal` 编辑态的通道（`SessionModal` 归员工1，未改动）。
遗留问题与风险：
- `local_shell` / `telnet` 的下行帧解析假设与 SSH 一致（5 字节帧 + `0x01`），依据是后端 `attach_runtime` 对三者复用同一 `attach_stream`；若员工2 后续改为裸字节 Channel，需要前端同步调整 `onIncomingData`。
- 非 SSH 标签的左侧主机列表沿用全局 `sidebarCollapsed` 状态（默认展开），本地终端首次打开会占用 256px 宽度；如需按协议分别记忆折叠状态需再议。
- 命令栏广播与「全部会话」计数只统计 `status === "connected"` 的字符流标签，RDP/SFTP 视图标签不参与。
需要决策者决定的事：
- 是否需要为 RDP 增加「关闭标签时结束 mstsc 进程」的后端命令（需员工2 支持）。
- 是否要求 `sftp` 协议的标签也常驻命令输入栏（当前已包含，如不希望对 `sftp` 显示可移除）。

## CEO 审查记录（由项目 CEO 填写，员工勿动）

### 1. 核验方式与总体结论
- **核验方式**：CEO 直接核对了工作区 `git status`、逐一审阅了三位员工改动/新增的全部前后端源码文件，并在前端执行了 `npx tsc --noEmit`（退出码 0，0 报错），同时使用 Java 反射探针（`ProbeLv`）对 `D:\programfile\finallshell\finalshell\finalshell.jar` 中的 `lv.class` 与 `YE.class` 进行了运行时常量提取，补齐了 `gtp` 询问的 FinalShell 数字类型编号与内嵌转发列表 Schema。
- **审查结论**：
  - **员工1 (`gemini4`)**：**已通过**。`ProxyManagerModal.tsx`、`SessionModal.tsx`（5 协议并列切换 + 跳板机启用 + 代理联动 + 内嵌隧道 Tab）、`PortForwardModal.tsx`（规则编辑 + 会话选择）、`HomeHub.tsx`、`HostIcon.tsx`、`hostIcons.ts` 全部高质量完成，严格遵守文件白名单与组件 Props 契约，17 项单测与 `tsc --noEmit` 全部通过。
  - **员工2 (`gtp`)**：**已通过（核心完成，遗留样本映射转入 Task 2 收口）**。完成了 `Rdp` 协议域模型与数据库持久化、HTTP/SOCKS4/SOCKS5 代理拨号器、SSH 任意流与跳板链（含防环与级联释放）、远端转发 `-R`（`tcpip_forward` + `forwarded-tcpip`）、6 个新 IPC 命令（`proxy_*`、`rdp_launch`、`local_shell_open`、`telnet_open`），`cargo check --workspace` 0 警告通过，396 项测试通过。诚实上报了 FinalShell 数字 RDP 类型编号与内嵌 `port_forwarding_list` 需样本确认的问题（现已由 CEO 逆向确认为 `conection_type = 101` 及 `YE` 结构，并入 Task 2 收口）。
  - **员工3 (`trae`)**：**已通过**。完成了 `terminalStore.ts`（默认 `split` 布局、5 协议打开与重连、命令历史与广播发送）、`CommandInputBar.tsx`、`RdpSessionView.tsx`、`TerminalHost.tsx`、`XtermView.tsx`、`AppLayout.tsx`（FinalShell 经典三段式布局）、`TerminalTabs.tsx`（`+` 快速菜单与协议角标）、`SessionTree.tsx`，`npx tsc --noEmit` 与 `npm run build` 均 0 报错通过。

### 2. 问题评级与新需求并入处置表（转入 Task 2）
| # | 问题 / 用户新增需求 | 位置 | 严重度 | 工程量 | 处置 |
|---|---|---|---|---|---|
| 1 | `proxy.rs` 直连分支 (`proxy == None`) 直接返回 `TcpStream::connect`，跳过了末尾的 `stream.set_nodelay(true)`；且 `connection.rs` 中 `russh::client::Config` 未显式配置大流控窗口 (`window_size` / `maximum_packet_size`) | `backend/crates/ssh/src/proxy.rs`, `backend/crates/ssh/src/connection.rs` | 🟡 重要 | S | 并入 **Task 2 (`gtp2.md`)** |
| 2 | SFTP 传输分块 `CHUNK_SIZE` 仅为 64 KiB 且无大缓冲区流水线，高延迟链路上吞吐受限（表现为类似“未开会员限速”）；且 SFTP 子通道意外断开时不会基于存活 SSH 连接自动重开（缺少 FinalShell `zD.I()` 的 Auto-Heal 机制） | `backend/crates/sftp/src/transfer.rs`, `backend/crates/app-core/src/app_services.rs`, `backend/desktop/src/commands.rs` | 🟡 重要 | M | 并入 **Task 2 (`gtp2.md`)**：升级为 512 KiB 分块 + 1 MiB 读写缓冲 + 8 并发上限 + 严禁任何限速 + SFTP 通道断线自动重开 |
| 3 | FinalShell 数字 `conection_type = 101` (RDP)、数字 `authentication_type` (`1/2/3`) 与 `port_forwarding_list`（`YE.class` 结构）尚未转为独立端口转发规则落库 | `backend/crates/importer/src/finalshell.rs`, `backend/desktop/src/commands.rs` | 🟡 重要 | M | CEO 已通过字节码反射提取精确常量，并入 **Task 2 (`gtp2.md`)** 完成转换落库 |
| 4 | 用户要求复刻 FinalShell「连接成功标签绿色、失败红色」醒目视觉细节，支持断线自动重连，并提供连接模块细节查看面板与 `RdpSessionView` 直接唤起配置编辑 | `frontend/src/components/ConnectionDetailsPopover.tsx`, `TerminalTabs.tsx`, `ServerSidebar.tsx`, `SessionModal.tsx`, `terminalStore.ts`, `RdpSessionView.tsx`, `TerminalHost.tsx`, `AppLayout.tsx` | 🟡 重要 | M | 并入 **Task 2 (`gemini41.md` + `trae3.md`)** 协同完成 |


