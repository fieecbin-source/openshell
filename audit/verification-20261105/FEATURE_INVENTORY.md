# OpenShell 功能清单（本次验收）

依据为当前 README、界面和代码；没有找到独立产品 PRD。audit/spec.md 是历史安全审计，不能作为本次通过证据。

语言平台：Rust 2021 + Tauri 2；React 18 + TypeScript + Vite。当前实测平台为 Windows。

## 用户可见行为

| ID | 模块 | 功能点 | 预期行为 | 入口 | 依据 |
|---|---|---|---|---|---|
| UI-001 | SSH | 密码认证 | 正确密码建连，错误密码失败 | frontend/src/components/ConnectAuthModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-002 | SSH | 私钥/口令/键盘交互/Agent | 分别验证各认证方式，不以一种替代其他 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-003 | SSH | 主机密钥策略 | 首次连接按策略处理，已知密钥变更须拒绝或显式告警 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-004 | SSH | ProxyJump 和 HTTP/SOCKS 代理 | 连接经所选代理或跳板到达回环测试服务 | frontend/src/components/ProxyManagerModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-005 | SSH | 保活/压缩/启动命令/目录/编码 | 保存配置实际传递到会话并影响运行 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-006 | SSH | Agent/X11 转发 | 配置必须在连接层生效；无环境时明确无法验证 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-007 | SSH | 自动重连及重试上限 | 断开后按配置重连并在上限停止 | frontend/src/components/DisconnectedBackdrop.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-008 | 终端 | 输入输出、尺寸与背压 | 真实通道双向收发，尺寸改变到达设备；大量输出无损 | frontend/src/components/XtermView.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-009 | 终端 | 标签重命名/排序/复制/关闭 | 对应会话与显示正确，关闭释放资源 | frontend/src/components/TerminalTabs.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-010 | 终端 | 全屏/清屏/搜索/复制粘贴/字号 | 菜单和快捷键产生相应实际效果 | frontend/src/components/AppLayout.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-011 | 终端 | 分屏/监控/SFTP切换 | 切换保持底层会话与输出 | frontend/src/components/ContainerWorkspace.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-012 | 终端 | 命令栏/广播/片段参数 | 指令仅发往所选测试会话，参数替换正确 | frontend/src/components/MultiExecBar.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-013 | 本地终端 | PowerShell/CMD/自定义程序 | 启动所选程序，收发、退出、错误路径真实可见 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-014 | 本地终端 | WSL/bash/zsh | 仅在存在对应运行环境时验收 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-015 | Telnet | 连接/登录/换行/回显 | 使用真实 TCP 通道，与本地模拟端交互 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-016 | RDP | 认证与桌面交互 | 实际进入本地 xrdp 桌面，不以启动进程视为连接成功 | frontend/src/components/RdpSessionView.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-017 | RDP | 分辨率/全屏/域/管理会话 | 生成配置与实际运行一致 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-018 | RDP | 剪贴板/磁盘/打印机/音频重定向 | 逐项验证配置效果，硬件依赖单列 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-019 | RDP | 失败/断开/关闭窗口 | 认证失败和断开真实可辨，资源与测试凭据可清理 | frontend/src/components/RdpSessionView.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-020 | 串口 | 真实端口打开与双向收发 | 使用原生串口后端；不存在的端口不得显示连接成功 | frontend/src/components/SerialSendBar.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-021 | 串口 | 波特率/数据位/校验/停止位/流控 | 配置实际应用；虚拟对不能证明物理波特率误差 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-022 | 串口 | Hex/文本/换行/本地回显/编码 | 发送和显示内容按配置转换，字节可核对 | frontend/src/components/SerialSendBar.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-023 | 串口 | DTR/RTS/线路状态/统计 | 设备端验证线路和字节统计；虚拟硬件限制单列 | frontend/src/components/SerialSendBar.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-024 | 串口 | 占用/乱码/断开/重连 | 真实原生后端报告错误，不降级假成功 | frontend/src/components/SessionModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-025 | SFTP | 本地/远端目录及文件操作 | 浏览、建目录、改名、权限、删除仅操作测试目录 | frontend/src/components/SftpView.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-026 | SFTP | 上传下载100MiB | 两端长度与 SHA256 一致 | frontend/src/components/TransferQueueDrawer.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-027 | SFTP | 暂停/续传/取消/进度 | 传输行为与界面状态一致，不以按钮存在视为通过 | frontend/src/components/TransferQueueDrawer.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-028 | SFTP | OSC7目录跟随/远程编辑 | 目录事件更新视图，保存后回读文件一致 | frontend/src/components/RemoteEditorModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-029 | 监控 | CPU/内存/网络/磁盘/进程 | 来自本地 SSH 模拟环境采集，正确展示异常与无数据 | frontend/src/components/MonitorDashboard.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-030 | 监控 | 进程操作 | 只对模拟服务中本次创建的进程操作 | frontend/src/components/MonitorDashboard.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-031 | 端口转发 | 本地/远端/SOCKS5/认证 | 各转发实际传输测试数据并验证失败分支 | frontend/src/components/PortForwardModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-032 | 端口转发 | 通配地址确认 | 检查风险确认，不向公网绑定测试监听 | frontend/src/components/PortForwardModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-033 | 会话 | 收藏/搜索/排序/图标/分组树 | 显示、保存、移动与重启结果一致 | frontend/src/components/SessionTree.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-034 | 会话 | 快速连接/最近记录/命令面板 | 入口连接正确的测试会话并更新状态 | frontend/src/components/CommandPaletteModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-035 | 导入导出 | OpenSSH/FinalShell/JSON/osvault | 预览冲突、导入导出、错误密码与损坏文件处理 | frontend/src/components/ImportExportModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-036 | 保险库 | 初始化/锁定/解锁/改密/自动锁定 | 状态及凭据可用性正确，错误密码失败 | frontend/src/components/VaultUnlockModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-037 | 凭据 | 密码/私钥存储和日志 | 仅检查新建测试凭据，持久文件和应用日志无明文秘密 | frontend/src/components/SshKeyImportModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-038 | 设置 | 字体/光标/回滚/渲染器/保活 | 配置真实影响终端并重启保留 | frontend/src/components/SettingsModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-039 | 设置 | 主题/ANSI颜色/自定义主题 | 选择、编辑、保存、重启保持实际效果 | frontend/src/components/settings/TerminalColorSettings.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-040 | 设置 | 壁纸/上传/URL/透明度/模糊/缓存 | 仅使用本地测试图片和回环 URL 验证 | frontend/src/components/SettingsModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-041 | 同步 | 注册/登录/登出/配置 | 只使用本地新建服务及测试账号 | frontend/src/components/SyncSettingsModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-042 | 同步 | 端到端同步/冲突/跨profile解密 | 两个隔离 profile 实际还原业务数据，登录不等于同步成功 | frontend/src/components/SyncSettingsModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-043 | AI 设置 | 开关/厂商/模型/配置/密钥/联通测试 | 本地模拟服务验证配置；不读取现有 API 密钥、不请求真实厂商 | frontend/src/components/settings/ai/AiModelSettings.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-044 | 更新/备份 | 检查/下载/校验/取消/状态/提醒 | 仅本地数据验证，不请求真实更新或替换已安装程序 | frontend/src/components/AboutModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-045 | 更新/备份 | 备份/恢复/迁移 | 仅操作隔离测试数据库，真实安装升级另列无法验证 | frontend/src/components/AboutModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-046 | 插件/端口检测 | 工具/面板/快捷动作/端口检测 | 工具真实运行，端口检测仅回环 | frontend/src/components/PortCheckerModal.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-047 | 界面 | 字段/必填星号/无placeholder/无冗余说明 | 依据本次 AGENTS 逐控件核对 | frontend/src/components/ui/Field.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-048 | 稳定性 | 10分钟/10次重连/4会话 | 保留会话端和服务端时间、数据及资源证据 | frontend/src/stores/terminalStore.ts | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |
| UI-049 | 生命周期 | 关闭应用/重启持久化 | 测试进程、socket、文件资源释放，重启保留配置 | frontend/src/components/AppLayout.tsx | README.md 核心功能、当前界面/代码；用户验收要求；文档未规定的细节为代码推断 |

