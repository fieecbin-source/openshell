# 洁净室规格书：串口（Serial）通信子系统（spec/serial.md）

> 依据目标：[docs/REQ-2/goal_serial_sftp_view.md](../docs/REQ-2/goal_serial_sftp_view.md) 第 6 节与第 9 节  
> 责任角色：Spec-Writer（洁净室隔离层）  
> 适用对象：Core-Dev、UI-Dev、QA、Security-Reviewer  
> 隔离合规：禁止包含竞品反编译代码、专有私有字符串、图标或文案。全量参数与行为面向开放标准（POSIX termios, Win32 Communications API, ANSI/VT100）。

---

## 1. 串口 Profile 数据模型与配置规格

### 1.1 串口连接配置实体（`SerialProfileConfig`）

串口配置作为通用会话（`Session`）在协议 `Protocol::Serial` 下的专属参数结构（以 JSON 形式存储于 `protocol_options_json`，或映射为强类型结构）：

| 字段名 | 类型 | 取值范围 / 缺省值 | 说明 |
|---|---|---|---|
| `port_name` | String | Windows: `COM1`~`COM256`<br>Linux: `/dev/ttyUSB*`, `/dev/ttyACM*`, `/dev/ttyS*`<br>macOS: `/dev/cu.*` | 端口名称/系统路径，必填 |
| `baud_rate` | u32 | 预设：`110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000, 2000000, 3000000`；支持用户自定义输入任意正整数 | 波特率，默认 `115200` |
| `data_bits` | u8 | `5, 6, 7, 8` | 数据位，默认 `8` |
| `stop_bits` | String / Enum | `"1"`, `"1.5"`, `"2"` | 停止位，默认 `"1"` |
| `parity` | String / Enum | `"None"`, `"Even"`, `"Odd"`, `"Mark"`, `"Space"` | 校验位，默认 `"None"`（注：Mark/Space 平台不支持时降级报错或阻断） |
| `flow_control` | String / Enum | `"None"`, `"RtsCts"`, `"XonXoff"` | 流控模式，默认 `"None"` |
| `dtr_on_open` | bool | `true` / `false` | 连接建立时默认 DTR 状态，默认 `true` |
| `rts_on_open` | bool | `true` / `false` | 连接建立时默认 RTS 状态，默认 `true` |
| `input_newline` | String / Enum | `"CR"`, `"LF"`, `"CRLF"`, `"None"` | 发送时换行映射策略，默认 `"CRLF"` |
| `output_newline` | String / Enum | `"None"`, `"CR_TO_CRLF"`, `"LF_TO_CRLF"`, `"STRIP_CR"` | 接收显示时规整策略，默认 `"LF_TO_CRLF"`（防止阶梯换行） |
| `local_echo` | bool | `true` / `false` | 本地按键回显开关，默认 `false` |
| `auto_reconnect` | bool | `true` / `false` | 意外拔出后检测到重插是否自动重连，默认 `false` |
| `reconnect_interval_ms` | u64 | `500` ~ `10000` | 重连退避基础间隔，默认 `1500` ms |

### 1.2 端口枚举与硬件识别规范

1. **自动枚举接口（`list_serial_ports`）**：
   - 返回端口对象数组：`PortInfo { name: String, port_type: PortType, manufacturer: Option<String>, product: Option<String>, serial_number: Option<String>, vid: Option<u16>, pid: Option<u16> }`。
   - **名称展示规范**：
     - 若获取到厂商与型号（如 FTDI, Silicon Labs CP210x, CH340, Prolific）：在 UI 端口选择下拉框中渲染为：`COM3 (USB-Enhanced-SERIAL CH340)` 或 `/dev/ttyUSB0 (CP2102 USB to UART Bridge Controller)`。
     - 若无硬件描述：直接显示系统端口名（如 `COM1`）。
   - **手动输入兼容**：端口下拉框必须为可输入/筛选复合框（Combobox），允许用户直接手工键入虚拟端口或未枚举出的自定义路径（如 `/dev/ttyS99` 或 `COM20`）。
2. **热插拔与设备感知**：
   - 支持前端主动点击“刷新端口”按钮。
   - 后端后台定时或利用系统事件（Windows 设备通知 / Linux udev 监听）监测端口列表变动，一旦发生增减，发送 `serial://ports-changed` 事件，前端下拉菜单静默更新，不干扰当前选中状态。

