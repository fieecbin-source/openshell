# Task 4 · gpt · BUG-019 监控子任务

日期：2026-11-06。工作目录：仓库根目录（绝对路径已省略）。状态：后端定向回归通过；真实 SSH / 桌面 IPC / 前端展示未验收。本子任务后续仅承担监控，AI 与 G03 由 root 接手；没有修改 AI 或包扫描文件。

## 原始状态与范围

- 原始 `parser.rs` 与 `engine.rs` 分别保留在 `parser-before.rs`、`engine-before.rs`。已有 `parse_sample` 占位函数和既有测试未当作本轮已验证成果。
- 根因：生产引擎直接调用容错解析器 `parse_host_metrics`，忽略 exec 的退出码；空/缺失/坏数值被转为零并更新采样时间。真正 exec 错误只写日志，最新查询继续返回旧历史快照。
- 本轮改动：`backend/crates/monitor/src/parser.rs`、`engine.rs`；`backend/desktop/src/commands.rs` 仅 `monitor_get_latest` 函数；`backend/crates/core-domain/src/entities.rs` 仅 HostMetrics 字段；`frontend/src/types/ipc.ts` 仅同一字段。
- 未改前端业务组件/store、历史 audit、其他员工回执；未提交、推送、安装服务或读取用户主机配置。

## 实现

1. `parse_sample` 要求 exit_code 为 Some(0)，要求 STAT/MEM/NET/DF/LOAD/PS/UPTIME 七段有效。数字解析失败、NaN、缺失必需字段、非法内存值和计数溢出均在更新 PrevSampleState 前返回结构化 DomainError。正常零负载和零使用量保持为零。
2. 引擎生产采样使用 `parse_sample`；最新结果保存成功/失败状态。尚无采样、停止后返回 None；最近失败返回 Err；失败不写入历史，也不广播假快照。后续成功恢复结果并清除失败状态。IPC 原签名保持，转发该 Result。
3. HostMetrics 新增 `unavailable_fields`（Rust Vec，serde default，空时省略；TypeScript optional string[]）。首帧未测得差分标记 cpu_percent/cpu_cores/net_rx_bps/net_tx_bps；没有逐核数据、缺缓存计数或 ps 降级输出不含百分比时，分别标记 cpu_cores、memory_cached_bytes、top_processes。使用已有 HostMetrics 键名。
4. `stop_monitoring` abort 后等待任务真正退出，再清空最新状态；防止停止/重启间旧任务继续写入。发布事件期间持有最新状态写锁，订阅方不会在事件后读到上一份最新结果。

## 命令与结果

所有 Cargo 命令统一使用 `cargo.exe +stable-x86_64-pc-windows-msvc`（Cargo 位于本机安装目录），只运行本模块，编译资源与 root / transfer_forward 顺序协调。

| 阶段 | 命令（工具路径见上） | 退出码 | 结果与证据 |
|---|---|---:|---|
| 解析红测试 | `test -p openshell-monitor --locked --offline --jobs 2` | 101 | 7 通过、2 失败：invalid_sample_never_advances_timestamp 和 malformed_numbers_do_not_replace_the_previous_sample；`monitor-red.log` |
| 停止竞争红测试 | `test -p openshell-monitor stop_waits_for_the_old_sampler_to_release --locked --offline --jobs 2` | 101 | 1 失败、11 过滤，明确断言 stop 返回时旧 sampler 仍存活；`monitor-stop-red.log` |
| 修复后模块绿测试（root 代跑，子任务已读回完整结果） | `test -p openshell-monitor --locked --offline --jobs 2` | 0 | 12 通过、0 失败；doc tests 0；`monitor-green.log` |
| 限定格式检查 | `rustfmt +stable-x86_64-pc-windows-msvc --edition 2021 --check backend/crates/monitor/src/parser.rs backend/crates/monitor/src/engine.rs` | 0 | `monitor-fmt.log`（无差异输出） |
| 限定差异检查 | `git diff --check -- backend/crates/monitor/src/parser.rs backend/crates/monitor/src/engine.rs` | 0 | 无空白错误输出 |

原有 8 个测试保留；新增坏数值拒绝、首帧未测量标记、引擎失败/恢复/历史、停止等待释放共 4 个测试。坏数值用例覆盖 CPU、内存、网络、磁盘、负载、进程百分比和 uptime。引擎状态测试覆盖首次失败、成功后失败、失败不产生事件、不改历史时间、恢复成功事件及停止后无最新采样。

## 验证边界与风险

- ✅ BUG-019 后端解析和引擎状态逻辑由合成 Linux 输出测试验证；合法零与无效采样已区分，停止竞争有红绿证据。
- ❌ 未使用真实 SSH 服务器复现 exec 非零、设备/连接断开或恢复；本次引擎测试直接提交合成采样结果，不能替代网络验收。
- ❌ 未启动桌面执行真实 monitor_get_latest IPC；本子任务仅改其调用，桌面定向检查由 root 集成。
- ❌ 未修改/验收 trae 的前端对 unavailable_fields 的消费。未接入前不能宣称缺失字段展示完成；整项关闭交 CEO。
- ❌ 非 Linux / 缺 /proc 环境、BusyBox 实机和不同 df/ps 区域格式未验收。生产采样现在严格要求 Linux 七段数据；不支持的输出明确失败，不再伪装有效零。
- ❌ 未执行工作区全量测试、全仓构建、完整 clippy 或全量 fmt；这些留 CEO 收尾。

未新增依赖或修改 Cargo 配置。没有以 Mock、启动成功或吞错充当真实环境通过。
