# Task 4 员工1协议续检证据

日期：2026-11-06；工作区：仓库根目录（绝对路径已省略）。本次保留原有未提交实现；`baseline.diff` 与 `baseline-hashes.json` 是本子任务读取时的协议源码基线，不代表历史代码已验收。未提交、推送或修改用户凭据。

## 本次实际增量

- 新增 `backend/desktop/src/rdp_process.rs`，从现有 RDP 启动/关闭路径提取最小进程清理边界；启动失败删除本次临时 `.rdp`；关闭先确认或终止并等待持有的子进程，只在清理成功后报告完成；错误向上传播，缺失临时文件允许幂等重试。
- 仅修改 `backend/desktop/src/commands.rs` 的 RDP 区：调用清理函数，保留 `launch_id` 与状态契约；不再调用 cmdkey 写入共享 `TERMSRV/host` 凭据，mstsc 使用 `/prompt` 获取凭据。未读取或删除用户现有系统凭据。主线程注册 `mod rdp_process`。
- 此次没有改动 serial/ssh/terminal_encoding 既有生产实现。SSH Agent定向测试暴露测试服务端错误地比较公钥注释，已改为比较 `key_data()`；仍要求真实签名后回调与5种成功/失败场景断言，未放宽认证检验。

## 已执行命令及结果

| 命令 | 退出码 | 证据与范围 |
|---|---:|---|
| `rustc +stable-x86_64-pc-windows-msvc --edition 2021 --test backend/desktop/src/terminal_encoding.rs -o audit/remediation-task4/gpt/continuation-protocols/encoding-tests.exe`，随后运行该测试程序 | 编译0、测试0 | `encoding-result.json`、`encoding-tests.log`：3通过。UTF-8与控制序列、ISO-8859-1精确编码及不能表示时失败、GB18030中文/emoji、GBK/Big5/Shift-JIS无法无损表示时失败、未知编码失败。属于本机Windows编码边界，不是前端收发联调。 |
| 提取旧清理逻辑后，`rustc +stable-x86_64-pc-windows-msvc --edition 2021 --test backend/desktop/src/rdp_process.rs -o audit/remediation-task4/gpt/continuation-protocols/rdp-process-tests.exe`，运行测试程序 `--nocapture` | 编译0、测试101 | `rdp-red.log`：3失败，分别捕获启动失败遗留临时文件、清理失败返回成功、没有返回实际等待的进程退出码。 |
| 修复后相同 RDP 定向编译及测试命令 | 编译0、测试0 | `rdp-green.log`：3通过。测试使用故意不存在的程序、专用临时路径与自己启动的隐藏PowerShell睡眠子进程；没有启动真实mstsc，没有操作其他用户进程。 |
| `git diff --check -- backend/desktop/src/rdp_process.rs backend/desktop/src/commands.rs` | 0 | 无空白错误；Git仅提示既有CRLF转换。新模块已由rustfmt单文件格式化。 |
| 主线程顺序执行 `cargo +stable-x86_64-pc-windows-msvc test -p openshell-serial --locked --offline --jobs 2` | 0 | 已重读 `serial-green.log`：3个native单元测试+7个集成测试通过。仅其中不存在端口测试走原生打开；Mock回环不计硬件验收。 |
| 主线程首次执行 `cargo +stable-x86_64-pc-windows-msvc test -p openshell-ssh --locked --offline --jobs 2` | 101 | `ssh-green.log` 实际是失败日志：6通过、Agent测试1失败。根因为ssh-key的PublicKey相等包含comment，而SSH线上公钥不携带comment；仅修正测试服务端为key_data身份比较。 |
| 主线程修正后执行 `cargo +stable-x86_64-pc-windows-msvc test -p openshell-ssh --no-fail-fast --locked --offline --jobs 2` | 0 | `ssh-final.log`：7单元+1真实主机密钥握手集成+1转发集成通过；Agent签名、空身份、拒签、不可用、服务器拒绝的断言全部保留。 |
| 主线程首次运行 `run-g04.ps1` | 脚本1、baseline cargo101 | 独立副本Cargo.lock与manifest不匹配，`--locked`阻止更新；见 `g04-prelock-run.log`、`g04-prelock-baseline.log`。此时未进行Trust变异，不计行为红。 |
| 隔离lock准备 | 最终0 | `generate-lockfile --offline`因已撤回版本失败101；复用根lock的metadata因未缓存Android依赖失败101，限定 `--filter-platform x86_64-pc-windows-msvc` 后metadata退出0；根Cargo.lock哈希不变，仅写隔离副本。见 `g04-lock.log`、`g04-lock-repair.log`、`g04-windows-lock-repair.log`。 |
| 主线程最终运行 `run-g04.ps1` | 脚本0；baseline0、mutation101、restored0 | `g04-result.json`、`g04-baseline.log`、`g04-mutated.log`、`g04-restored.log`。无条件Trust使真实握手安全断言失败；finally恢复原字节后通过。共享known_hosts SHA256前后一致，isolated_restored=true。 |

