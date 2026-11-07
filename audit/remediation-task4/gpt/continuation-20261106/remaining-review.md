# Task 4 员工1剩余修复：最终定向只读复审

范围：RDP 宿主/自有进程回收、X11 SSH 请求与鉴权转发、同步竞态及冲突刷新。基线 HEAD 为 `1f746c27b3b189072719f49d6284f1452187633d`；共享脏工作区中没有把全部差异视为本轮新增。仅写入本复审证据文件，没有修改业务代码或运行 Cargo。

## 结论

- Critical：未发现未解决项。
- Important：此前发现的三项在最终代码中已修正；本次最终增量复审未发现新的实质阻断问题。
- Minor：无。
- 代码复审通过不代表最终运行门禁已通过。完整 desktop 测试和后续定向 check 正由主代理执行，本结论不预认其结果。

## 已复审的修正

1. 同步冲突产生后本地再编辑、或收到更新远端版本：现在可建立可解决的新副本；dirty 数据在同一 SQLite 事务内重新采样，clean 数据沿用已保留的本地冲突快照，旧副本仍保留。新副本绑定当前 local_rev，原有防止旧快照覆盖新编辑的保护仍在。检查了新增 `changed_conflicts_refresh_without_losing_the_original_local_snapshot` 和丢失上传确认后的自身回声服务层回归。
2. RDP 生产启动保留 `CREATE_NO_WINDOW` 与 STA，移除了本机实测会阻塞最小命令的 `-WindowStyle Hidden` 组合；首次访问 `Console.In` 前明确设置 UTF-8。非 ASCII 凭据输入有回环回归。完整 C# SOURCE 仍通过原命令行传递，stdin 传 SOURCE 的试改已撤回。
3. `OnLogonError` 不再把 0 当成功，也不再把正常继续登录/提示通知一律当失败；SelfCheck 覆盖 0、-2、3。依据：[Microsoft OnLogonError 定义](https://learn.microsoft.com/en-us/windows/win32/termserv/imstscaxevents-onlogonerror)。成功仍只由 LoginComplete 驱动，退出本身不表示认证成功。

## RDP 等待边界的实际证据

`reviewer-rdp-timeline.json` 的有界真实 ActiveX 诊断记录：

- 完整命令行：4.466 秒 launched，9.172 秒 starting，29.185 秒真实 failed/516，29.752 秒自行退出，exit 0。
- stdin SOURCE 对照：32.578 秒真实 failed/516，32.894 秒自行退出，exit 0。此方案没有证明必要性或性能收益。

因此，starting 可能是已收到 OnConnecting 后的当前状态，并不等于没有事件；第 25 秒保存的快照不能代表最终状态。`remaining-desktop-verified.log` 仍明确记录旧 30 秒总窗运行的 28/29 失败，没有将该失败算作通过。

最终测试恢复接手时已有的 60 秒终态等待，并保留终态后的 5 秒自动退出断言，最后在 reader.join 后读取 fresh final_status。此改动合理地区分机器启动/连接失败耗时与失败事件后的回收：仍须观察真实正数失败码、未认证、自动退出及临时文件清理，无法靠强制关闭获得通过。它不证明宿主必在 25/30 秒内完成，也没有改变生产连接参数。最终完整测试结果必须另以主代理实际日志为准。

## 未判断的行为

真实外部 SSH/SFTP、串口硬件、RDP/NLA 成功登录、真实 X Server 图形应用、生产 Tauri UI、安装升级及其他操作系统缺少本轮真实环境验收，未作通过判断。此次没有扩大到全仓审计；既有数据页/WAL/历史备份的秘密清理也不在本次结论中。
