# OpenShell 独立只读验收审查

审查对象：`openshell-verification-20261105` 隔离快照（本地临时目录，绝对路径已省略）。已核对 HEAD 为 `3c17ab1d852bc3991687c7f9dfed1720d2a26dee`，工作树干净。本次审查整个快照，未把空 Git diff 当作无问题。

依据为 `FEATURE_INVENTORY.md` 和当前源码；未阅读主审报告、历史审计结论、真实用户数据或凭据，未连接真实网络主机，未修改文件或运行产品功能测试。下列“验证方式”是可执行的复核步骤，不表示已经完成动态复现。所有文件行号均相对于上述快照根目录。

## 已确认的优点

- SSH 建连存在真实协议握手、认证、主机密钥验证及失败反馈；连接取消和路由失败具有清理路径。
- SSH 启动目录与启动命令在 `backend/desktop/src/commands.rs:442–454` 实际写入通道，并非仅保存配置。
- 更新器在 `backend/crates/updater/src/verify.rs:155` 起实施清单签名校验；缺少签名、信任公钥或签名无效时拒绝继续。
- 公共字段组件 `frontend/src/components/ui/Field.tsx:30–48` 实现了空值彩色五角星和 `aria-required`；组件目录搜索未发现实际 `placeholder=` 或“可选/选填”界面文案。

## 阻塞上线

### 1. 原生串口失败后自动切换内存 Mock，并显示连接成功

**依据：**

- `frontend/src/stores/terminalStore.ts:352–355`：任何原生打开错误都被捕获，然后调用 `openSerial(..., true)`。
- 同文件 `:357–365`：随后标记 `connected`。
- `backend/desktop/src/commands.rs:1668–1671`：`use_mock` 直接传给串口服务。
- `backend/crates/serial/src/service.rs:41–48`：`true` 分支实际创建 `MockSerialBackend`，不是原生设备。

**触发条件：** 连接不存在、被占用、无权限或配置错误的串口。

**实际/预期：** 实际丢弃真实错误，安装内存后端，界面显示成功；预期明确报告原生打开失败，不得用 Mock 冒充连接。违反 UI-020、UI-024 以及本次禁止假成功要求。

**验证方式：** 用不存在的测试端口连接，观察原生打开失败后第二次 IPC 的 `useMock:true` 及最终标签状态；不能以发送接口返回成功认定设备可用。

### 2. 普通 SFTP 上传下载自动按文件长度续传，会保留错误内容或混接文件

**依据：**

- `frontend/src/components/SftpView.tsx:289`、`:310`：普通下载和原生路径上传均传入 `resume:true`。
- `frontend/src/stores/sftpStore.ts:239–252`：默认也为 `true`。
- `backend/crates/sftp/src/transfer.rs:295–307`、`:404–418`：仅依据目标已有长度决定偏移，没有核实目标是不是同一个未完成传输。
- 上传 `:341`、下载 `:462`：当目标长度等于源长度时，循环根本不执行。
- 同文件 `:169–174`、`:257–262`：仍将任务标为 `Completed`、字节数设为总长度。

**触发条件：** 目标目录已有同名文件，内容不同，长度小于或等于源文件。

**实际/预期：** 等长文件完全不更新却报告完成；较短文件保留旧前缀再拼接新后缀。预期普通上传下载正确覆盖或明确询问冲突，续传必须确认文件身份。直接破坏 UI-026 的两端一致性。

**验证方式：** 在隔离目录准备同名等长的 `AAAA` 和 `BBBB`，上传、下载各一次；检查任务完成状态和目标 SHA256。再用较短目标验证混接。

## 应修复

### 3. 串口重连强制改为 COM1，并丢弃原连接配置

**依据：** `frontend/src/stores/terminalStore.ts:626–635` 在重连时重新构造 `{port_name:"COM1", baud_rate:...}`，没有读取原会话的 `protocol_options_json`。

**触发条件：** 原会话使用 COM1 之外的端口，或非默认数据位、校验、停止位、流控等配置后重连。

**实际/预期：** 实际重连其他设备或失败后落入 Mock；预期使用保存的同一端口和完整配置。违反 UI-021、UI-024。

**验证方式：** 保存一组明确不同于默认值的测试串口配置，比较首次打开和重连的 `serial_open` 参数。