## 最终验证

- SSH模块修正后9项全部通过，见 `ssh-final.log`。
- G04完整隔离变异链已执行，见 `g04-result.json`。共享源码未注入Trust，没有取消或放宽安全断言。

Cargo统一由主线程安排顺序，避免并行争用。主线程负责desktop集成编译、IPC注册/TS对齐及最终共享回执。

## 源码结论和未验收边界

- BUG-001/003–005：`serial_open` 已拒绝生产 `use_mock=true`；`SerialService.open` 原生打开错误直接返回，失败不插入会话；native持有worker并在close等待释放，区分空闲/缓冲尾部/驱动错误，不把故障伪装为空数据。现有测试含不存在端口、禁止静默替换不支持的校验位/1.5停止位、队列故障与close等待。尚无真实串口或虚拟对硬件数据路径证据；不能以Mock吞吐测试作串口验收。
- BUG-009：本机Windows使用平台编码转换并做反向校验；UTF-8/ISO-8859-1可跨平台，其他编码在非Windows明确不支持。收端跨块、所有前端发送入口及HEX原字节由trae/CEO联调，不在本子任务声明通过。
- BUG-025：现有 `ssh/src/agent.rs` 使用本地Agent协议进行真实签名请求，Windows默认OpenSSH named pipe、Unix为SSH_AUTH_SOCK；连接层有认证期限。Windows测试使用一次性自建Agent服务、真实SSH回环及签名，成功/空身份/拒签/服务端拒绝/Agent缺失均通过；并非操作用户系统Agent，Unix未执行。
- G04：`host_key_security.rs` 真实回环SSH握手覆盖strict未知拒绝、accept_new首次信任、strict已知接受、两种策略对变更拒绝；已证明隔离无条件Trust被测试检出，恢复后通过。
- BUG-008未完成：当前 `connection_service.rs` 对X11配置明确返回Unsupported，SSH ConnectOptions/handler无X11请求与入站数据代理。历史task1也只声明持久化。没有执行REA、没有本地X Server实测，不能关闭该问题。
- BUG-010部分修复，仍未完成：mstsc进程启动或退出无法可靠对应认证/连接结果；当前只诚实提供launched、disconnected/failed/closed，不置connected、不新增使用成功记录。保存的密码自动注入已暂停，用户在mstsc原生提示中输入；既有凭据不被覆盖/删除。真实桌面成功、认证拒绝、关标签与多个mstsc实例归属未验收。

## 需CEO决策

1. RDP可靠事件来源：建议后续L3评估Windows RDP ActiveX（IMsRdpClient及OnLoginComplete/OnDisconnected/OnFatalError等事件、每launch独立控件和内存凭据）或FreeRDP受控客户端。需先证明真实成功/拒绝/断开信号、凭据生命周期、窗口归属，审批依赖与窗口托管范围；本轮不擅自增加该架构。现有mstsc进程状态不能替代。
2. X11：需明确Windows本地DISPLAY选择及Xauthority/MIT-MAGIC-COOKIE-1获取策略。最小完整实现仍须随机代理cookie、校验并替换入站X11授权、仅代理到明确本地显示、随SSH释放、关闭不请求；仅发送x11-req不足以交付。

## 交叉复核（只读）

已读新 `archive_service.rs`、`sync_codec::apply_archive_records`、`network_secrets.rs` 及归档/网络秘密测试。当前恢复对secret逐一用目标Vault重加密，实体/secret/proxy在同一SQLite事务提交，失败保留token。未确认新的实质泄漏/部分提交缺陷；已向主线程指出加密SOCKS规则的秘密引用重映射和目标Vault解析缺少直接回环断言，建议补在现有加密归档测试中。
