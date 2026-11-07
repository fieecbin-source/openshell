# Task6 S08 forward 生命周期证据

范围：仅 `backend/crates/forward/tests/lifecycle.rs` 中 server_disconnect 用例；生产 forward/ssh 未修改，其他监听隔离、远端 relay EOF 用例保留。

## 原始行为

- 原始单用例：`cargo +stable-x86_64-pc-windows-msvc test -p openshell-forward --test lifecycle server_disconnect_releases_all_rule_types_and_pending_handshakes --locked --offline --jobs 2 -- --nocapture`，exit 0，1通过，运行2.09s，`forward-original-single.log`。
- 原始完整forward目标：`cargo +stable-x86_64-pc-windows-msvc test -p openshell-forward --locked --offline --jobs 2 -- --nocapture`，exit 0，9单测+7生命周期通过，生命周期2.12s，`forward-original-full.log`。
- 未原样动态复现Task5失败；旧失败仍以 `audit/ceo-task5-workspace-tests.log` 为准，不将原失败改写为通过。

## 可重复时序复现

`python audit/remediation-task6/gpt/forward-refusal-probe.py`，exit 0（断言成功复现旧探针假超时，不是产品旧用例exit 0/1证据）。合成3个回环监听，第一个先关闭、其余约20ms后关闭。旧版并行connect取得不同时刻混合状态，其中已关闭端口的拒绝耗时约2秒；即使全部监听已释放，第二轮也可能被4秒deadline截断。

`forward-refusal-probe.log` 实际记录：全部监听0.025s释放；重新bind在0.040s观察到释放；旧采样2.062s仍含先前连接成功状态 `[False, True, False]`，随后4秒超时。探针同时断言真实端口全部可重新bind。

最初探针的streams清理遇到WinError10054，已换成直接socket connect/finally close，避免无关流读处理影响测量。首次Cargo调用因默认PATH无cargo未实际启动；后续命令仅在子进程 PATH 添加本机 Cargo 安装目录，未改系统环境。

## 最小修复

保留4秒释放阈值，先等待现有SSH closed watch信号，再以三条规则状态非Listening且所有监听地址均可重新bind确认释放。真实三端口connect拒绝断言在释放确认之后并行执行；保留pending SOCKS握手EOF/错误断言、后续stop cleanup与15秒外层上限。没有增加超时、skip、allow或改变IPC/生产接口。

格式：单文件rustfmt --check exit0，git diff --check exit0。后续绿测结果另补。

补充源码确认：本机 Cargo registry mio-1.2.4/src/net/tcp/listener.rs:78–84 明确 Windows 不设置 SO_REUSEADDR，避免活跃socket被重新bind。因此该平台重新bind不是允许地址共享的伪释放证据。

## 修改后新鲜验证

以下均以 `+stable-x86_64-pc-windows-msvc --locked --offline --jobs 2` 运行，不用 `--test-threads=1`，不增加超时；每条命令及退出码也见 `forward-verification.json`。

| 命令 | exit | 结果 | 证据 |
|---|---|---|---|
| `cargo test -p openshell-forward --test lifecycle server_disconnect_releases_all_rule_types_and_pending_handshakes -- --nocapture` | 0 | 1通过，运行2.10s | forward-green-single.log |
| `cargo test -p openshell-forward -- --nocapture` | 0 | 9单测+7生命周期=16通过，0失败/ignored | forward-green-full.log |
| `cargo test -p openshell-forward -p openshell-ssh -- --nocapture` | 0 | 29通过，0失败/ignored；forward lifecycle正常并行2.24s | forward-green-ssh-parallel.log |
| `cargo clippy -p openshell-forward -p openshell-ssh --all-targets -- -D warnings` | 0 | 两crate及其全目标通过，57.37s | forward-clippy.log |

全部既有其他连接隔离、远端取消拒绝/重试、远端既有relay EOF、SOCKS成功/失败与SSH真实回环/主机密钥断言保持通过。没有删除或跳过测试。

可独立提交组：`backend/crates/forward/tests/lifecycle.rs`；不依赖S01/S02新增hunk，不改forward/ssh生产源码。相对9b05523为24行新增、19行删除，含仅该用例末尾for循环rustfmt整理。

未验证：未运行workspace全量（由CEO集中验收），未测试跨OS/外部SSH服务器/真实网络断链。原Task5失败未原样动态复现，已证实该探针在Windows混合采样时的假超时机制；不把本轮定向通过当workspace整体通过。
