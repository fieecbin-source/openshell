# 终端生命周期与连接状态设计（2026-10 改造）

本文记录本轮「终端连续性 + 连接状态收敛」的关键设计决策，便于后续维护时理解「为什么这么写」。

## 1. 常驻终端（TerminalHost）

### 问题
旧实现只在 `AppLayout` 里按 `activeTabId` 条件渲染**一个** `XtermView`，且终端/分屏/SFTP 三种视图各有独立挂载点。后果：

1. 切标签 → `XtermView` 卸载 → `term.dispose()`，scrollback 全部丢失；
2. 切回 → 重新 `terminal_open` → 后端无条件 `open_shell`，**远端多开一个 shell**；
3. 旧 SSH 通道的读写任务没有 abort，与新通道同时向前端 Channel 灌数据（泄漏 + 输出串台）。

### 方案
`frontend/src/components/TerminalHost.tsx` 遍历 `tabs` **全量挂载**所有终端，用可见性控制显隐：

```text
TerminalHost (absolute inset-x-0 top-0, height 由外层给)
└── for each tab: <div absolute inset-0 visibility:hidden|visible>
    ├── XtermView（常驻，只有关闭标签才 dispose）
    ├── 串口会话额外渲染 SerialControlBar / SerialSendBar / HexDumpView
    └── DisconnectedBackdrop（仅当前标签可见且状态为 disconnected/reconnecting）
```

关键约束：

- **禁用 `display:none`**：它会让容器尺寸变成 0，`fit()` 会算出 1x1 这类极小值并同步给远端 PTY，恢复可见后全屏程序错乱。改用 `visibility: hidden; pointer-events: none`。
- **隐藏的终端不 fit、不发 resize、串口不轮询**：`XtermView` 的 `visible` 属性同时控制三件事，避免多标签时 IPC 线性增长（串口旧实现是 50ms 轮询/标签）。
- **主页以覆盖层形式展示**：`isHomeActive` 时工作区只是 `visibility: hidden`，不卸载，因此「终端 → 主页 → 切回终端」也不重建。

### fit 时序
1. 初始化：`term.open()` → 立即 `syncSize()` 一次（此时可见才生效）；
2. `visible` 由 false → true：`requestAnimationFrame` 后再 fit，等浏览器完成布局；
3. 容器尺寸变化（拖分割条、窗口缩放）：`ResizeObserver` **50ms 防抖**后 fit；
4. 字号 / 字体变化：先应用 `term.options`，再 rAF 后 fit。

`syncSize()` 只在 `cols/rows` **真的变化**时才 `terminal_resize`，避免来回抖动；串口会话跳过 resize。

## 2. 连接状态机

```text
[*] --openSession--> connecting --成功--> connected
connecting --失败--> error              （等用户处理凭据/网络）
connected --远端退出/Closed/心跳失联--> disconnected 或 reconnecting
reconnecting --重连成功--> connected
reconnecting --超过 reconnect_max--> disconnected（附「自动重连 N 次未成功」）
任意 --用户关闭标签--> [*]
```

- 后端职责：**如实上报**。`SshConnection` 内新增健康监视任务（即使 `keepalive_sec = 0` 也每 30s 轮询 `is_closed()`），连续 `keepalive_max_miss` 次失败才判定失联，并通过 `watch` 通道广播；`ConnectionService::spawn_close_monitor` 收到后清理连接表并 emit `ConnectionState::Closed`。
- 前端职责：**重试策略与 UI**。`terminalStore.markDisconnected()` 按会话的 `auto_reconnect` / `reconnect_max` 计算指数退避（`lib/backoff.ts`：1s→2s→4s…上限 30s，±20% 抖动），定时器按 tabId 保存，关闭标签时清理。
- 退出码：`TerminalNotice::Exit` 不再伪造 `Some(0)`，桥接层拿不到真实 `exit-status` 时传 `None`，界面显示「退出码未知」而不是「正常退出」。

## 3. 背压与批量

后端已有 16KiB/8ms 批量 + 三级背压（256/512KiB 信用窗口、8MiB 硬上限）。本轮修正三处记账错误：

- `CreditTracker::on_ack` 改为 `fetch_update` 原子扣减（旧的 `load` + `store` 在并发 ack 下会互相覆盖，窗口越用越大）；
- `wait_for_resume` 用 50ms 超时兜底，避免「检查后、await 前」的 `notify_waiters()` 丢失导致永久挂起；
- `DropOldest` 现在**真的丢弃当前批次**（旧实现只扣计数器、帧照发，记账与发送量错位且内存不回收）。

## 4. 会话树

