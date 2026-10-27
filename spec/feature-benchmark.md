# 功能对标：OpenShell vs SecureCRT / Xshell / MobaXterm / Tabby / WindTerm

> 来源说明（2026-10 检索）：
> - MobaXterm 官方文档 <https://mobaxterm.mobatek.net/documentation.html>：Split 2/4 终端、MultiExec 同步输入、右键文件夹批量启动会话。
> - Tabby 官网 <https://tabby.sh/>：任意方向分屏、自动读取 `~/.ssh/config`、崩溃后 `recoverTabs`、双宽字符支持。
> - WindTerm 官网 <https://windterm.io/> 及公开评测：4/16 分屏同步输入、会话组、ProxyJump、登录后脚本。
> - Xshell / NetSarang 官方支持库 <https://netsarang.atlassian.net/>：`File → Third party Import` 支持从 SecureCRT 导入会话。
> - SecureCRT 官方产品页 <https://www.vandyke.com/products/securecrt/>：会话管理与导入导出。**细项未逐条核实，标注为「印象性」**，不作为改动的唯一依据。
>
> 「项目现状」一栏均可在代码中定位（见括号内文件行号），非推测。

## 一、对标表

| 功能点 | 业界常见做法 | 项目现状 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| 会话分组 | 多级文件夹 + 拖拽移组 + 整组批量启动 | 后端有 `parent_id`/`sort_order`/8 层深度限制，UI 此前只渲染单层、无拖拽 | 中 | P1（本轮补齐） |
| 最近连接 | 独立入口，按使用时间排序 | 后端有 `last_used_at`/`use_count`，前端零引用 | 小 | P1（本轮补齐） |
| 收藏 | 有 | 有 | 无 | — |
| 搜索过滤 | 名称 / 主机 / 标签 | 走后端 `session_list(query)` | 无 | — |
| 快速连接 | 不入库直达 | 命令面板解析 `root@host:port` 后仍强制落库 | 中 | P1（未做） |
| 导入导出 | OpenSSH config / SecureCRT / Xshell | OpenSSH + FinalShell + JSON/加密 bundle | 大 | P2（未做） |
| 标签拖拽重排 | 均有 | 无 | 中 | P1（未做） |
| 标签状态指示 | 连接中 / 已连接 / 断开 / 异常 | 仅「绿色=已连接」；后端 `Exit` 事件被前端丢弃，退出后仍显示已连接 | 大 | **P0（本轮修复）** |
| 分屏 + 同步输入 | MobaXterm 2/4 屏 + MultiExec | 上下二分屏已有；MultiExec 选中集过期、不支持串口 | 中 | P1（本轮修复） |
| 终端搜索 | 有 | `addon-search` + Ctrl+F | 无 | — |
| URL 点击 | 有 | addon 已安装但未启用 | 小 | P1（本轮启用） |
| Unicode 宽度 | Tabby 明确支持双宽字符 | `addon-unicode11` 装了没用，CJK/emoji 列宽按 Unicode 6 | 中 | P1（本轮启用） |
| 复制粘贴策略 | 可配「选中即复制 / 右键粘贴」 | 有选区时 Ctrl+C 强制复制、无法中断进程；右键菜单已有复制/粘贴 | 中 | P1（部分） |
| 字符编码 | SecureCRT/Xshell 支持 GBK | `session.encoding` 字段闲置，底栏硬编码显示 UTF-8 | 大 | P2（未做） |
| 认证方式 | agent / ProxyJump / 多轮 keyboard-interactive | Agent 未实现（报 `AUTH_METHOD_UNSUPPORTED`）；ProxyJump 可配但后端忽略；kbd 用同一密码回填所有 prompt | 大 | ProxyJump 本轮改为**显式禁用**，其余未做 |
| 主机密钥确认 | 指纹弹窗 + 变更告警 + 可信主机管理 | 只有会话级策略下拉；**迁移代码曾把 strict 静默改写成 accept_new** | 大 | **P0（本轮修复降级）** |
| 断线检测与重连 | KeepAlive + 自动重连 + 状态可视化 | 旧：keepalive 单次失败即停、`keepalive_max_miss` 未用、从不发 `Closed`、无自动重连 | 大 | **P0（本轮修复）** |
| 端口转发 | 本地/远程/动态 + 状态可见 | 远程为空壳却报成功；SOCKS5 口令写死为 `None` 导致任意凭据放行 | 大 | **P0（本轮修复）** |
| SFTP | 拖拽上传 + 进度推送 | 分块/续传/进度已有，但进度靠轮询、续传 offset 仅按文件大小推断 | 小 | P2（未做） |
| 应用深浅主题 | 均有 | 仅有浅色外壳；`settingsStore.theme` 是终端 16 色配色，不是应用主题 | 大 | P2（本轮不做，用户已确认） |
| 多语言 | 均有 | i18next 已装但零接入 | 中 | P2（本轮不做） |
| 窗口状态记忆 / 快捷键自定义 | 均有 | 无 | 中 | P2（未做） |

## 二、本轮已落地的对标结论

1. **终端连续性**是最大的体验差距：切换标签/视图会导致 `term.dispose()` 并重新 `open_shell`。→ 已改为常驻终端（`TerminalHost`）。
2. **状态收敛**是最大的可靠性差距：后端从不通知「连接已关闭」，前端也不处理 `Exit`。→ 已补 `Closed` 事件 + 退出码透传 + 标签状态机。
3. **安全声明与实现不符**：钥匙串是伪实现、strict 策略被静默降级、SOCKS5 认证形同虚设。→ 已修正（钥匙串开关移除、降级语句删除、认证必须真实校验）。

## 三、明确未做（需决策）

- ssh-agent 认证、多轮 keyboard-interactive 交互通道、ProxyJump 真实实现（当前 UI 已置灰并提示未支持）。
- GBK/GB18030 编码、SecureCRT/Xshell 导入器。
- 应用级深浅主题、i18n。
- 标签拖拽重排、快速连接（不落库直达）、窗口状态记忆、快捷键自定义。
- CSP 收紧与 release 去除 devtools（需在 `pnpm tauri dev` 与 `tauri build` 双环境实测，本轮环境无 Rust 工具链，未改）。
