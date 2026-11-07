# Task 2 — FinalShell 零限速全带宽传输、高可靠自愈连接、绿/红状态标签细节复刻与连接详情查看器

- **版本**：v1
- **模式**：L2（前后端契约已由 CEO 锁定，三名员工按严格隔离的文件白名单并行执行）
- **返工/演进自**：Task 1 审查问题 #1~#4 + 用户新增「禁止限速、移植 FinalShell 优秀连接逻辑、复刻连接成功绿色/失败红色标签细节、保证连接可靠稳定、优化连接模块查看细节」需求

---

## 一、背景与总目标

基于 CEO 对 `D:\programfile\finallshell\finalshell\finalshell.jar` 的字节码反编译（`L0.class` 速率统计、`CK.class` 打包传输、`Bg.class` 加速模块、`zD.class` 双通道自动重开、`Cf.class`/`com.DI` Socket 参数、`Bq.class`/`t3.class`/`VO.class` 标签状态染色、`lv.class`/`YE.class` 连接与转发常量反射提取）以及 Task 1 的审查结果，本轮 **Task 2** 目标如下：

1. **彻底禁止限速 & 全速 SFTP 流水线传输（无需任何会员，满带宽运行）**：
   - 将 SFTP 单块传输大小 `CHUNK_SIZE` 从 64 KiB 升级为 **512 KiB (`512 * 1024`)**，并配合 **1 MiB `BufReader` / `BufWriter` 异步读写缓冲** 与最高 **8 路并发传输**，消除高延迟链路上的单块串行等待瓶颈；严禁在传输循环中插入任何人为限速或 `sleep`（仅 `paused` 暂停态除外）。
2. **连接高可靠稳定加固 & SFTP 通道断线自动重开（复刻 FinalShell `zD.I()` Auto-Heal）**：
   - 修复 `proxy.rs` 直连分支遗漏 `set_nodelay(true)` 的问题，确保直连、HTTP/SOCKS4/SOCKS5 代理、SSH 跳板全链路开启 `TCP_NODELAY`；
   - 在 `connection.rs` 的 `russh::client::Config` 中显式配置大流控窗口 `window_size: 4 * 1024 * 1024` (4 MiB) 与 `maximum_packet_size: 65536` (64 KiB)；
   - 在 `AppServices` 与 `commands.rs` 中实现 **SFTP 子通道断线自动重开（Auto-Heal）**：当缓存的 `SftpClient` 因空闲或子通道异常报错、但底层 SSH 连接仍存活时，自动清理失效缓存并透明重开一次 SFTP 子通道重试；
   - 在前端 `terminalStore.ts` 中实现 **断线自动重连调度**：当会话启用 `auto_reconnect`（默认开启，最多 `reconnect_max` 次）且被动断开时，自动进入 `reconnecting` 状态并按退避间隔自动重连。
3. **复刻 FinalShell「连接成功标签绿色、失败红色」视觉细节**：
   - 在 `TerminalTabs.tsx` 中，连接成功 (`connected`) 标签显示鲜亮翠绿圆点 (`#10b981` / `bg-emerald-500`) + 绿光环与活动标签底部翠绿高亮条；连接失败/断开 (`error` / `disconnected`) 标签显示醒目亮红圆点 (`#ef4444` / `bg-red-500`) + 淡红警示边框/底色 + 标签内一键重连按钮 (`↻`)；连接中/重连中 (`connecting` / `reconnecting`) 显示脉冲琥珀黄圆点与重连计数。
4. **新增「连接详情与诊断查看面板 (`ConnectionDetailsPopover.tsx`)」& 补齐 Task 1 遗留收口**：
   - 在标签栏、状态栏、左侧栏提供一键查看当前连接详情（连接状态绿/红徽章、在线时长、目标 `username@host:port`、协议、直连/代理/跳板拓扑、心跳保活与自动重连参数、全速无限制传输标识、活动隧道列表、一键重连/修改配置/复制诊断信息）；
   - 打通 `RdpSessionView` 与 `ConnectionDetailsPopover` 直接唤起 `SessionModal` 编辑当前连接配置的通道；
   - 补齐 FinalShell 导入器的数字 `conection_type = 101` (RDP)、数字 `authentication_type` (`1/2/3`) 以及内嵌 `port_forwarding_list`（`YE.class` 结构）自动转换为独立端口转发规则落库。

---

## 二、分流表（员工身份路由）