### 4. 串口 HEX 和 ASCII 视图同时消费同一接收队列，造成显示缺字节

**依据：**

- `frontend/src/components/TerminalHost.tsx:64–68`：HEX 模式保持可见的 `XtermView`，再叠加 `HexDumpView`。
- `frontend/src/components/XtermView.tsx:532–539`：每 50ms 调用 `readSerial`。
- `frontend/src/components/HexDumpView.tsx:32–35`、`:87`：每 40ms 再调用 `readSerial`。
- `backend/crates/serial/src/native.rs:228–243`：读取的是唯一 `rx_receiver.try_recv()`，消费后不会广播给另一视图。

**触发条件：** 在活动串口标签切换到 HEX 转储后接收数据。

**实际/预期：** 两个消费者分抢字节，HEX 和 ASCII 各得到部分内容；预期两种视图来自同一份完整接收流。违反 UI-022。

**验证方式：** 测试对端持续发送带递增序号的数据，开启 HEX 后核对显示/导出字节与发送端计数。

### 5. 真实串口断开错误被吞掉，标签持续显示已连接，自动重连不触发

**依据：**

- `backend/crates/serial/src/native.rs:190–217`：设备拔出后结束工作线程，后续读取返回 `DeviceDisconnected`。
- `frontend/src/components/XtermView.tsx:544–545`：读取错误被无条件忽略。
- 同文件 `:353–355`：键盘串口发送失败也仅打印警告，没有调用 `markDisconnected`。

**触发条件：** 原生串口已建立后测试设备断开。

**实际/预期：** 实际保持 `connected`，无明确错误、无重连调度；预期更新断开状态并按配置处理重连。违反 UI-007、UI-024。

**验证方式：** 连接测试端口后断开对端，观察读取错误和标签状态；开启自动重连后确认是否出现重试。

### 6. SFTP 运行状态字段前后端不一致，正常运行时失去暂停和取消入口

**依据：**

- `backend/crates/core-domain/src/value_objects.rs:287–295`：`Running` 经 `snake_case` 序列化为 `"running"`。
- `backend/crates/sftp/src/transfer.rs:331`、`:452`：任务实际使用 `Running`。
- `frontend/src/types/ipc.ts:294`：类型只声明 `"transferring"`，没有 `"running"`。
- `frontend/src/components/TransferQueueDrawer.tsx:45`、`:139`、`:149–161`：徽章、速度及操作按钮均依据 `"transferring"`。
- `frontend/src/lib/ipc.ts:350–351`：直接返回 IPC 数据，没有状态转换。

**触发条件：** 任务从排队进入实际传输并被轮询刷新。

**实际/预期：** 实际没有传输中徽章和速度，暂停/取消按钮消失，活动计数错误；预期运行任务正确显示且可操作。违反 UI-027。

**验证方式：** 通过受限速的回环 SFTP 环境启动大文件传输，同时查看返回 JSON 的 `"running"` 与抽屉按钮。

### 7. SFTP 暂停后没有恢复路径

**依据：**

- `backend/crates/sftp/src/transfer.rs:70–76`：暂停只能把原子标记置为 `true`。
- 同文件 `:345–347`、`:466–468`：暂停时不断等待该标记恢复。
- 对前端、桌面命令和 SFTP 实现搜索，未发现将其置回 `false` 的路径。
- `frontend/src/components/TransferQueueDrawer.tsx:149–169`：暂停任务仅有取消按钮。
- `backend/desktop/src/commands.rs:811–831`：提供暂停、取消，没有恢复命令。

**触发条件：** 在排队阶段及时点击暂停，或直接调用现有暂停 IPC。

**实际/预期：** 实际任务永久等待，只能取消或另建任务；预期暂停后可继续同一任务。违反 UI-027 的暂停/续传链路。

**验证方式：** 暂停传输并观察现有 UI/IPC 可用动作；核对是否能恢复原任务 ID 的进度。

### 8. X11 转发是可保存但不生效的配置

**依据：**

- `frontend/src/components/SessionModal.tsx:1654–1661`：提供可启用的“X11 图形转发”。
- 同文件 `:871`：保存 `x11_forwarding`。
- `backend/crates/app-core/src/connection_service.rs:284–301`：构造连接参数时没有该字段。
- `backend/crates/ssh/src/connection.rs:16–33`：连接参数根本没有 X11 配置。
- 同文件 `:552–577`：打开 Shell 时仅有 PTY、Agent 和 Shell 请求，没有 X11 请求或代理链路。
- 全部后端 X11 引用仅涉及实体、存储、导入、同步和测试数据。