## 注册 IPC 功能点（逐入口，不代表已验证）

| ID | 模块 | 操作 | 预期行为 | 前端调用入口 | 后端依据 |
|---|---|---|---|---|---|
| IPC-001 | 应用信息 | app_info | 执行对应操作；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:29 | backend/desktop/src/commands.rs:53 |
| IPC-002 | 保险库 | vault_status | 执行对应操作；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:33 | backend/desktop/src/commands.rs:81 |
| IPC-003 | 保险库 | vault_init | 初始化；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:40 | backend/desktop/src/commands.rs:88 |
| IPC-004 | 保险库 | vault_unlock | 解锁；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:50 | backend/desktop/src/commands.rs:100 |
| IPC-005 | 保险库 | vault_lock | 锁定；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:57 | backend/desktop/src/commands.rs:112 |
| IPC-006 | 保险库 | vault_change_password | 修改；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:64 | backend/desktop/src/commands.rs:119 |
| IPC-007 | 会话 | session_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:75 | backend/desktop/src/commands.rs:135 |
| IPC-008 | 会话 | session_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:83 | backend/desktop/src/commands.rs:156 |
| IPC-009 | 会话 | session_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:87 | backend/desktop/src/commands.rs:165 |
| IPC-010 | 会话 | session_update | 更新；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:94 | backend/desktop/src/commands.rs:177 |
| IPC-011 | 会话 | session_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:98 | backend/desktop/src/commands.rs:192 |
| IPC-012 | 会话 | session_duplicate | 复制；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:102 | backend/desktop/src/commands.rs:201 |
| IPC-013 | 分组 | group_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:106 | backend/desktop/src/commands.rs:218 |
| IPC-014 | 分组 | group_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:114 | backend/desktop/src/commands.rs:230 |
| IPC-015 | 分组 | group_rename | 重命名；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:122 | backend/desktop/src/commands.rs:245 |
| IPC-016 | 分组 | group_move | 移动；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:131 | backend/desktop/src/commands.rs:263 |
| IPC-017 | 分组 | group_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:139 | backend/desktop/src/commands.rs:282 |
| IPC-018 | 凭据 | credential_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:143 | backend/desktop/src/commands.rs:295 |
| IPC-019 | 凭据 | credential_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:154 | backend/desktop/src/commands.rs:302 |
| IPC-020 | 凭据 | credential_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:165 | backend/desktop/src/commands.rs:319 |
| IPC-021 | SSH | ssh_key_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:169 | backend/desktop/src/commands.rs:336 |
| IPC-022 | SSH | ssh_key_import | 导入测试数据；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:187 | backend/desktop/src/commands.rs:343 |
| IPC-023 | SSH | ssh_key_pick_file | 选择测试文件；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:178 | backend/desktop/src/ssh_keys.rs:45 |
| IPC-024 | SSH | ssh_key_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:196 | backend/desktop/src/commands.rs:358 |
| IPC-025 | SSH | ssh_key_set_passphrase | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:200 | backend/desktop/src/commands.rs:367 |
| IPC-026 | SSH | connect_session | 执行对应操作；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:214 | backend/desktop/src/commands.rs:385 |
| IPC-027 | 连接生命周期 | connection_close | 关闭并释放资源；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:222 | backend/desktop/src/commands.rs:403 |
| IPC-028 | 连接生命周期 | connection_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | 未检出字符串调用，待人工追踪 | backend/desktop/src/commands.rs:416 |
| IPC-029 | 终端 | terminal_open | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:235 | backend/desktop/src/commands.rs:424 |
| IPC-030 | 代理 | proxy_list_get | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:660 | backend/desktop/src/commands.rs:1877 |
| IPC-031 | 代理 | proxy_list_save | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:666 | backend/desktop/src/commands.rs:1884 |
| IPC-032 | 代理 | proxy_test | 测试连接；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:672 | backend/desktop/src/commands.rs:1912 |
| IPC-033 | RDP | rdp_launch | 启动系统 RDP 客户端；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:688 | backend/desktop/src/commands.rs:2200 |
| IPC-034 | 本地文件/终端 | local_shell_open | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:709 | backend/desktop/src/commands.rs:1975 |
| IPC-035 | Telnet | telnet_open | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:733 | backend/desktop/src/commands.rs:2044 |
| IPC-036 | 终端 | terminal_write | 写入；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:249 | backend/desktop/src/commands.rs:472 |
| IPC-037 | 终端 | terminal_resize | 调整尺寸；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:261 | backend/desktop/src/commands.rs:483 |
| IPC-038 | 终端 | terminal_ack | 确认消费/背压；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:268 | backend/desktop/src/commands.rs:498 |
| IPC-039 | 终端 | terminal_close | 关闭并释放资源；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:276 | backend/desktop/src/commands.rs:509 |
| IPC-040 | 操作取消 | op_cancel | 取消；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:280 | backend/desktop/src/commands.rs:518 |
| IPC-041 | 本地文件/终端 | local_fs_home | 返回起始目录；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:288 | backend/desktop/src/commands.rs:527 |
| IPC-042 | 本地文件/终端 | local_fs_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:292 | backend/desktop/src/commands.rs:535 |
| IPC-043 | SFTP | sftp_list_dir | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:296 | backend/desktop/src/commands.rs:635 |
| IPC-044 | SFTP | sftp_stat | 读取属性；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:300 | backend/desktop/src/commands.rs:651 |
| IPC-045 | SFTP | sftp_mkdir | 创建目录；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:304 | backend/desktop/src/commands.rs:667 |
| IPC-046 | SFTP | sftp_remove_file | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:308 | backend/desktop/src/commands.rs:683 |
| IPC-047 | SFTP | sftp_remove_dir | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:312 | backend/desktop/src/commands.rs:697 |
| IPC-048 | SFTP | sftp_rename | 重命名；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:316 | backend/desktop/src/commands.rs:711 |
| IPC-049 | SFTP | sftp_set_permissions | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:320 | backend/desktop/src/commands.rs:727 |
| IPC-050 | SFTP | sftp_read_file | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:324 | backend/desktop/src/commands.rs:742 |
| IPC-051 | SFTP | sftp_write_file | 写入；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:329 | backend/desktop/src/commands.rs:759 |
| IPC-052 | SFTP | sftp_start_transfer | 启动；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:340 | backend/desktop/src/commands.rs:775 |
| IPC-053 | SFTP | sftp_list_transfers | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:351 | backend/desktop/src/commands.rs:803 |
| IPC-054 | SFTP | sftp_pause_transfer | 暂停；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:355 | backend/desktop/src/commands.rs:811 |
| IPC-055 | SFTP | sftp_cancel_transfer | 取消；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:359 | backend/desktop/src/commands.rs:823 |
| IPC-056 | SFTP | sftp_get_cwd | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:363 | backend/desktop/src/commands.rs:835 |
| IPC-057 | 监控 | monitor_start | 启动；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:371 | backend/desktop/src/commands.rs:849 |
| IPC-058 | 监控 | monitor_stop | 停止；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:375 | backend/desktop/src/commands.rs:877 |
| IPC-059 | 监控 | monitor_get_latest | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:379 | backend/desktop/src/commands.rs:887 |
| IPC-060 | 监控 | monitor_get_history | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:383 | backend/desktop/src/commands.rs:897 |
| IPC-061 | 监控 | monitor_kill_process | 终止测试进程；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:387 | backend/desktop/src/commands.rs:909 |
| IPC-062 | SSH | ssh_exec | 执行测试命令；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:397 | backend/desktop/src/commands.rs:932 |
| IPC-063 | 端口转发 | forward_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:405 | backend/desktop/src/commands.rs:952 |
| IPC-064 | 端口转发 | forward_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:409 | backend/desktop/src/commands.rs:965 |
| IPC-065 | 端口转发 | forward_update | 更新；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:413 | backend/desktop/src/commands.rs:974 |
| IPC-066 | 端口转发 | forward_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:417 | backend/desktop/src/commands.rs:985 |
| IPC-067 | 端口转发 | forward_start | 启动；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:421 | backend/desktop/src/commands.rs:996 |
| IPC-068 | 端口转发 | forward_stop | 停止；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:425 | backend/desktop/src/commands.rs:1013 |
| IPC-069 | 端口转发 | forward_list_statuses | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:429 | backend/desktop/src/commands.rs:1023 |
| IPC-070 | 命令片段 | snippet_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:437 | backend/desktop/src/commands.rs:1036 |
| IPC-071 | 命令片段 | snippet_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:441 | backend/desktop/src/commands.rs:1046 |
| IPC-072 | 命令片段 | snippet_update | 更新；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:445 | backend/desktop/src/commands.rs:1055 |
| IPC-073 | 命令片段 | snippet_delete | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:449 | backend/desktop/src/commands.rs:1066 |
| IPC-074 | 导入导出 | importer_preview_openssh | 预览并报告冲突；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:460 | backend/desktop/src/commands.rs:1088 |
| IPC-075 | 导入导出 | importer_preview_finalshell | 预览并报告冲突；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:470 | backend/desktop/src/commands.rs:1105 |
| IPC-076 | 导入导出 | importer_commit | 确认导入；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:477 | backend/desktop/src/commands.rs:1203 |
| IPC-077 | 导入导出 | importer_export_bundle_json | 导出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:481 | backend/desktop/src/commands.rs:1243 |
| IPC-078 | 导入导出 | importer_export_bundle_encrypted | 导出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:485 | backend/desktop/src/commands.rs:1261 |
| IPC-079 | 导入导出 | importer_preview_bundle_json | 预览并报告冲突；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:492 | backend/desktop/src/commands.rs:1278 |
| IPC-080 | 导入导出 | importer_preview_bundle_encrypted | 预览并报告冲突；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:504 | backend/desktop/src/commands.rs:1331 |
| IPC-081 | 设置 | settings_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:520 | backend/desktop/src/commands.rs:1388 |
| IPC-082 | 设置 | settings_set | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:534 | backend/desktop/src/commands.rs:1399 |
| IPC-083 | 设置 | settings_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:544 | backend/desktop/src/commands.rs:1418 |
| IPC-084 | 更新/备份 | updater_get_state | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:16 | backend/desktop/src/updater.rs:121 |
| IPC-085 | 更新/备份 | updater_check | 检查；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:23 | backend/desktop/src/updater.rs:153 |
| IPC-086 | 更新/备份 | updater_download | 下载；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:33 | backend/desktop/src/updater.rs:200 |
| IPC-087 | 更新/备份 | updater_cancel_download | 取消；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:41 | backend/desktop/src/updater.rs:276 |
| IPC-088 | 更新/备份 | updater_install | 安装；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:49 | backend/desktop/src/updater.rs:289 |
| IPC-089 | 更新/备份 | updater_skip_version | 忽略指定版本；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:53 | backend/desktop/src/updater.rs:170 |
| IPC-090 | 更新/备份 | updater_remind_later | 稍后提醒；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:57 | backend/desktop/src/updater.rs:179 |
| IPC-091 | 更新/备份 | updater_clear_skipped | 清除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:61 | backend/desktop/src/updater.rs:188 |
| IPC-092 | 更新/备份 | updater_backup_now | 创建备份；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:65 | backend/desktop/src/updater.rs:379 |
| IPC-093 | 更新/备份 | updater_list_backups | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:69 | backend/desktop/src/updater.rs:392 |
| IPC-094 | 更新/备份 | updater_open_release_page | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:73 | backend/desktop/src/updater.rs:399 |
| IPC-095 | 更新/备份 | updater_open_log_dir | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:77 | backend/desktop/src/updater.rs:412 |
| IPC-096 | 更新/备份 | updater_open_backup_dir | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:81 | backend/desktop/src/updater.rs:442 |
| IPC-097 | 更新/备份 | updater_open_download_dir | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/updater/ipc.ts:86 | backend/desktop/src/updater.rs:428 |
| IPC-098 | 同步 | sync_get_config | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:69 | backend/desktop/src/commands.rs:1431 |
| IPC-099 | 同步 | sync_save_config | 保存；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:78 | backend/desktop/src/commands.rs:1439 |
| IPC-100 | 同步 | sync_register | 注册测试账号；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:89 | backend/desktop/src/commands.rs:1449 |
| IPC-101 | 同步 | sync_login | 登录测试账号；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:108 | backend/desktop/src/commands.rs:1465 |
| IPC-102 | 同步 | sync_logout | 登出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:121, frontend/src/stores/syncStore.ts:131 | backend/desktop/src/commands.rs:1477 |
| IPC-103 | 同步 | sync_now | 立即同步；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:143 | backend/desktop/src/commands.rs:1483 |
| IPC-104 | 同步 | sync_check_updates | 检查；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/stores/syncStore.ts:158 | backend/desktop/src/commands.rs:1491 |
| IPC-105 | 插件/端口检测 | plugin_list_tools | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/components/PortCheckerModal.tsx:78 | backend/desktop/src/commands.rs:1503 |
| IPC-106 | 插件/端口检测 | plugin_list_panels | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | 未检出字符串调用，待人工追踪 | backend/desktop/src/commands.rs:1510 |
| IPC-107 | 插件/端口检测 | plugin_list_quick_actions | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/components/PortCheckerModal.tsx:79 | backend/desktop/src/commands.rs:1517 |
| IPC-108 | 插件/端口检测 | plugin_execute_quick_action | 执行；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | 未检出字符串调用，待人工追踪 | backend/desktop/src/commands.rs:1524 |
| IPC-109 | 插件/端口检测 | plugin_toggle_feature | 切换；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/components/PortCheckerModal.tsx:113 | backend/desktop/src/commands.rs:1534 |
| IPC-110 | 插件/端口检测 | plugin_check_port | 检查；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/components/PortCheckerModal.tsx:97 | backend/desktop/src/commands.rs:1557 |
| IPC-111 | 工作区卡片 | card_create | 创建；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:552 | backend/desktop/src/commands.rs:1572 |
| IPC-112 | 工作区卡片 | card_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:556 | backend/desktop/src/commands.rs:1582 |
| IPC-113 | 工作区卡片 | card_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:560 | backend/desktop/src/commands.rs:1589 |
| IPC-114 | 工作区卡片 | card_set_mode | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:567 | backend/desktop/src/commands.rs:1599 |
| IPC-115 | 工作区卡片 | card_mark_connected | 更新状态；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:574 | backend/desktop/src/commands.rs:1614 |
| IPC-116 | 工作区卡片 | card_mark_disconnected | 更新状态；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:584 | backend/desktop/src/commands.rs:1626 |
| IPC-117 | 工作区卡片 | card_close | 关闭并释放资源；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:591 | backend/desktop/src/commands.rs:1637 |
| IPC-118 | 串口 | serial_list_ports | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:599 | backend/desktop/src/commands.rs:1654 |
| IPC-119 | 串口 | serial_open | 打开；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:607 | backend/desktop/src/commands.rs:1662 |
| IPC-120 | 串口 | serial_send | 发送；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:616 | backend/desktop/src/commands.rs:1686 |
| IPC-121 | 串口 | serial_read | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:620 | backend/desktop/src/commands.rs:1698 |
| IPC-122 | 串口 | serial_set_lines | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:628 | backend/desktop/src/commands.rs:1713 |
| IPC-123 | 串口 | serial_get_modem_status | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:638 | backend/desktop/src/commands.rs:1733 |
| IPC-124 | 串口 | serial_set_baud_rate | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:642 | backend/desktop/src/commands.rs:1744 |
| IPC-125 | 串口 | serial_get_stats | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:648 | backend/desktop/src/commands.rs:1763 |
| IPC-126 | 串口 | serial_close | 关闭并释放资源；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ipc.ts:652 | backend/desktop/src/commands.rs:1771 |
| IPC-127 | AI 设置 | ai_config_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:18 | backend/desktop/src/commands.rs:1786 |
| IPC-128 | AI 设置 | ai_catalog_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:22 | backend/desktop/src/commands.rs:1793 |
| IPC-129 | AI 设置 | ai_config_save | 保存；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:26 | backend/desktop/src/commands.rs:1800 |
| IPC-130 | AI 设置 | ai_delete_profile | 删除；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:30 | backend/desktop/src/commands.rs:1808 |
| IPC-131 | AI 设置 | ai_set_active_profile | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:34 | backend/desktop/src/commands.rs:1817 |
| IPC-132 | AI 设置 | ai_profile_test | 测试连接；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:38 | backend/desktop/src/commands.rs:1826 |
| IPC-133 | AI 设置 | ai_logo_get | 读取；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:42 | backend/desktop/src/commands.rs:1834 |
| IPC-134 | AI 设置 | ai_history_list | 列出；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | 未检出字符串调用，待人工追踪 | backend/desktop/src/commands.rs:1842 |
| IPC-135 | AI 设置 | ai_set_enabled | 应用；真实返回结果或错误反馈到入口，相关持久化可重启复查（代码推断） | frontend/src/lib/ai/aiIpc.ts:46 | backend/desktop/src/commands.rs:1850 |