| 员工编号与名字 | 是否参与本 Task | 任务文档 | 负责范围摘要 |
|---|---|---|---|
| **员工1：`gemini4`** | ✅ 参与 | `multi-agent/task2/gemini41.md` | 前端连接详情查看面板 (`ConnectionDetailsPopover.tsx`)、左侧栏连接状态与链路摘要增强 (`ServerSidebar.tsx`)、新建/编辑连接弹窗可靠性默认值与说明优化 (`SessionModal.tsx`) |
| **员工2：`gtp`** | ✅ 参与 | `multi-agent/task2/gtp2.md` | 后端 SFTP 512KiB 零限速全速引擎 (`transfer.rs`)、SFTP 断线自动重开 (`app_services.rs` + `commands.rs`)、SSH 大窗口与直连 `TCP_NODELAY` (`connection.rs` + `proxy.rs`)、FinalShell 数字 RDP `101` 与内嵌隧道自动落库 (`finalshell.rs` + `commands.rs`) |
| **员工3：`trae`** | ✅ 参与 | `multi-agent/task2/trae3.md` | 前端绿/红连接状态标签视觉复刻 (`TerminalTabs.tsx`)、断线自动重连调度与在线计时 (`terminalStore.ts`)、`ConnectionDetailsPopover` 挂载与 `RdpSessionView` 直接编辑配置联动 (`AppLayout.tsx` + `TerminalHost.tsx` + `RdpSessionView.tsx`) |

---

## 三、全局架构与接口锁定约定（CEO 已预置，全员必须遵守）

### 1. CEO 已预置的跨组件契约（`frontend/src/components/ConnectionDetailsPopover.tsx` 与 `terminalStore.ts`）
CEO 已在代码库中预先锁定以下接口与类型字段，确保员工1 (`gemini4`) 与员工3 (`trae`) 可完全独立并行编译：

- **`TerminalTab`（位于 `frontend/src/stores/terminalStore.ts`）已包含字段**：
  ```ts
  /** 连接就绪时间戳（毫秒），供连接详情面板计算实时在线时长 */
  connectedAt?: number | null;
  /** 当前自动重连尝试次数 */
  reconnectAttempt?: number;
  ```
- **`ConnectionDetailsPopoverProps`（位于 `frontend/src/components/ConnectionDetailsPopover.tsx`）锁定签名**：
  ```ts
  export interface ConnectionDetailsPopoverProps {
    open: boolean;
    onClose: () => void;
    tab: TerminalTab | null;
    session?: Session | null;
    /** 触发重新连接当前标签 */
    onReconnect?: (tabId: string) => void;
    /** 打开连接配置编辑弹窗 */
    onEditSession?: (session: Session) => void;
    /** 打开端口转发/隧道管理弹窗 */
    onOpenPortForward?: () => void;
    /** 打开全局代理服务器管理弹窗 */
    onOpenProxyManager?: () => void;
  }
  export const ConnectionDetailsPopover: React.FC<ConnectionDetailsPopoverProps>;
  ```

### 2. CEO 逆向提取的 FinalShell 精确常量（供员工2 `gtp` 实现导入器）
通过运行 Java 反射探针读取 `finalshell.jar` 中 `lv.class` 与 `YE.class` 的运行时常量池：
- `lv.C = 100` → `conection_type: 100` 为 **SSH** (`Protocol::Ssh`)
- `lv.F = 101` → `conection_type: 101` 为 **Windows 远程桌面 RDP** (`Protocol::Rdp`)
- `lv.K = 1` → `authentication_type: 1` 为 `AuthMethod::Password`
- `lv.n = 2` → `authentication_type: 2` 为 `AuthMethod::PublicKey`
- `lv.v = 3` → `authentication_type: 3` 为 `AuthMethod::KeyboardInteractive`
- `YE.class`（`port_forwarding_list` 数组元素）：
  - JSON 结构：`{"id": 1, "name": "rule_name", "type": 100, "ip": "127.0.0.1", "port": 8080, "dst_address": "127.0.0.1", "dst_port": 80}`
  - `YE.A = 100`（或字符串 `"L"` / `"local"`）→ `PortForwardType::Local`
  - `YE.H = 200`（或字符串 `"R"` / `"remote"`）→ `PortForwardType::Remote`
  - `YE.e = 300`（或字符串 `"D"` / `"dynamic"`）→ `PortForwardType::Dynamic`

### 3. 各员工文件白名单边界（严禁越界修改）
- **员工1 (`gemini4`) 独占文件**：
  - `frontend/src/components/ConnectionDetailsPopover.tsx`
  - `frontend/src/components/ServerSidebar.tsx`
  - `frontend/src/components/SessionModal.tsx`
- **员工2 (`gtp`) 独占文件**：
  - `backend/crates/sftp/src/transfer.rs`
  - `backend/crates/app-core/src/app_services.rs`
  - `backend/crates/ssh/src/connection.rs`
  - `backend/crates/ssh/src/proxy.rs`
  - `backend/crates/importer/src/finalshell.rs`
  - `backend/desktop/src/commands.rs`
- **员工3 (`trae`) 独占文件**：
  - `frontend/src/stores/terminalStore.ts`
  - `frontend/src/components/TerminalTabs.tsx`
  - `frontend/src/components/RdpSessionView.tsx`
  - `frontend/src/components/TerminalHost.tsx`
  - `frontend/src/components/AppLayout.tsx`

---

## 四、回执填写要求

完成后请将回执写入 `multi-agent/task2/Task 2 Feedback.md` 中属于你自己的小节（不得修改他人小节），写完后重新读取确认已保存。

