# Task 4 · gpt 内部子任务：SFTP / Forward 交付证据

状态：本子任务实现及模块定向验证完成；共享 IPC/桌面联调由 root 汇总。未提交、推送、运行全量工作区检查。

## 本轮增量与已有代码

本轮开始时相关模块和回归测试已有未提交改动。原始状态记录在 `baseline.diff`、`baseline-transfer_tests.rs`、`baseline-lifecycle.rs`、`baseline-hashes.txt`；不把此前实现算成本轮新增。最终负责文件指纹见 `final-hashes.txt`。

- `backend/crates/sftp/src/transfer.rs`：保留已有从零截断覆盖、旧 resume=true 安全重传和同任务 resume 实现；修复 Cancelled 终态仍允许再次 cancel 的边界。未加传输限速或改变固定缓冲大小。
- `backend/crates/sftp/src/transfer_tests.rs`：补双向同 ID 暂停恢复、暂停取消等待退出及终态操作断言；覆盖目标等长/较短/较长/空源，上传/下载与 resume=true/false 共16组合；校验长度、SHA256 和完整字节。
- `backend/crates/sftp/Cargo.toml` 与根 `Cargo.lock`：仅为验收摘要复用已存在 workspace sha2 测试依赖；锁文件本组增量仅 openshell-sftp 依赖列表的 `sha2 0.10.9`，无新库安装。
- `backend/crates/forward/src/manager.rs`：本地/动态监听订阅所属 SSH 关闭信号；JoinSet 托管、回收已接受连接和等待握手的子任务，结束时统一取消；停止等待父任务释放资源。stop_rule 改为内部 DomainResult，远端拒绝取消时返回错误、保留 Error 状态和原实例以供重试；请求期间不持有全局 map 锁，结果应用前核对任务实例。已断开的 SSH 可以清理残留状态，重启先传播停止旧实例失败。
- `backend/crates/forward/src/socks5.rs`：保留已有“解析只返回目标、建连后才由 manager 回复成功”修复；修正两个仍期待解析阶段 SUCCESS/EOF 的旧测试。新增并修复有损 UTF-8 转换可能将错误认证字节误匹配的问题，用户名/密码改为原始字节与 expected.as_bytes() 比较。
- `backend/crates/forward/tests/lifecycle.rs`：真实回环 SSH + SOCKS/TCP 集成；主动/被动断开三类监听、其他连接不受影响、等待握手子连接关闭、远端取消成功、首次取消被拒后重试成功、目标拒绝与成功字节往返。

root 负责的调用者集成：desktop commands 的 `forward_delete` 与 `forward_stop` 两处 `state.forward.stop_rule(&pf_id).await` 必须传播 `?`，防止删除可重试规则或报告假成功。root 已确认修改；本子任务不修改 commands，不把真实桌面 IPC 算作已验证。

## 命令与退出码

以下命令均在仓库根目录运行，Cargo 前缀为 `cargo.exe +stable-x86_64-pc-windows-msvc`（Cargo 位于本机安装目录）。只按协调的独占窗口构建，参数始终 `--locked --offline --jobs 2`。

| 命令（Cargo前缀后） | 退出码 / 结果 | 日志 |
|---|---|---|
| `test -p openshell-forward --test lifecycle --locked --offline --jobs 2` | 101；1通过2失败，真实复现监听及脱离所有权的子连接泄漏 | forward-red.log |
| `test -p openshell-sftp --locked --offline --jobs 2` | 101；8通过1失败，Cancelled终态可再次取消 | sftp-red.log |
| `test -p openshell-forward --locked --offline --jobs 2` | 101；7通过2失败，两个旧解析器断言与锁定契约不符 | forward-green-attempt.log |
| `test -p openshell-forward --locked --offline --jobs 2` | 0；当时9单元+3回环集成通过 | forward-green.log |
| `test -p openshell-forward --lib test_socks5_userpass_rejects_missing_or_wrong_credentials --locked --offline --jobs 2` | 101；错误字节FF对U+FFFD密码返回[1,0]，预期[1,1] | socks-byte-auth-red.log |
| `test -p openshell-forward --locked --offline --jobs 2` | 101；9单元+4/5集成通过，新增被动断开测试串行端口检查耗时失败 | forward-final.log |
| `test -p openshell-forward --locked --offline --jobs 2` | 0；并行探测后9单元+5集成通过 | forward-final-green.log |
| `test -p openshell-forward --test lifecycle rejected_remote_cancellation --locked --offline --jobs 2` | 101；首次为新增测试Server的Drop/struct更新语法编译错误，不计作行为复现 | remote-cancel-red.log |
| `test -p openshell-forward --test lifecycle rejected_remote_cancellation --locked --offline --jobs 2` | 101；真实服务端拒绝后错误显示Stopped | remote-cancel-behavior-red.log |
| `test -p openshell-forward --locked --offline --jobs 2` | **0；最终9单元+6真实回环集成通过，0失败** | forward-complete-green.log |
| `test -p openshell-sftp --locked --offline --jobs 2` | **0；最终9项通过，0失败** | sftp-final.log |

被动断开测试诊断：独立新建后关闭的隔离回环端口 `connect_ex` 返回 WSA10061 用时2.063秒（退出0）。原4秒窗口内串行检查3端口至少约6秒；改为 tokio::join! 同时探测，保持原3/4秒期限及所有端口/状态断言，未放宽超时。最终6集成用时2.10秒。

最终 `rustup run stable-x86_64-pc-windows-msvc rustfmt --edition 2021 --check` 仅检查 transfer.rs、transfer_tests.rs、manager.rs、socks5.rs、lifecycle.rs：退出0，见 `format-final-check.log`。`git diff --check -- backend/crates/forward backend/crates/sftp`：退出0，见 `diff-final-check.log`。

## 验证范围与边界

- BUG-002：真实 SFTP 协议流经回环 TCP 和隔离磁盘文件验证16组合，长度/SHA256/字节均一致。不是 SSH 认证或桌面 IPC 验收。
- BUG-006/007：终态拒绝操作、同ID恢复、暂停中取消不被结束处理改成Completed；前端状态入口由其负责人验收。
- BUG-011/012：本子任务只处理运行时明文输入与ref分离后的转发消费/正确鉴权，不负责Vault/DB迁移；错误和缺失口令、畸形字节均被拒绝，错误信息不包含合成口令。
- BUG-013：解析器不回复CONNECT成功；真实SSH目标通道拒绝时SOCKS REP非零，成功目标ping字节真实往返。
- BUG-014：主动/被动关闭均验证local/dynamic/remote端口和状态，A关闭不影响B，停止取消等待握手子连接；远端拒绝取消返回失败保留实例，第二次取消成功释放。
- G02：仅上述负责Rust文件格式检查通过，完整fmt及全仓门禁留CEO。

没有连接用户真实主机、修改真实凭据/配置、运行GUI/桌面跨端验收、安装驱动或依赖、跑全仓测试/构建、性能基准或跨系统验证。SSH服务测试使用合成密钥及仅测试连接的 Insecure 主机密钥策略，生产主机密钥策略未变。没有在本子任务运行 FinalShell、javap 或 REA。

root 另行请求的归档只读审查见 `archive-review.md`（记录审查当时发现，root正在/已处理；不属于本组源码改动）。
