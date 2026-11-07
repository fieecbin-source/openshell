# Task 4 本轮续做（2026-11-06）

用户已批准旧库恢复入口、Windows RDP ActiveX、复用本机 X Server/Xauthority。修改仅限后端、共享契约、员工1反馈及自己的证据；未提交推送，保留既有脏工作区。

## 已实现

- 旧schema原库先解锁/初始化Vault，代理与SOCKS秘密/引用同事务迁移（含软删除规则），再创建安全快照与升级。密码错误或SQL触发器失败不丢原值，可重试。
- 同步pull应用和冲突副本同事务；push冲突重取最新快照；解决旧冲突检查local_rev；上传确认事务内比较sent，保留新编辑。自身上传回声也建立可解决副本，避免丢失确认后永久阻塞。私钥口令秘密加入依赖检查。
- 归档组路径按SQLite ASCII NOCASE复用，KeepBoth占名一致；已有私钥按指纹复用/恢复，重验证依赖版本，提交仍为原子事务。
- X11本机DISPLAY、Xauthority解析、随机替代cookie、两种字节序鉴权、真实cookie仅在本机替换、SSH入站转发及关闭取消。
- RDP系统PowerShell5.1托管ActiveX，仅LoginComplete表示认证成功，stdin内存凭据，真实错误/断开事件；终态关闭窗口，应用Exit回收自有实例及临时文件。

## 实际验证与界限

所有Cargo命令前缀为 `C:/Users/fiee1/.cargo/bin/cargo.exe +stable-x86_64-pc-windows-msvc`，均使用 `--locked --offline --jobs 2`，顺序运行。下列退出码为当前exec工具实际报告（失败报告1）。

1. `test -p openshell-app-core --lib --test archive_roundtrip_test --test network_recovery_test --test network_secrets_test --test sync_atomicity_test --test sync_lifecycle_test --no-fail-fast`：第一次本轮修复后48项通过、退出0。补NOCASE和两处竞态回归后：归档10、恢复2、落盘扫描1、竞态5、生命周期5均通过；单元26/27，旧clean快照fixture与新保护不一致导致整体退出1。已把fixture改成真实的上传后再编辑场景，并补上传确认新编辑回归；最后复跑 `--lib --test sync_atomicity_test` 记录在 `final-sync.log`。
2. 补充行为红：旧NOCASE归档撞 `idx_group_parent_name`；push期间新编辑快照仍是旧值；pull无预识别副本覆盖dirty。三者实际失败（退出1），修复后对应测试均绿。此前SQL回滚、旧冲突覆盖新编辑及口令依赖三项亦先红后绿。
3. `test -p openshell-ssh`：早先12项通过。新增真实SSH X11握手测试第一次出现ping未送达就close的fixture竞争，10/11单元通过、退出1；已用oneshot等待本机实际收到ping再关闭，尚未重新运行此新增测试。原两种字节序真实TCP往返及错误cookie拒绝测试通过。
4. `test -p openshell-desktop`：第一次26/27，实际ActiveX初始化错误（不存在PromptForCredentials属性），退出1。移除该属性后，独立隐藏控件SelfCheck及真实拒绝连接返回516并自动退出，退出0。全模块最新27/28：应用Exit自有实例回收测试通过，ActiveX自动退出测试在25秒启动等待+5秒退出等待内没有观察到结束，整体退出1。已把CodeDOM/COM启动总等待调整为60秒并补失败状态诊断；此最后调整未复跑，不能将它算通过。
5. `node --test scripts/check-package.test.mjs`：4/4、退出0；`pnpm --dir frontend exec vitest run src/lib/ipc.test.ts`：4/4；独立共享TS `tsc --noEmit`：退出0。
6. 定向rustfmt成功、backend `git diff --check` 未输出差异错误；最新RDP测试等待调整发生在其后，最终全量fmt未运行。
7. G04复用已完成隔离变异证据：baseline0→无条件Trust101→恢复0；本轮重新读取当前known_hosts.rs SHA256为 `402B6A6F62636BBFB8993F549F384827D5027EE04124A9234F2F91FF6F5D5EC2`，与既有g04-result.json一致。没有重写旧audit或做共享安全注入。

用户要求10分钟收尾，最后测试状态按实记录，不宣称全部通过。没有重新跑所有模块或workspace；真实外部SSH/SFTP、串口硬件、RDP/NLA成功登录、真实X Server图形应用、生产Tauri UI、安装升级及其他OS未验收。历史明文页/WAL/旧备份未删除，也不声称已清除。

收尾前最终同步命令已完成：`test -p openshell-app-core --lib --test sync_atomicity_test` **退出0，27单元+6竞态回归，共33项通过**；实际完整输出已保存 `final-sync.log`。最后仍未确认的仅为调整后的RDP自动退出和新增真实SSH X11握手fixture复跑。

## 最终续做交付（2026-11-06，覆盖上文未复跑结论）