**触发条件：** 启用 X11 后连接 SSH。

**实际/预期：** 实际连接行为完全相同；预期选项影响 SSH 通道，或明确不可用。违反 UI-006。此问题由调用链缺失确定，并非因本机没有 X Server 而判断缺失。

**验证方式：** 比较启用/禁用时 SSH 通道请求；在具备 X11 的隔离环境验证 DISPLAY 和转发数据。

### 9. 字符编码可选择、可保存，但终端收发固定按 UTF-8 处理

**依据：**

- `frontend/src/components/SessionModal.tsx:1486–1500`、`:2319–2333`：提供字符编码选择。
- `frontend/src/components/XtermView.tsx:351`：所有键盘输入固定 `new TextEncoder()`。
- 同文件 `:538–539`、`:575–577`：接收原始字节直接写给 xterm，没有按会话编码转换。
- `frontend/src/stores/serialStore.ts:123`、`:141`：串口文本发送同样固定 UTF-8。
- 对相关运行层搜索，没有发现消费会话 `encoding` 的转换路径。

**触发条件：** 选择 GB18030 等非 UTF-8 编码，与使用对应编码的测试端交互。

**实际/预期：** 实际发送字节仍为 UTF-8，非 UTF-8 输出显示乱码；预期收发遵循保存编码。违反 UI-005、UI-022。

**验证方式：** 选 GB18030 输入中文，与测试端收到的字节核对；由对端发送同编码中文核对显示。

### 10. RDP 只有进程启动链路，没有连接、认证失败或退出结果链路

**依据：**

- `backend/desktop/src/commands.rs:2313–2316`：`mstsc.exe.spawn().id()` 后不再持有或等待子进程。
- 同文件 `:2328`：启动即记录会话使用成功。
- `frontend/src/stores/terminalStore.ts:315–325`：启动返回后立即设为 `connected`。
- `frontend/src/components/RdpSessionView.tsx:35–39`、`:143`：虽谨慎显示“已启动”，但没有认证或断开反馈来源。
- `frontend/src/stores/terminalStore.ts:800–820`：关闭标签只清理卡片、串口、终端和 SSH 连接，没有 RDP 生命周期操作。
- RDP 相关引用搜索未发现进程退出监视或连接结果事件。

**触发条件：** mstsc 启动成功后目标不可达、认证失败，或用户关闭远程桌面窗口。

**实际/预期：** OpenShell 仍保留已启动/`connected` 状态；关闭标签也不会管理该 RDP 窗口。预期按本次 UI-016、UI-019 要求识别真实连接和断开结果，不能将启动成功作为验收通过。这里认可面板使用“已启动”的准确文案，但它仍未实现要求的结果链路。

**验证方式：** 使用回环测试服务分别验证不可达、错误认证、正常退出，观察标签和最近记录；单独记录外部 mstsc 反馈不能替代 OpenShell 状态反馈。

## 未覆盖与 declined-to-judge

- 未运行真实 SSH/SFTP/RDP/串口会话、本机编译或测试；因此不对上述问题以外的功能给出动态通过结论。
- 未完整审查监控采集/进程操作、所有转发类型、导入冲突、同步冲突与跨 profile 解密、AI 联通测试、备份恢复和真实升级。
- 对更新签名实施做了静态检查，但未读取发布环境或真实更新服务，因此不判断正式发布是否配置了有效信任公钥和签名资产。
- 未检查真实磁盘或日志中的明文秘密；不以“源码未发现”保证现有用户数据安全。
- 没有把缺少硬件、X Server、桌面环境或真实安装条件视为实现缺失。
- 字段规范只检查了公共组件与组件目录中的明确字符串，不声称已经逐控件完成浏览器验收。
- `cmdkey` 使用系统凭据管理器保存 RDP 凭据，其实现不是明文文件持久化；本次不将该设计本身认定为明文存储漏洞。

## 结论

**当前快照不满足上线验收。** 串口失败后自动假成功和 SFTP 同名文件内容损坏属于阻塞问题；另有可由当前源码确定的配置不生效、传输操作缺失及连接生命周期问题。以上均为只读发现，未实施修复。