---

## 2. 交互模式与数据流规范

### 2.1 终端 ANSI 模式与 HEX 视图双向切换

串口视图卡在命令模式下支持三种数据流显示形态：
1. **ANSI / VT100 终端视图（默认）**：
   - 字节流接入 xterm.js 渲染引擎，支持标准 VT100/VT220/ANSI 转义颜色与光标控制。
   - 适用场景：嵌入式 Linux 控制台、U-Boot、Micropython REPL。
2. **HEX 十六进制转储视图（HEX Monitor）**：
   - 将接收到的字节格式化为经典三列十六进制转储表：
     - `Offset`（8 位十六进制地址/偏移量，如 `00000020`）；
     - `HEX 区域`（每行 16 字节，两两空格隔开，中间第 8 与第 9 字节间加倍宽间距）；
     - `ASCII 可视化字符`（可打印字符如实渲染，不可打印字符显示为圆点 `.`）。
   - **时间戳选项**：支持开启“每帧前置时间戳”（精确到毫秒 `[14:23:05.128]`）。
3. **混合/双栏视图（可选）**：
   - 上半部分 ANSI 控制台，下半部分 HEX 实时报文流。

### 2.2 发送面板与定时循环发送规范

串口会话底部提供收起/展开式专有发送栏：
1. **输入模式（Input Mode）**：
   - `ASCII 文本输入`：支持转义字符解析（`\r`, `\n`, `\t`, `\xHH`）。
   - `HEX 字节输入`：支持直接输入十六进制字符串（如 `01 03 00 00 00 02 C4 0B` 或 `010300000002C40B`），前端自动校验合法性并在发送前转换为二进制 Buffer。
2. **换行策略（Append Newline）**：
   - 可选：`无（None）`、`CR (\r)`、`LF (\n)`、`CRLF (\r\n)`。
3. **发送历史与预设片段（Snippets）**：
   - 记录最近 50 条发送历史，支持键盘上下方向键浏览历史。
   - 支持将常用指令保存为快捷按钮（如 `AT\r\n`、`reboot\r\n`、`Modbus Read 01`）。
4. **循环定时发送（Periodic Sending）**：
   - 支持设置间隔周期（`10` ms ~ `60000` ms，默认 `1000` ms）。
   - 包含一键“开始循环”/“停止循环”指示灯开关；会话断开时自动强制停止，防止向死句柄写入。
5. **逐字节慢速发送（Slow Feed，可选防爆冲）**：
   - 支持在逐字节间插入固定延迟（`1` ms ~ `50` ms），以适应接收缓存极小的低速 MCU（如 8051 / PIC）。

### 2.3 硬件引脚与 Modem 状态指示灯规范

1. **控制线输出控制（DTR / RTS）**：
   - 在串口顶栏/底栏工具条提供独立切换按钮：
     - `DTR`（Data Terminal Ready）：高电平（True）/ 低电平（False）实时切换。
     - `RTS`（Request To Send）：高电平（True）/ 低电平（False）实时切换。
   - 支持一键触发“ESP32/MCU 复位进入下载模式”组合脉冲（DTR/RTS 协同反转 100ms）。
2. **状态引脚输入监测（Modem Status Pins）**：
   - 若底层硬件与驱动支持，周期或事件上报状态灯：
     - `CTS`（Clear To Send）
     - `DSR`（Data Set Ready）
     - `RI`（Ring Indicator）
     - `CD`（Carrier Detect）
   - 绿色为高电平有效，灰色为未使能。

---

## 3. 统计、日志与缓冲管理

1. **实时流量统计**：
   - 统计当前会话已接收总字节数（`Rx Bytes`）、已发送总字节数（`Tx Bytes`）。
   - 计算并显示瞬时收发速率（如 `Rx: 11.2 KB/s`, `Tx: 120 B/s`）。
2. **会话日志落盘与滚动**：
   - 支持一键开启“保存日志到文件”（`.log` 或 `.txt`）。
   - 格式选项：纯文本原始字节流 / 带每行时间戳格式 / HEX 转储格式。
   - 支持配置单文件最大限制（如 50MB 自动分卷滚动）。
3. **清屏与缓冲导出**：
   - 一键清空当前终端与 HEX 缓冲。
   - 一键将当前终端视口缓冲另存为本地文件。

---

## 4. 健壮性、异常处理与背压流控