当前分支/HEAD仍为 `Fce/terminal-workspace-ux` / `1f746c27b3b189072719f49d6284f1452187633d`。本次接手基线见 `remaining-baseline.json`；保留已有大量未提交改动，不提交、推送、reset、stash或修改前端业务组件，未新建venv或复制构建环境。

### 已查明并修正

- RDP：接手的60秒版本完整复跑仍失败（`remaining-desktop.log`，退出101）。诊断显示应区分真实OnConnecting的starting状态与默认状态，不能据此称无事件。最小命令对照发现 `-WindowStyle Hidden` 与 `CREATE_NO_WINDOW` 组合阻塞；移除前者并保留隐藏进程/STA，首读stdin前设置UTF-8。修正OnLogonError事件分类：0为密码错误，-2/3为进度/提示。依据：[Microsoft官方事件定义](https://learn.microsoft.com/en-us/windows/win32/termserv/imstscaxevents-onlogonerror)。新Unicode回环与C# SelfCheck覆盖这些边界。
- RDP测试：25秒快照在真实失败前就保存starting，随后在自动退出/reader.join后仍用旧快照断言。独立时间线 `reviewer-rdp-timeline.json` 观察真实failed/516在29.185或32.578秒，随后不到一秒自行退出。保留接手时已有60秒终态上限及终态后5秒自行退出断言，join后读取最终状态；未删除真实错误码、未认证、自动退出或文件清理断言。30秒总窗的失败原样保留在 `remaining-desktop-final.log`、`remaining-desktop-verified.log`，不冒充通过。长命令行/短bootstrap对照均能正常执行，stdin传SOURCE试改已撤回，不把长源码认定根因。
- X11：保留oneshot等待本机收到ping后关闭SSH，新增真实SSH握手回归通过；仍覆盖替代cookie、真实cookie只在本机替换、双向数据、断线EOF、错误cookie与远程DISPLAY拒绝。
- 同步：新增真实服务层“服务器已提交、触发器拒绝本地确认→同设备回声→解决→B收到”回归。最终复审另发现冲突后本地再编辑/收到新远端会被旧基线保护永久阻塞；新增服务测试先红（`remaining-conflict-refresh-red.log`，退出101），修正为sync_now保留旧行并建立当前可解决副本，事务内重采dirty本地编辑，clean时沿用原本地快照；两种场景与原六项竞态保护均通过。

### 最终运行证据

以下均从仓库根按单个Cargo进程顺序执行，前缀为 `C:/Users/fiee1/.cargo/bin/cargo.exe +stable-x86_64-pc-windows-msvc`，无workspace全量：

| 命令 | 实际退出码 / 结果 | 完整日志 |
|---|---|---|
| `test -p openshell-desktop --locked --offline --jobs 2` | **0，29/29**；真实ActiveX拒绝连接、最终失败状态/未认证、自行退出及自有实例回收通过 | `remaining-desktop-complete.log` |
| `test -p openshell-ssh --locked --offline --jobs 2` | **0，11单元+1主机密钥集成+1转发集成，共13项** | `remaining-ssh-final.log` |
| `test -p openshell-app-core --lib --test archive_roundtrip_test --test network_recovery_test --test network_secrets_test --test sync_atomicity_test --test sync_lifecycle_test --no-fail-fast --locked --offline --jobs 2` | **0，27+10+2+1+6+7，共53项** | `remaining-app-core-final.log` |
| `check -p openshell-desktop -p openshell-ssh -p openshell-app-core --locked --offline --jobs 2` | **0** | `remaining-check.log` |
| `rustfmt +stable-x86_64-pc-windows-msvc --edition 2021 --config skip_children=true --check`，仅rdp_host.rs、x11.rs、sync_service.rs、sync_codec.rs、sync_lifecycle_test.rs | **0** | `remaining-fmt.log` |
| 定向diff检查、反馈保存与其他员工字节校验 | **0**；员工1过时待复跑结论已替换，员工2/3/CEO内容不变 | `remaining-delivery-check.log` |

最终三组回归共95项通过，不重复计入此前 `final-sync.log` 的33项。包扫描4项、共享IPC4项和独立共享TS沿用前轮通过证据，本次未修改相关实现，未重新运行。G04复用原隔离变异0→101→0证据，当前known_hosts.rs SHA256仍为 `402B6A6F62636BBFB8993F549F384827D5027EE04124A9234F2F91FF6F5D5EC2`。

最终定向只读复审见 `remaining-review.md`：三个Important已修，无未解决Critical/Important；未进行全仓审计。交付 `multi-agent/task4/Task 4 Feedback.md` 仅员工1小节已更新并重读，逐BUG/G列出实现、对应命令/退出码、证据及边界。

真实外部SSH/SFTP、串口硬件、RDP/NLA成功登录、真实X Server图形应用、生产Tauri UI、安装升级及其他OS仍未验收；历史明文页/WAL/旧备份未删除，不能声称已清除。95项自动化通过不是整机上线结论。
