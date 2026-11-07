# 本地 Web 模拟数据检查（2026-11-07）

基线：`f8e124f`，分支 `codex/task9-closeout`。用户要求运行本地 Web 并检查模拟数据下的异常。本轮在真实 Chromium 中运行现有前端代码，在 Tauri invoke 边界注入虚构数据，不读取用户浏览器 profile、数据库、凭据或设备。

## 运行方式

- 原始 Vite：`pnpm --dir frontend dev --host 127.0.0.1`，`http://127.0.0.1:1420/`。
- 隔离模拟预览：在 frontend 目录运行 `node E:/Projects/openshell/audit/remediation-task9/web/server.mjs`，`http://127.0.0.1:1422/`。
- 模拟脚本仅由本地测试启动器注入 HTML，不改生产入口、Vite 配置、依赖或锁文件；所有地址使用 `.invalid`，所有密码和引用为合成值，操作只改变测试页内存。
- Chromium 使用独立临时 context。截图、模拟脚本、原始日志和 JSON 记录留在 ignored `web/`；只提交本 Markdown 结论。

## 发现与修复

| 问题 | 实际复现 | 最小修复与验证 |
|---|---|---|
| 连接弹窗不能 Esc 退出，缺少对话框语义和焦点约束 | 打开 SSH 表单，按 Escape 后表单仍显示 | SessionModal 接入现有 useDialogBehavior，增加 dialog/aria-modal/名称。真实浏览器确认 Escape 退出、Tab 留在弹窗内；新增单测先红后绿 |
| 嵌套代理弹窗不能 Esc 退出 | SSH 表单内打开代理管理，Escape 无响应 | ProxyManagerModal 接入同一对话框栈。第一次 Escape 只关闭代理，第二次再关闭连接表单；新增组件和嵌套回归先红后绿 |
| 首开终端抛出 dimensions 异常并丢失初始状态输出 | 真实浏览器三轮首开本地终端，三轮均有 Viewport.syncScrollArea 错误和缺失“认证成功”文本 | xterm 5 的 open() 创建未随 dispose 取消的延迟 viewport 回调，StrictMode 同步销毁首次 setup 后回调访问已销毁 renderer。用可取消的 animation frame 延迟 open，首次丢弃的 setup 不创建 viewport；尺寸同步等 open 后执行，销毁时重置状态输出标记。三轮真实浏览器回归均无异常，初始状态和模拟帧数据均可见 |

未改 xterm 私有实现，未禁用 StrictMode、吞全局异常、放宽测试或增加依赖。终端实例和已有流读取的归属保持，初始化帧在 cleanup 取消；现有终端行为测试通过。

## 实际浏览器检查

18 条操作检查通过，覆盖：

- 1440×900 与 1280×720 首页、五种连接表单、无 placeholder、设置四页及 Esc、连接 Tab 焦点和嵌套 Esc。
- 代理保存失败可见、重试、保存中禁止刷新、成功后清空临时密码。
- 历史代理通过现有 DTO 补录、读回确认后删除旧缓存；同 ID 冲突不保存、不删除原缓存。
- 登录刷新 pending 时退出，旧密码不重现、旧 finally 不清新密码；写成功读失败只读重试且不重复登录。
- 导入真实 File.text pending 后实际关闭/重开，旧失败不污染 B 文件；恢复提交成功后刷新失败仅重读，不重复 commit。
- 片段保存成功但列表读取失败，实际错误和重试可见，不重复 create。
- 转发状态读取失败可见、只读重试、重开后旧失败不回写。开发 StrictMode 双 effect 的两个读取均注入失败，避免把过期失败当当前失败。
- 真实 xterm DOM 渲染认证提示与模拟 PTY 帧数据。

最终复验阶段捕获的未处理页面异常、控制台 warning/error、失败请求和未实现的 mock 命令均为 0。预设 IO 失败阶段有预期的 store warning，未将其隐去或算作未处理异常。原始记录见本地 `web/browser-checks.json`；截图见 `web/home-1440.png`、`web/home-1280.png`、`web/terminal-1280-fixed.png` 等。

## 门禁

| 命令 | 退出码与结果 |
|---|---|
| `pnpm --dir frontend exec vitest run src/components/SessionModal.test.tsx src/components/ProxyManagerModal.test.tsx --maxWorkers=1 --minWorkers=1` | 修复前 exit 1：3 failed / 56 passed；修复后 exit 0：59/59 |
| `node audit/remediation-task9/web/terminal-regression.mjs`（本地脚本） | 修复前 exit 1：3 次运行均异常且缺初始输出；修复后 exit 0：3 次无异常且输出保留 |
| `pnpm --dir frontend exec vitest run src/components/XtermView.test.tsx src/components/TerminalHost.test.tsx src/components/TerminalTabs.test.tsx --maxWorkers=1 --minWorkers=1` | exit 0：13/13 |
| `pnpm --dir frontend exec vitest run --maxWorkers=1 --minWorkers=1` | exit 0：41 文件，442 passed，0 failed |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0：0 errors、12 既有 Hook warnings |
| `pnpm build` | exit 0：保留既有混合 import/大 chunk 提示 |
| `node audit/remediation-task9/web/package-scan.mjs`（本地隔离 profile） | exit 0：新 dist 35 文件通过，不读取真实用户数据库 |
| `git diff --check` | exit 0 |

本轮只修改前端；未重复 Rust 全仓测试。此前 Task9 的 Rust 验证保持其原时点结论。

## 验证边界

这是正式前端在真实浏览器中的模拟 IPC 检查，不能证明真实 Tauri IPC、系统密钥链、SSH/RDP/串口连通、远端同步服务、真实归档解密或跨窗口整表写入正确。未测试设备、NLA/CredUI、跨平台或安装升级。Web 预览的原始 1420 端口没有原生后端，浏览器下不能完成原生连接；1422 的成功响应只代表模拟行为。