- `lib/groupTree.ts` 为纯函数（建树 / 统计 / 成环判断 / 稀疏 `sort_order`），有单测覆盖；
- 拖拽落库：会话 → `session_update { group_id, sort_order }`；分组 → 新增命令 `group_move`（仓储层已有 `move_to`，含成环与 8 层深度校验）；
- `sort_order` 采用「相邻取中值」稀疏步进，间隙耗尽（差 ≤ 1）时退化为按落点取值并提示，避免每次拖拽重写整表。

## 5. 本地构建与验证

### 环境（本机实测，Windows / 非管理员）

| 组件 | 版本 / 位置 | 说明 |
| --- | --- | --- |
| Rust | 1.99.1 `stable-x86_64-pc-windows-gnu` | 用 `rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal` 装在用户目录，无需管理员 |
| 链接器 / C 编译器 | MinGW-w64 gcc 16.2.0（WinLibs，`%LOCALAPPDATA%\openshell-tools\mingw64\bin`） | 供 `rusqlite`（bundled SQLite）、`ring` 等 C 依赖编译与最终链接 |
| WebView2 运行时 | Evergreen 155.x（`winget install Microsoft.EdgeWebView2Runtime`） | Tauri 运行必需；未安装时程序启动即失败 |
| Node / pnpm | 24.12 / 9.15 | 前端构建 |

> 为什么不用 MSVC：本机没有 VS Build Tools 且无管理员权限；GNU 工具链是可行替代，但**必须**配合下面两条注意事项。

### 常用命令

```powershell
# 让当前会话能用到工具链（新开终端需重设）
$env:Path = "$env:LOCALAPPDATA\openshell-tools\mingw64\bin;$env:USERPROFILE\.cargo\bin;$env:Path"

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --exclude openshell-desktop     # 见下方说明
pnpm typecheck ; pnpm test ; pnpm build
pnpm desktop:build                                     # = tauri build --no-bundle
```

### GNU 工具链的两个坑（已在仓库内处理 / 需知晓）

1. **`crate-type` 必须去掉 `cdylib`**：Tauri 模板默认 `["staticlib","cdylib","rlib"]` 是为移动端准备的；Windows-GNU 链接 cdylib 会因需要导出数万个 Rust 符号直接失败（`ld: export ordinal too large`）。`backend/desktop/Cargo.toml` 已改为 `["rlib"]`，桌面构建不受影响。
2. **`cargo test` 需排除 `openshell-desktop`**：该 crate 是 Tauri 外壳，本身有 0 个测试函数；其测试 harness 二进制在 MinGW 下加载时报 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（主程序 `OpenShell.exe` 不受影响，已实测可正常启动与渲染）。如改用 MSVC 工具链可去掉该排除。
3. 链接时有告警 `.rsrc merge failure: multiple non-default manifests`（MinGW windres 合并 Tauri 应用清单失败），不影响运行，但会导致 exe 缺少部分清单项（如 DPI 感知声明）。

### 实测结果

- `cargo fmt --all -- --check` → 通过
- `cargo clippy --workspace --all-targets -- -D warnings` → 通过（0 警告）
- `cargo test --workspace --exclude openshell-desktop` → **90 passed / 0 failed**
- `pnpm typecheck` / `pnpm test`（19 passed）/ `pnpm build` → 通过
- `pnpm desktop:build` → `target/release/OpenShell.exe`（11 MB），启动后界面正常渲染

> 注意：本机环境变量 `HTTP_PROXY=http://127.0.0.1:9674` 会把 `127.0.0.1` 的请求也送进代理，导致 `server_sync_e2e_test` 收到 502。跑测试前需 `$env:NO_PROXY="127.0.0.1,localhost"`。

## 6. 本轮未完成 / 待决策

| 项 | 原因 |
| --- | --- |
| ProxyJump 真实实现 | 需 `russh::client::connect_stream` 集成验证；本轮把 UI 置灰并明确提示「未实现」，已保存的字段不清空 |
| CSP 收紧 / release 去 devtools | 需在 dev 与 release 双环境实测，否则可能直接白屏；建议值为 `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost` |
| SQLite 热路径 `block_in_place` | 握手路径上的 `known_hosts` 查库仍跑在 tokio worker 上，是偶发卡顿的潜在来源 |
| 主密码 KDF 参数下限 | 直接提高会让测试用的 `fast_kdf()` 与历史 vault 失败，需要配套迁移策略 |
| 钥匙串真实接入 | 按决策改为移除虚假声明；真正接入需要新增 `keyring` 依赖 |
| 安装包产物 | 当前用 `--no-bundle`（只产 exe）；要产 MSI/NSIS 安装包需 `tauri build`（会下载 WiX/NSIS，受代理与网络影响） |