### 4.1 设备拔出与热插拔断开策略

1. **热拔出识别**：
   - 操作系统拔出 USB 转串口设备时，底层读写立即抛出 `BrokenPipe`, `NotFound`, `PermissionDenied` 或 OS 错误码 2/5/6/22。
   - 后端核心捕获该错误，不能崩溃，必须立即：
     - 将会话状态变更为 `Disconnected`；
     - 向前端推送断线通知，并在视图卡上覆盖半透明“设备已断开”提示；
     - 保留终端历史缓冲与发送区草稿，禁止清空用户屏幕！
2. **一键重连与自动重连**：
   - 卡片上提供醒目的“重新连接”按钮。
   - 用户重新插入 USB 设备后，点击“重新连接”直接重新以原参数打开端口。
   - 若开启了 `auto_reconnect`，后台每隔 `reconnect_interval_ms` 探测目标端口是否存在，一旦发现端口重新出现，自动发起握手并恢复 `Connected` 状态，恢复指示灯并打印 `[System: Port COM3 reconnected]`。

### 4.2 错误提示清晰度

- **端口被占用（Access Denied / Busy）**：
  - Windows：提示“端口 COMx 正在被其他进程占用（请检查是否打开了其他串口调试助手或调试器）”。
  - Linux：提示“端口 /dev/ttyUSB0 打开失败：权限不足。请确认当前用户已加入 dialout 或 uucp 用户组，或检查 udev 规则”。
  - macOS：提示“设备无访问权限，请检查 macOS 系统完整性保护或权限配置”。
- **参数不支持（Invalid Settings）**：
  - 提示明确的字段（如“该串口硬件不支持 Mark 校验位或 1.5 停止位”）。

### 4.3 高速大流量防卡死（921600+ 波特率）背压与节流规格

1. **后端读缓冲（Ring Buffer）**：
   - 后端异步读取使用 64 KiB 环形或块缓冲区，单次批量打包至少 16 KiB 或以 8ms 间隔批量推送至前端 IPC，严禁逐字节触发 IPC 调用。
2. **IPC 与前端节流渲染**：
   - 前端接收到串口二进制/文本帧后，进入前端待渲染队列；
   - 采用 `requestAnimationFrame`（或 16ms 节流）批量调用 xterm 的 `write()` 或 HEX 视图渲染；
   - 在每秒输出 100,000+ 字符时，UI 渲染帧率保持 ≥ 45fps，主界面无假死无掉响应。
3. **内存保护上限**：
   - 终端行数缓冲限制默认 10,000 行（可配置 5,000 ~ 50,000 行），超出自动丢弃最旧的历史行，防止长期运行内存耗尽。

---

## 5. 后端抽象契约（`SerialBackend` Trait）

为实现平台无关性与可测试性，后端核心必须依赖抽象接口：

```rust
#[async_trait::async_trait]
pub trait SerialBackend: Send + Sync {
    /// 打开串口设备
    async fn open(&mut self, config: &SerialProfileConfig) -> Result<(), SerialError>;
    
    /// 从串口读取数据（非阻塞/异步）
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, SerialError>;
    
    /// 向串口写入数据
    async fn write(&mut self, data: &[u8]) -> Result<usize, SerialError>;
    
    /// 设置 DTR 控制线状态
    async fn set_dtr(&mut self, level: bool) -> Result<(), SerialError>;
    
    /// 设置 RTS 控制线状态
    async fn set_rts(&mut self, level: bool) -> Result<(), SerialError>;
    
    /// 读取 Modem 状态引脚（CTS, DSR, RI, CD）
    async fn read_modem_status(&mut self) -> Result<ModemStatus, SerialError>;
    
    /// 动态修改波特率（热更新）
    async fn set_baud_rate(&mut self, baud_rate: u32) -> Result<(), SerialError>;
    
    /// 关闭并释放串口句柄
    async fn close(&mut self) -> Result<(), SerialError>;
}
```

### 5.1 Mock 后端规范（`MockSerialBackend`）
- 内部维持发送与接收的环形队列。
- 允许注入预设响应脚本（例如发送 `AT\r\n`，自动在 20ms 后回送 `\r\nOK\r\n`）。
- 允许模拟意外断线（`simulate_unplug()`）与错误注入（`simulate_busy()`）。
- 保证无任何物理串口硬件环境下，所有单元测试与集成测试 100% 自动化执行。
