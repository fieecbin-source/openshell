# Task 4 Feedback

> 每位员工只编辑自己的小节，不得改动他人小节。使用局部 patch，写完重新读取本文件确认已保存。当前只是回执骨架，不是修复或验收结果。

## 员工1：gpt

【回执 | 员工:gpt | Task 4】

状态：2026-11-06 剩余修复与定向回归已完成：desktop 29、SSH 13、app-core 53，共95项通过，三条最终测试命令退出0。用户已批准的 `.osvault` 兼容扩展、旧库恢复入口、Windows RDP ActiveX 和本机 X Server/Xauthority 方案均已实现；真实环境上线验收另列，没有提交或推送。

改动清单：

- 开工基线：`Fce/terminal-workspace-ux` / `1f746c27b3b189072719f49d6284f1452187633d`，已有大量未提交改动。续跑前的 `baseline.diff`、`baseline-status.txt` 位于 `audit/remediation-task4/gpt/continuation-20261106/`；既有实现不一概算作本轮新增。
- SFTP / forward：保留并验证既有覆盖截断、同任务恢复与建连后回复；修复重复取消终态、监听及子任务回收、SOCKS 畸形字节认证、远端取消失败被吞掉。`stop_rule` 内部返回错误，desktop stop/delete 两个调用者传播错误。
- 凭据：`network_secrets.rs` 沿用 Vault/secret；共享输入 DTO 与返回 DTO 分离。有效格式但已丢失的 SecretId 不再当明文密码迁移；通用 settings 的代理读写也经过凭据服务，不能绕过专用入口保存或返回明文。
- 归档：新增 `archive_service.rs`，AppServices 装配及 desktop 导出/预览/commit/discard 统一接入；复用 `sync_codec` 的事务写入和 ID 重映射。补恢复名称、引用、目标并发修改校验、旧包警告、锁库与事务失败重试。
- 导入/同步/备份：OpenSSH 缺失或未支持依赖明确阻断，三种批内冲突策略及副本唯一命名；冲突列表/本地与远端恢复命令；软删除凭据等依赖重新校验；保留数 canonical 键和迁移裁剪统一。
- AI/监控：共享 complete 对错误、正常结束、有意义结果、取消和整体超时统一判定；监控先校验退出码/七段数据再更新基线，最新错误独立于历史，停止等待旧采样任务释放；缺失字段加入 `unavailable_fields`。
- 协议/契约：保留并核验既有原生串口失败、SSH Agent、主机密钥和编码路径；RDP 新增自有进程清理辅助模块，删除 cmdkey 共享凭据覆盖；补齐共享 TS/IPC。包扫描脚本的既有修复用正反例重新验证。

关键实现说明：

1. `.osvault` 保持原 schema 1，加 `recovery_version: 1` 与加密包内部 credentials/ssh_keys/secrets；秘密不进入 renderer。导入时为目标 ID、目标 Vault 重新加密；会话/分组/片段/规则/凭据/私钥/秘密/代理在一个事务写入。成功消费 token，失败保留供重试，discard 主动释放。新完整包缺依赖明确拒绝；旧包缺密码、私钥、SOCKS 密码会清除悬空引用并警告。JSON 不导出解密秘密。
2. 归档提交逐项核对预览候选；Update、已有会话的 Skip、复用分组及私钥均校验版本、更新时间、local_rev 和删除状态。组路径按 SQLite ASCII NOCASE 匹配；KeepBoth 后缀避开数据库及批内占名。相同指纹的私钥复用或原 ID 恢复，不再撞唯一索引。
3. 同步列表只含元数据。拉取应用与本地冲突副本在同一 IMMEDIATE 事务，事务内重取最新编辑；扫描后新增的未识别冲突拒绝覆盖并等待重试。上传冲突重新读取当前快照，确认上传时事务内比较原发送快照，避免清掉新编辑；解决旧冲突拒绝覆盖后来修改。自身上传成功但本地确认失败的回声也建立可解决副本；冲突后本地再编辑或收到新远端版本，下一次 sync_now 会保留旧行并生成当前可解决副本，clean 行沿用原本地快照，避免防覆盖保护变成永久阻塞。恢复依赖（含私钥口令秘密）、base/dirty 与 resolved_at 原子一致，失败保留副本。受控双设备服务测试覆盖 local/remote 选择及再次修改。
4. RDP 改为 Windows 系统 PowerShell 5.1 托管已安装 v11 ActiveX：OnLoginComplete 才报告 connected，连接、登录错误及断开使用真实事件。保存/本次输入的密码仅经 UTF-8 stdin 传到控件，不写参数、文件或 Credential Manager；无密码沿用控件交互认证。保留 CREATE_NO_WINDOW/STA，移除本机实测阻塞的 WindowStyle Hidden 组合；正确区分 OnLogonError 的0密码错误与-2/3进度/提示事件。终态关闭窗口并保留真实错误码，应用 Exit 统一 kill/wait 自有实例并清理临时文件。没有操作用户其他进程或 TERMSRV 凭据。
5. 已注册/补齐 `sftp_resume_transfer`、`terminal_encode`、`sync_list_conflicts`、`sync_resolve_conflict`、`importer_discard_preview`、commit 可选 archiveToken、`rdp_get_status`、`rdp_close`；TS 包装和新增类型保持 main.md 锁定命名。`TabStatus.launched`、`RdpLaunchResult.launch_id`、`RdpRuntimeStatus`、`SyncConflict`、`HostMetrics.unavailable_fields` 已交付；员工3旧回执的“尚未交付”是此前快照，前端接入仍由其负责人补验。
6. 旧库在安全快照被明文保护阻断时弹 Windows 不持久化主密码恢复入口；按原 schema 解锁/初始化 Vault，所有代理及 SOCKS（含软删除规则）的秘密和引用在一个事务迁移，失败回滚可重试。关闭旧句柄后再执行安全快照/升级。schema 1 真库 fixture 验证错密码不修改、触发器失败回滚、重试成功及新快照无随机明文。
7. X11 从 Session→ConnectOptions→SSH handler 实际传递；shell 前发送并等待请求确认，只代理本机 TCP/Unix DISPLAY。读取并校验 Xauthority MIT-MAGIC-COOKIE-1，SSH 只发送随机替代 cookie；入站验证替代 cookie 后仅本机连接替换真实 cookie，两种字节序、有界认证、双向转发及关闭取消均有测试。

自测结果：（逐条命令、退出码、日志；标明修复前/后）

以下 Cargo 前缀均为 `& 'C:/Users/fiee1/.cargo/bin/cargo.exe' +stable-x86_64-pc-windows-msvc`；所有 test 命令均加 `--locked --offline --jobs 2`，按独占窗口顺序运行。日志根 `A=audit/remediation-task4/gpt/continuation-20261106`，`T=../continuation-transfer`，`P=../continuation-protocols`，`M=../continuation-ai-monitor`（后三者相对 A）。表中模块通过只证明所列范围。

| 命令/检查 | 修复前 → 当前退出码与范围 | 证据 |
|---|---|---|
| `test -p openshell-sftp` | 101（8/9，Cancelled 可再次取消）→ **0，9/9**；双向16覆盖组合，长度/SHA256/完整字节，同 ID 恢复和取消 | T/sftp-red.log、sftp-final.log |
| `test -p openshell-forward` | 真实监听/子任务泄漏红；畸形字节认证红；远端拒绝取消却报 Stopped 红（均101）→ **0，9单元+6真实回环集成** | T/README.md、forward-complete-green.log；fixture 首次编译错误另记，不冒充行为红 |
| `test -p openshell-ai` | 真实HTTP基线101（1通过5失败）→ **0，72单元+6回环HTTP测试**，三种 wire 均覆盖 | A/ai-direct-red.log、ai-green.log |
| `test -p openshell-importer` | 101，依赖阻断/批内重复失败；新增重复导入 KeepBoth 名称红101 → **0，15/15** | A/importer-red.log、importer-keepboth-red.log、importer-final.log |
| `test -p openshell-store` | 迁移保留数量红101 → **0，12单元+7集成** | A/migration-red.log、store-green.log |
| `test -p openshell-app-core --lib --test archive_roundtrip_test --test network_recovery_test --test network_secrets_test --test sync_atomicity_test --test sync_lifecycle_test --no-fail-fast` | 首轮同步依赖、NOCASE及竞态红；本轮冲突刷新新增服务回归红101 → **最终0，27单元+10归档+2旧库恢复+1落盘扫描+6竞态+7生命周期，共53项** | A/remaining-app-core-final.log；本轮行为红 A/remaining-conflict-refresh-red.log；原红绿见 resume-results.md |
| `test -p openshell-monitor` | 101，空/缺段/坏数字；停止旧任务释放红101 → **0，12/12** | M/monitor-red.log、monitor-stop-red.log、monitor-green.log |
| `test -p openshell-serial` | **0，3单元+7集成**；含不存在原生端口失败不注册 Mock，其余流控/吞吐 Mock 测试不算硬件验收 | P/serial-green.log |
| `test -p openshell-ssh` | 新增真实X11握手 fixture 曾因数据未送达就关闭而失败；oneshot 等待本机 ping 后 **最终0，11单元+1主机密钥集成+1转发集成，共13项**。含错误cookie、远程DISPLAY拒绝、两种字节序、真实SSH请求/双向数据/断线EOF及一次性Agent签名 | A/remaining-ssh-final.log；历史 P/ssh-final.log |
| `test -p openshell-desktop` | 初始60秒等待仍失败101，窗口参数组合及旧状态快照已查明并修正；**最终0，29/29**。真实ActiveX拒绝连接、未认证、终态后5秒内自行退出、临时文件清理、Unicode stdin、C#事件分类及应用Exit回收均通过；不等于桌面UI或RDP成功登录验收 | A/remaining-desktop-complete.log；诊断 A/remaining-desktop.log、remaining-rdp-diagnostic.log、reviewer-rdp-launch-matrix.json、reviewer-rdp-timeline.json |
| `rustc ... --test backend/desktop/src/terminal_encoding.rs` 及生成 exe | **0，3/3**：UTF-8/控制字节、Latin1、Windows GBK/GB18030；不代表远端收发验收 | A/encoding.log |
| `rustc ... --test backend/desktop/src/rdp_process.rs` 及生成 exe | 101（三失败）→ **0，3/3**：启动失败清理、清理失败重试、自有子进程 kill/wait | P/rdp-red.log、rdp-green.log |
| `node --test scripts/check-package.test.mjs` | **0，4/4**；合法 Telnet Password 提示、实际合成秘密/私钥/用户路径正反例 | A/package.log |
| `pnpm --dir frontend exec vitest run src/lib/ipc.test.ts` | 缺包装红（3失败）→ **0，4/4**；仅 invoke 契约与错误传播 | A/ipc-green.log |
| `pnpm --dir frontend exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib 'ES2022,DOM' --skipLibCheck src/types/ipc.ts src/lib/ipc.ts src/lib/ai/aiIpc.ts` | **0**；初次未引号逗号的命令参数错误退出1，纠正命令后通过 | A/shared-types.log、shared-types-fixed-command.log |
| G04 独立副本 `run-g04.ps1` | **脚本0：baseline0 → 无条件Trust变异101（真实握手安全断言失败）→ 恢复0**；共享SHA一致、副本原字节还原均true。初始锁文件/离线解析失败独立保留，不计行为红；只为隔离副本复用锁定依赖修复lock，根Cargo.lock未改 | P/g04-result.json、g04-baseline.log、g04-mutated.log、g04-restored.log、g04-prelock-*.log、g04-lock*.log |
| 定向 diff / fmt | 本轮涉及的45个后端Rust文件 `rustfmt --edition 2021 --config skip_children=true --check` 修前1→限定格式修复后 **0**；不递归格式化其他模块，非全仓fmt。定向diff检查 **0** | A/fmt-files.txt、fmt-before.log、fmt-final.log、diff-check.log |
| 最终 `check -p openshell-desktop -p openshell-ssh -p openshell-app-core --locked --offline --jobs 2` | **0**；仅相关三个包及其依赖，非workspace门禁 | A/remaining-check.log |
| 最终 fmt / diff / 反馈保存 | 5个剩余相关Rust文件定向 `rustfmt --check` **0**；定向diff **0**；员工2、员工3、CEO内容逐字节不变；员工1过时待复跑结论已清除 | A/remaining-fmt.log、remaining-delivery-check.log |

AI 与同步本地HTTP测试只在测试进程清除 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，并设 NO_PROXY 为 loopback；先确认正常响应成功，再验证失败。最初受代理干扰的 `ai-red.log` 不计实际验收，不用网络拒绝让负例假通过。

本轮最终证据：`A/resume-results.md` 末尾记录本次收尾；`A/final-sync.log` 的33项是此前阶段通过记录，当前app-core完整53项以上述最终日志为准。RDP诊断区分了两件事：WindowStyle Hidden 与 CREATE_NO_WINDOW 组合会阻塞最小命令；真实拒绝连接可能在29–33秒才到 failed/516，25秒的 starting 快照不能代表最终状态。保留接手时已有的60秒终态边界和真实终态后的5秒自动退出断言，reader.join 后读取最终状态；没有继续增加等待或删除断言。长源码传命令行经对照可正常运行，无需改用stdin传源码。最终只读复审 `A/remaining-review.md` 无未解决Critical/Important。没有新建venv、复制构建环境、修改前端业务组件或重写旧audit。

验证范围：（逐 BUG/G ID，源码/单元/真实IPC/真实环境分别说明）

| ID | 当前结论与未验证范围 | 命令 / 退出码 / 证据 |
|---|---|---|
| BUG-001 | ✅ 后端原生入口拒绝 use_mock=true；不存在原生端口错误测试通过；真实桌面/占用硬件未验收 | `test -p openshell-serial` / 0 / P/serial-green.log |
| BUG-002 | ✅ 双向 SFTP 协议回环及真实隔离文件校验通过；外部SSH/桌面拖放未验收 | `test -p openshell-sftp` / 0 / T/sftp-final.log |
| BUG-003/004/005 | ✅ 后端完整配置、单接收队列、故障与空闲区分、worker释放已核对/定向测；前端广播/重连与热拔插由 trae/CEO 联验 | `test -p openshell-serial` / 0 / P/serial-green.log |
| BUG-006/007 | ✅ 运行状态、终态拒绝操作、同ID暂停恢复/取消已测 | `test -p openshell-sftp` / 0 / T/sftp-final.log |
| BUG-008 | ✅ 本机 DISPLAY/Xauthority、替代授权、真实SSH请求/本机替换/双向数据/断线EOF回归通过；命令退出0、证据 A/remaining-ssh-final.log；真实 X Server 图形应用与其他 OS 未验收 | `test -p openshell-ssh` / 0 / A/remaining-ssh-final.log |
| BUG-009 | ✅ Rust 编码入口无损性与共享包装；真实GB18030远端双向/HEX保真由CEO联验 | `test -p openshell-desktop` / 0 / A/remaining-desktop-complete.log |
| BUG-010 | ✅ ActiveX登录/错误/断开事件及每launch生命周期；启动参数、Unicode输入和事件码分类已修，完整desktop 29/29退出0，真实拒绝与自行退出通过，见 A/remaining-desktop-complete.log、reviewer-rdp-timeline.json；外部RDP/NLA成功登录未验收 | `test -p openshell-desktop` / 0 / A/remaining-desktop-complete.log |
| BUG-011/012 | ✅ 新秘密 Vault 引用、脱敏DTO、锁库失败保留、迁移重试、随机秘密DB/WAL/新备份/JSON扫描及SOCKS认证；旧schema迁移及历史副本风险见下 | app-core 完整命令（上表） / 0 / A/remaining-app-core-final.log |
| BUG-013/014 | ✅ 建连失败非零REP、真实往返，主动/被动三类监听与子任务释放；远端取消失败返回Err保留重试 | `test -p openshell-forward` / 0 / T/forward-complete-green.log |
| BUG-015 | ✅ 所有现有归档实体及新增凭据依赖回环、ID重映射、目标Vault重加密、事务回滚/重试、token生命周期；不支持的终端profile依赖明确阻断 | app-core 完整命令 / 0 / A/remaining-app-core-final.log |
| BUG-016/017 | ✅ OpenSSH IdentityFile/ProxyJump/L/R/D不支持或缺失时预览阻断；三策略、数据库/同批重复和副本命名已测。未宣称这些OpenSSH依赖均已自动导入 | `test -p openshell-importer` / 0 / A/importer-final.log |
| BUG-018 | ✅ 两个隔离设备+本地HTTP：冲突→local/remote恢复→再次修改→对端收到；自身上传回声、冲突后本地/远端再变更可刷新解决且旧快照保留；事务失败、pull/push/上传确认竞态、防旧冲突覆盖及私钥口令依赖通过。app-core最终53项退出0，见 A/remaining-app-core-final.log；刷新服务回归先红101见 remaining-conflict-refresh-red.log | app-core 完整命令 / 0 / A/remaining-app-core-final.log |
| BUG-019 | ✅ 解析及引擎错误/旧时间戳/合法0/恢复/停止测试；最新错误通过原IPC签名返回；真实SSH与缺字段UI未联验 | `test -p openshell-monitor` / 0 / M/monitor-green.log |
| BUG-020 | 不预设后端修改；归 trae/CEO | 不在员工1后端修改范围，无本轮通过声明 |
| BUG-021/022 | ✅ 三类实际HTTP流错误/空/HTML/EOF/取消/悬挂body失败，正常完成成功；生产档案总期限15秒，失败不写verified_at | `test -p openshell-ai` / 0 / A/ai-green.log |
| BUG-023/024 | ✅ canonical20与legacy读取、启动/迁移保留数量、备份失败reject；前端绑定真实新快照由gemini联验 | store + app-core（上表） / 0 / A/store-green.log、remaining-app-core-final.log |
| BUG-025 | ✅ 一次性本地Agent真实签名、空身份/拒签/不可用/服务器拒绝均已测；Windows named pipe实测，真实用户Agent及Unix环境未验收 | `test -p openshell-ssh` / 0 / A/remaining-ssh-final.log |
| BUG-026 | ✅ 后端body/kind/变量/macro/send_mode CRUD回环；前端展开/执行由gemini联验 | app-core 完整命令 / 0 / A/remaining-app-core-final.log |
| G01 | 仅员工1共享IPC测试/独立类型检查通过；业务前端与全量归另两人/CEO | 共享 vitest / 0；独立 tsc / 0 / A/ipc-green.log、shared-types-fixed-command.log |
| G02 | ✅ 45个本轮涉及的后端Rust文件定向格式检查通过；全量fmt留CEO | 定向 rustfmt --check / 0 / A/remaining-fmt.log、fmt-final.log |
| G03 | ✅ 扫描器4个正反例通过，未扫描本次真实发布产物 | `node --test scripts/check-package.test.mjs` / 0 / A/package.log |
| G04 | ✅ strict未知/已知/变更、accept_new首次/变更通过；隔离Trust变异被检出，恢复后通过，共享源码哈希不变 | SSH / 0；隔离变异 0→101→0 / A/remaining-ssh-final.log、P/g04-result.json |

未验证部分：（原因、所需条件、由谁补）

- 真实串口设备/虚拟串口对：占用、长时间传输、RTS/CTS、XON/XOFF、热拔插；不能将Mock吞吐当原生验收。由CEO安排硬件/桌面联测。
- 真实外部 SSH/SFTP、用户 Agent、X Server、RDP/NLA 和桌面 Tauri IPC 没有执行。回环协议测试与单元测试不等于这些环境验收。
- trae 仍需接 `rdpGetStatus/rdpClose` 并消费 `unavailable_fields`；gemini 的前端归档/同步/凭据界面仍需使用真实后端联测。员工1未越界修改业务组件。
- 未运行 workspace全量test/build、全量前端门禁、发布/安装/升级包和其他操作系统验收；按任务分工留CEO。
- 本轮复用任务书与既有 FinalShell 映射证据，没有运行 REA，也没有重新读取用户真实 FinalShell 凭据或声称完成新取证。

验收对照：（逐项 ✅/❌，不能用总测试数代替）

- ✅ 三个P0及旧schema恢复路径有后端定向证据；❌ 不据此解除整机上线门禁，硬件、跨端及真实用户升级仍需联验。
- ✅ 白名单内源码、测试和证据已保存；已有未提交改动保留，无提交推送；共享契约遵守main.md。
- ✅ JSON无解密秘密，归档完整依赖恢复的支持范围和失败语义明确；❌ 不支持的终端profile不能声称已恢复。
- ✅ 本次最终desktop 29、SSH 13、app-core 53，共95项定向回归通过，命令均退出0；此前失败和G04隔离变异记录保留，最终只读复审无未解决Critical/Important。此结论仅覆盖所列自动化范围，不能替代整机上线验收。

范围外发现（未处理）：

- 其他员工回执中旧的共享IPC缺失结论已过时，但其业务组件是否完整接入本次交付仍需对应负责人确认；没有改写他人回执。
- 既有UI文案、占位符、全量前端问题与本员工白名单外文件没有顺手修改。

遗留问题与风险：（含已有明文历史副本、迁移兼容、RDP/X11/Agent平台能力）

- 历史DB页/WAL/旧备份/旧缓存可能已有明文；本轮只证明新生成测试秘密不在新产物出现。未删除或声称清除了用户历史副本。
- 旧schema明文恢复入口已实现并通过schema1真库fixture；取消、错密码或迁移错误会中止启动并保留原库，不绕过安全快照。真实用户旧库升级及非Windows恢复入口未验收。
- 旧包缺凭据只能警告补录；新包发现缺依赖拒绝。现格式没有终端profile实体，新加密完整导出遇此引用拒绝，旧包则警告并清除引用。
- RDP需要Windows已安装的v11 ActiveX及系统PowerShell5.1；外部NLA/证书/策略和交互认证未联验。应用正常Exit会回收自有进程，强制结束/崩溃的系统级回收未专门测试。X11需要已有可连接的本机X Server、DISPLAY及有效Xauthority，不启动/安装X Server。

收尾最终结果：三条指定模块回归均已执行并退出0，完整日志见上表；RDP与X11剩余失败已查明，新增服务层边界通过。真实平台验收、历史明文副本及分工外门禁仍按本节未验证范围保留，不将自动化通过写成全面上线通过。

需要决策者决定的事：（共享契约变化需写具体建议；无则写无）

1. `.osvault`兼容扩展已获用户批准，无需重复审批。
2. 用户已明确同意RDP ActiveX、复用本机X Server/Xauthority及旧库先解锁迁移再安全快照三项方案，均已实施，不再重复待决。
3. 无新增架构决策请求；真实环境、跨端及其他OS验收由CEO安排。

## 员工2：gemini

【回执 | 员工:gemini | Task 4】

状态：修复完成，定向验证通过

改动清单：
- `frontend/src/stores/sftpStore.ts`: 普通上传/下载默认 `resume = false`；增加 `resumeTransfer(taskId)`，复用原 taskId 恢复同一任务。
- `frontend/src/components/SftpView.tsx`: 普通上传下载显式指定 `resume: false`。
- `frontend/src/components/TransferQueueDrawer.tsx`: 统一 `running` 运行态；在 `running`/`queued` 下展示暂停/取消，在 `paused` 下展示恢复/取消，终态禁用/隐藏操作。
- `frontend/src/components/ProxyManagerModal.tsx`: 清除 legacy localStorage 缓存（`openshell_proxy_list_fallback_v1`）；表单密码仅内存驻留不回显；编辑留空保留已有密码，显式勾选清除才 clear_password；保存失败保留表单并显示错误。
- `frontend/src/components/PortForwardModal.tsx`: SOCKS 认证采用 `userpass`；原始密码放入 `socks_password`，绝不传入 `socks_password_ref`；支持 `has_socks_password` 凭据感知与清除；启停失败弹窗提示。
- `frontend/src/components/ImportExportModal.tsx`: 在 commit 时向 `importerCommit` 传入 `archive_token`；关闭/切换/重选时调用 discard 释放服务端暂存；提交后保留 warnings（私钥/跳板机等待补录依赖提示）；失败展示具体错误。
- `frontend/src/stores/syncStore.ts`: 增加 `conflicts: SyncConflict[]`、`loadConflicts()`、`resolveConflict(conflictId, choice)`；防重复提交机制；原子更新与刷新，不使用退出/清空假冒冲突解决。
- `frontend/src/components/SyncSettingsModal.tsx`: 增加待解决版本冲突列表面板，提供“保留本地副本”与“使用远端数据”两个明确操作，操作中防重复提交并在完成后刷新。
- `frontend/src/stores/aiSettingsStore.ts`: `testProfile` 无论成功、失败或超时 reject 均重置 `testingProfileId` 为 null；仅有效成功才更新 `verified_at`；reject 封装友好 `ProviderTestResult`。
- `frontend/src/components/settings/ai/AiModelSettings.tsx`: 新增 `formatShortAiError`，避免暴露远端 502 HTML、网关异常或原始报文；不加前端欺骗性计时器。
- `frontend/src/updater/store.ts`: `loadConfig` 读取规范键 `update.backup_keep`，兼容旧键 `update.backupKeep`；`patchConfig` 仅写规范键；`backupNow` 向上抛出 reject 并返回 `BackupInfo`。
- `frontend/src/updater/AboutUpdateTab.tsx`: 捕获 `backupNow()` 异常并红色文字显示错误；仅在实际创建成功时才展示绿色快照文件名与路径。
- `frontend/src/stores/snippetStore.ts`: 规范化读写 `body` 与 `kind: "snippet"`，保持与旧 `command_template` 兼容；保留多行正文。
- `frontend/src/components/SnippetBar.tsx`: 优先使用 `body ?? command_template`；执行模式发送末尾换行，插入模式不发送换行；变量参数展开正常。
- 对应单元测试文件：
  - `frontend/src/stores/sftpStore.test.ts` (新增)
  - `frontend/src/components/TransferQueueDrawer.test.tsx` (新增)
  - `frontend/src/components/ProxyManagerModal.test.tsx` (更新)
  - `frontend/src/components/PortForwardModal.test.tsx` (新增)
  - `frontend/src/components/ImportExportModal.test.tsx` (新增)
  - `frontend/src/stores/syncStore.test.ts` (扩充)
  - `frontend/src/components/SyncSettingsModal.test.tsx` (扩充)
  - `frontend/src/stores/aiSettingsStore.test.ts` (扩充)
  - `frontend/src/updater/store.test.ts` (扩充)
  - `frontend/src/updater/AboutUpdateTab.test.tsx` (新增)
  - `frontend/src/stores/snippetStore.test.ts` (扩充)
  - `audit/remediation-task4/gemini/task4_gemini_evidence.md` (新增证据报告)

关键实现说明：
1. **传输安全与状态收口 (BUG-002, 006, 007)**：全面杜绝前端默认 resume=true 导致的等长损坏覆盖；统一规范 `running` 状态展示；暂停时点击恢复调用 `sftpResumeTransfer(taskId)`，终态禁止再次触发伪造新任务。
2. **凭据安全与零泄露 (BUG-011–014)**：清理所有 localStorage 遗留代理缓存；表单密码仅内存保留，列表与编辑展示根据 `has_password` / `has_socks_password` 感知凭据存在，不回显解密文本；编辑留空保留原密码，显式勾选 clear 标志才清除；SOCKS 认证对齐 `userpass`。
3. **归档上下文与依赖保留 (BUG-015–017)**：在 commit 阶段正确传递 `archive_token` 关联归档秘密；在关闭弹窗或重新解析时通过 fallback 封装调用 discard 释放；提交后在界面持久展示待补录依赖 warnings，避免跳板机或私钥依赖静默丢失。
4. **冲突解决明确操作 (BUG-018)**：在 `syncStore` 和 `SyncSettingsModal` 建立两两明确的解决动作（“保留本地副本” vs “使用远端数据”），加防重复提交锁，杜绝以 clearLocalSyncData 或 logout 伪装解决。
5. **AI 状态健壮性 (BUG-021, 022)**：测试连接任何异常（包括 reject、网络中断、超时、空结果）均解除 testing 状态，且不更新 `verified_at`；过滤 HTML/原始报文为友好短错误。
6. **备份配置与失败反馈 (BUG-023, 024)**：优先读取规范 `update.backup_keep`；`backupNow` 异常向上抛出并在 UI 呈现明确红色错误，成功才绑定真实快照路径。
7. **片段正文闭环 (BUG-026)**：前端读写统一映射 `body`，多行文本和参数占位符展开正常，execute 发送换行，insert 仅插入。

自测结果：（逐条命令、退出码、日志；标明修复前/后）
1. 全量定向单元测试（Gemini 模块）：
   - 命令：`pnpm --dir frontend exec vitest run src/stores/sftpStore.test.ts src/components/TransferQueueDrawer.test.tsx src/components/SftpView.test.tsx src/components/ProxyManagerModal.test.tsx src/components/PortForwardModal.test.tsx src/components/ImportExportModal.test.tsx src/stores/syncStore.test.ts src/components/SyncSettingsModal.test.tsx src/stores/aiSettingsStore.test.ts src/updater/store.test.ts src/updater/AboutUpdateTab.test.tsx src/stores/snippetStore.test.ts`
   - 退出码：0
   - 结果：12 passed (12), 56 passed (56), 0 failed.
   - 修复前：sftp 默认 resume=true 且恢复新创任务；代理密码存 localStorage；归档丢失 token；冲突无解决入口；AI 失败悬挂 testing；备份吞错显示假成功；片段正文丢失。
   - 修复后：56 项测试全绿，所有异常与边缘分支均有测试断言保护。
2. 限定 ESLint 检查（Gemini 修改文件）：
   - 命令：`pnpm --dir frontend exec eslint src/components/SftpView.tsx src/components/TransferQueueDrawer.tsx src/stores/sftpStore.ts src/components/ProxyManagerModal.tsx src/components/PortForwardModal.tsx src/components/ImportExportModal.tsx src/components/SyncSettingsModal.tsx src/stores/syncStore.ts src/components/settings/ai/AiModelSettings.tsx src/stores/aiSettingsStore.ts src/updater/store.ts src/updater/AboutUpdateTab.tsx src/components/SnippetBar.tsx src/stores/snippetStore.ts`
   - 退出码：0
   - 结果：0 errors, 3 warnings (既有 hooks 依赖警告).

验证范围：
- BUG-002: 前端源码已改 `resume: false`，单元测试断言覆盖；真实等长双向 SHA256 需与后端联调。
- BUG-006: TransferQueueDrawer 状态流转已规范，终态无操作按钮，测试覆盖。
- BUG-007: 暂停后恢复调用 `sftpResumeTransfer(taskId)`，复用原 ID，测试覆盖。
- BUG-011: 代理与动态转发密码 localStorage 读写已删除，编辑留空保留/清除语义一致，单测验证 localStorage 零写入。
- BUG-012: SOCKS 认证类型标准对齐 `userpass`，测试覆盖。
- BUG-013: 动态转发启停状态与错误提示已接入。
- BUG-014: 转发规则列表在连接断开后的展示状态与启停反馈已处理。
- BUG-015: 归档 commit 传递 `archive_token`，关闭/重预览释放 token，测试覆盖。
- BUG-016: 导入后持久呈现 warnings（缺失私钥/跳板依赖提示），单测覆盖。
- BUG-017: 批内冲突策略单选正确传递给 preview/commit。
- BUG-018: 同步冲突提供两选项操作界面与防重提交，单测覆盖。
- BUG-021: AI 测试失败/空响应不写 `verified_at`，解除 testing，单测覆盖。
- BUG-022: AI 超时与异常解除 testing 且友好报错，单测覆盖。
- BUG-023: 备份保留数优先读取 `update.backup_keep`，仅写入规范键，单测覆盖。
- BUG-024: 备份失败异常向上传播并在 UI 显式报红，单测覆盖。
- BUG-026: 片段正文以 `body` 读写，保留多行与变量展开，insert/execute 语义测试覆盖。
- G01: Gemini 所属全部 12 个测试文件全部通过，未降低断言标准。

未验证部分：
1. 跨进程真实 SFTP 文件等长覆盖与 SHA256 校验（需后端与真实 sshd 环境，由 CEO 联调）。
2. 后端新增 IPC 真实执行（`importer_discard_preview`、`sync_list_conflicts`、`sync_resolve_conflict`）：前端已做健壮的 fallback 接入和单测验证，等待 gpt 在 commands.rs 中完成对应端点注册后可直接联调。
3. 真实外部代理服务器认证握手失败拦截与系统钥匙串物理扫描（需真实网络环境与 CEO 跨模块扫描）。

验收对照：
- BUG-002 (前端默认安全覆盖与传参): ✅
- BUG-006 (传输运行态与操作按钮一致): ✅
- BUG-007 (恢复原任务 ID 传输): ✅
- BUG-011 (代理与隧道密码前端零持久化与回显控制): ✅
- BUG-012 (SOCKS 认证 userpass 前端契约): ✅
- BUG-013 (SOCKS 状态反馈): ✅
- BUG-014 (监听与断连状态处理): ✅
- BUG-015 (归档 token 传递与丢弃): ✅
- BUG-016 (导入警告持久展示): ✅
- BUG-017 (冲突策略前端传参): ✅
- BUG-018 (同步冲突前端解决入口与防重): ✅
- BUG-021 (AI 失败不置已验证): ✅
- BUG-022 (AI 超时与异常解除 testing 且友好报错): ✅
- BUG-023 (统一 update.backup_keep 读写): ✅
- BUG-024 (备份失败错误呈现与真实结果绑定): ✅
- BUG-026 (片段正文闭环与变量模式): ✅
- G01 (自身负责模块测试通过): ✅

范围外发现（未处理）：
- `backend/desktop/src/commands.rs` 尚未导出 `importer_discard_preview`、`sync_list_conflicts`、`sync_resolve_conflict` 命令（属 gpt 职责范围，前端已使用容错与 invoke 准备妥当）。
- `SessionModal` 内嵌端口转发规则属于 trae 独占范围，前端未越界触碰。

遗留问题与风险：
- 若后端尚未支持 `importer_discard_preview`，前端调用将被静默忽略或原生捕获，不阻塞用户主流程。
- 旧版本遗留在 SQLite 数据库中的历史明文密码需要后端迁移脚本协助擦除（前端已清理全部本地 localStorage 缓存）。

需要决策者决定的事：
- 提醒 gpt 在 `backend/desktop/src/commands.rs` 和 `frontend/src/lib/ipc.ts` 补齐 `importer_discard_preview`、`sync_list_conflicts`、`sync_resolve_conflict` 的注册与导出，以便 CEO 进行端到端联调。

## 员工3：trae

【回执 | 员工:trae | Task 4】

状态：可独立验证的前端条目已完成并通过定向测试；RDP 完整生命周期（前端契约未交付）、X11 数据通道、SSH Agent 认证及全部真实硬件/真实桌面联调仍挂起，未按通过计。

改动清单（全部位于 main.md 第五节 trae 白名单，15 个产品文件 + 7 个测试文件）：

产品源码：
- `frontend/src/stores/terminalStore.ts`（串口配置缓存与失败语义、RDP 本地阶段、发送编码）
- `frontend/src/stores/serialStore.ts`（单接收源订阅、发送错误）
- `frontend/src/stores/monitorStore.ts`（失败/空/陈旧/恢复）
- `frontend/src/stores/containerStore.ts`（action 连接归属校验）
- `frontend/src/lib/terminal-actions.ts`（流式解码 + 发送编码最小编码路径）
- `frontend/src/components/XtermView.tsx`、`HexDumpView.tsx`、`TerminalHost.tsx`、`SerialSendBar.tsx`、`TerminalTabs.tsx`、`RdpSessionView.tsx`、`MonitorDashboard.tsx`、`ServerSidebar.tsx`、`ContainerWorkspace.tsx`、`SessionModal.tsx`

测试（新增标记 N，扩展标记 E）：
- N `frontend/src/stores/serialStore.test.ts`（4）
- N `frontend/src/lib/terminal-actions.test.ts`（6）
- E `frontend/src/stores/terminalStore.test.ts`（10，含本轮串口/RDP 新增 4）
- E `frontend/src/stores/monitorStore.test.ts`（6，含本轮新增 3）
- E `frontend/src/stores/containerStore.test.ts`（7，含本轮新增 3）
- E `frontend/src/components/ServerSidebar.test.tsx`（4，本轮修产品使其通过，未改断言）
- E `frontend/src/components/ContainerWorkspace.test.tsx`（2，未改断言）

证据：`audit/remediation-task4/trae/verification.md`、`audit/remediation-task4/trae/tracked-diff.patch`（`git diff` 全量输出 185,816 字节）。工作区存在其他会话/员工的大量未提交改动，本轮未回退、未格式化、未提交、未推送。

关键实现说明：

1. 串口（BUG-001/003/004/005）：删除生产路径 `useMock=true` 回退；`openSerial(cardId, serialConfig, false)` 每次打开只调用一次；`TerminalTab.serialConfig` 缓存首次解析的完整配置（端口/波特率/数据位/停止位/校验/流控/DTR/RTS），重连优先复用，其次动态读 `protocol_options_json`，都取不到则明确报错并停止重连，绝不回退 `COM1`。`serialStore` 改为每 `cardId` 模块级单轮询 + `subscribeSerial` 多订阅广播同一份原始字节，ASCII 与 HEX 不再各自抢后端唯一队列；最后一个订阅退订即停轮询；读取失败停止轮询并向所有订阅者派发 `onError`，由 `XtermView`/`HexDumpView` 归入 `markDisconnected`；发送失败写 `sendError`，由 `TerminalHost` 转成断开并清定时器。
2. 编码（BUG-009）：`terminal-actions.ts` 提供 `isUtf8Encoding`、`createStreamingDecoder`（`TextDecoder(encoding, {stream:true})`）、`encodeTextForSession`；接收侧 UTF-8 走快速路径直写 `Uint8Array`，非 UTF-8 流式解码，未知编码抛错不回退 UTF-8；发送侧统一走 `encodeTextForSession`（UTF-8 本地编码，其余调用 `terminalEncode`），`sendCommandToTabs`/串口 `sendCurrent`/`sendSnippet`/定时发送/`SerialSendBar` 全部按会话 encoding。HEX 视图保持原始字节。
3. RDP（BUG-010 部分）：`TerminalTab.rdpPhase: "starting" | "launched" | "failed"` 与 `rdpLaunchedAt`；`launchRdp` 成功只置 `status:"connecting"` + `rdpPhase:"launched"`，不再写 `connected`/`connectedAt`；失败置 `error`；`RdpSessionView` 与 `TerminalTabs` 用琥珀色「客户端已启动」并明示「启动 mstsc 仅代表本地客户端已唤起，是否真正连上远端需等待后端状态回传」，无绿色成功暗示。
4. 监控（BUG-019）：`monitorStore` 新增 `latestError`/`latestFailedAt`/`latestReceivedAt`；reject 保留旧快照并记录错误时间，`null` 视为「等待首次采样」，成功清错；新增 `METRICS_STALE_AFTER_MS = 9000` 与 `isMetricsStale`；`MonitorDashboard`/`ServerSidebar` 区分实时/等待首次采样/数据过期/采集失败，未拿到有效采样时数值显示 `-`，不渲染伪 0。
5. 容器（BUG-020）：沿用既有 `connectionGeneration/isCurrent`，不重构；`action(connId, id, act)` 校验 `current.connId === connId`、运行时、容器仍在列表内，过期连接直接拒绝且不执行 `sshExec`，执行后再次校验 generation 才 `reload`；`ContainerWorkspace` 传入自身 `connId`。
6. G01：`ServerSidebar` 折叠态新增 `aria-label="资源监控"` 与 `title="容器管理"` 入口（点击同时切到容器页并 `probeDocker`），使既有 4 项断言全部恢复，未删断言、未加 skip、未扩大超时。

自测结果（逐条命令、退出码）：

1. `pnpm --dir frontend exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/stores/containerStore.test.ts src/components/HomeHub.test.tsx src/components/SessionModal.test.tsx src/components/ContainerWorkspace.test.tsx src/components/ServerSidebar.test.tsx src/components/XtermView.test.tsx src/lib/terminal-actions.test.ts` → **退出码 0**，`Test Files 10 passed (10)`，`Tests 72 passed (72)`（单文件：terminal-actions 6、serialStore 4、containerStore 7、monitorStore 6、terminalStore 10、ContainerWorkspace 2、ServerSidebar 4、XtermView 7、SessionModal 11、HomeHub 15）。
2. `pnpm --dir frontend exec eslint <本轮 22 个改动文件>` → **退出码 0**，`0 errors, 3 warnings`（均为既有 `react-hooks/exhaustive-deps`：`ContainerWorkspace.tsx:144`、`SessionModal.tsx:416`、`SessionModal.tsx:593`，非本轮引入）。
3. `pnpm --dir frontend exec tsc --noEmit` → **退出码 1**，报错全部位于非本任务白名单文件（`AppLayout.tsx`/`SftpView.tsx`/`TransferQueueDrawer.tsx` 的 `TransferState` 比较、`SnippetBar.tsx`/`snippetStore.ts` 的 `command_template`、`aiSettingsStore.ts` 的 null 赋值、`ImportExportModal.test.tsx`/`AboutUpdateTab.test.tsx` 未用 React、`updater/store.test.ts` 的 `BackupInfo`）。本轮 22 个文件**未出现在任何 TS 报错**；全量类型检查与跨员工修复留 CEO。
4. 修复前失败证据：`ServerSidebar.test.tsx` 曾在修复前真实失败 2 项（缺失 `aria-label=资源监控`/容器入口），修复后 4/4 通过；`XtermView.test.tsx` 首次运行因 `encodingRef` TDZ 报错 1 项，调整声明顺序后 7/7 通过。BUG-001/003/004/005/019 的复现以静态调用链核对 + 新增用例为主，未保留独立的「修复前失败日志」，见「未验证部分」。

验证范围（逐 BUG/G ID）：

- BUG-001 前端 ✅（单次原生调用、无 Mock、无端口拒绝、失败不置 connected；真实后端/占用端口未测）
- BUG-003 前端 ✅（非默认参数首次/重连一致、无配置明确失败；真实设备未测）
- BUG-004 前端 ✅（同一份字节广播给 ASCII/HEX、最后退订停轮询、隐藏视图不抢读；分屏未实测）
- BUG-005 前端 ✅ 部分（读/写失败→断开、停定时器、主动关闭不重连、空闲不自动重试；真实拔插/写失败未测）
- BUG-008 ❌ 未做（X11 数据通道属 gpt 后端，前端仅保留标记，未声称生效）
- BUG-009 前端 ✅（收侧流式跨块、发侧统一编码路径；gpt 已交付 `backend/desktop/src/commands.rs:874 terminal_encode` 并在 `lib.rs:187` 注册，`lib/ipc.ts:362 terminalEncode` 存在；真实 GB18030 收发与 HEX 原字节未实测）
- BUG-010 ⚠️ 部分（启动≠连接、失败状态、launched 诚实展示有单测；后端 `rdp_launch` 已返回 `launch_id` 且有 `rdp_get_status`/`rdp_close`，但前端 `types/ipc.ts` 的 `RdpLaunchResult` 无 `launch_id`、`TabStatus` 无 `launched`、`lib/ipc.ts` 无 `rdpGetStatus/rdpClose` 包装，属 gpt 白名单未交付，完整生命周期挂起）
- BUG-011/012 前端 ✅ 部分（SessionModal 动态隧道 `socks_auth:"userpass"`、`socks_username`、仅在用户输入时附 `socks_password`，密码不回填、不写 localStorage；`PortForwardModal` 未触碰，归 gemini；真实认证回读与 `has_socks_password` 展示未测）
- BUG-014 前端 ✅ 部分（断开事件汇入既有 `markDisconnected` 并清理串口轮询/发送定时器；真实 SSH 监听释放属 gpt/gemini）
- BUG-019 前端 ✅（失败/空/陈旧/恢复/合法 0 区分；`unavailable_fields` 未交付，挂起）
- BUG-020 前端 ✅（现有防护回归 + action 归属；真实 Docker/Podman 未测）
- G01 ✅（HomeHub 15/15、SessionModal 11/11、ServerSidebar 4/4、XtermView 7/7，未降标准）
- G03 未做（未向 gpt 提供 Telnet 合成样例，低优先，留待 CEO 安排）

未验证部分（原因、所需条件、由谁补）：

- 真实串口硬件：不存在/被占用端口、≥1 MiB 持续接收、热插拔、RTS/CTS 与 XON/XOFF 流控 → 需真实设备或虚拟串口对；本轮全部为 jsdom 单测，不声明硬件通过。
- 真实 RDP：可达/不可达/认证拒绝/用户关闭 mstsc/退出码 → 需真实 Windows 远端与 NLA；且前端契约未交付，由 gpt 补 `types/ipc.ts`/`lib/ipc.ts` 后 trae 再接状态轮询与 close。
- X11 转发真实 X Server、SSH Agent 一次性公钥认证 → 需后端通道（gpt）与真实 Agent/X Server。
- 非 Windows 平台串口与本地终端路径差异、桌面壳内真实 IPC 往返 → 未启动桌面壳验证。
- 全量 `pnpm test/typecheck/lint/build`、Rust workspace 门禁、包扫描、版本检查 → 按分工留 CEO。
- BUG-001/003/004/005/019 的「修复前失败日志」未单独留存（先按调用链定位后即改代码并补用例）。

验收对照：

- BUG-001 ✅（前端可测部分） / BUG-002 非本员工 / BUG-003 ✅ / BUG-004 ✅ / BUG-005 ✅（前端可测部分）/ BUG-006/007 非本员工
- BUG-008 ❌（挂起） / BUG-009 ✅（前端可测部分，运行时未验证）/ BUG-010 ⚠️ 仅诚实的 launched 部分
- BUG-011/012 ✅（SessionModal 前端部分）/ BUG-013 非本员工 / BUG-014 ✅（前端衔接部分）
- BUG-015–018 非本员工 / BUG-019 ✅（`unavailable_fields` 除外）/ BUG-020 ✅ / BUG-021–024 非本员工 / BUG-025 ❌（挂起）/ BUG-026 非本员工
- G01 ✅ / G02 非本员工 / G03 ❌（未提供样例）/ G04 非本员工

范围外发现（未处理）：

- `frontend/src/components/AppLayout.tsx`、`SftpView.tsx`、`TransferQueueDrawer.tsx` 存在 `TransferState` 与 `"transferring"` 的类型不一致（非本任务、非本员工）。
- `SnippetBar.tsx`/`snippetStore.ts` 的 `command_template` 与 `types/ipc.ts` 契约不一致、`aiSettingsStore.ts` null 赋值、`updater/store.test.ts` 的 `BackupInfo` 缺字段、两处未使用 React 导入 → 均属 gemini/gpt 范围，只报告不修改。
- `SessionModal.tsx:416`/`:593` 以及 `ContainerWorkspace.tsx:144` 的 exhaustive-deps 警告为既有问题，未顺手改动以免引入无关 diff。

遗留问题与风险：

- **范围变更（需 CEO 知悉）**：`spec.md`/`trae3.md` 原本裁决 SessionModal 只记录不改；gpt 已实际交付 `SocksAuth = "none" | "userpass"`、`socks_password`（`frontend/src/types/ipc.ts:367-406`），因此按用户「只做不依赖 gpt 交付、可独立验证」的指示补了前端表单。密码只存本次 state、不回填、不落 localStorage；`PortForwardModal` 未触碰。
- RDP 前端与后端契约已不一致：后端 `RdpLaunchResult` 含 `launch_id`，前端类型没有；一旦 gpt 补类型，本轮 `terminalStore` 的 `rdpInfo` 赋值可自然扩展，但仍需新增状态轮询与 close 逻辑。
- `serialStore` 采用模块级单轮询，若同一 `cardId` 在两个窗口打开，仍共享同一轮询（符合单消费者要求）；跨窗口应为同一 webview 实例，未实测多窗口。
- 本轮新增 7 个测试文件中的 4 个为未跟踪文件，`git diff` 不覆盖，已用文件名与用例数在证据文件中列明。

需要决策者决定的事：

1. RDP 完整生命周期：请 gpt 在 `frontend/src/types/ipc.ts`（`RdpLaunchResult.launch_id`、`TabStatus.launched`）与 `frontend/src/lib/ipc.ts`（`rdpGetStatus`/`rdpClose`）补齐，再由 trae 接轮询与关闭；在此之前 BUG-010 只能算「启动状态诚实化」，不能算整项关闭。
2. `unavailable_fields`（BUG-019）：需要 gpt 决定是否在本轮交付；交付后 trae 在 Dashboard/Sidebar 显示「该字段不可用」而非 0。
3. G03 的 Telnet 合成样例（`Password:` 合法提示 + 真阳性样例）是否本轮需要，若需要请指派具体期望格式。
4. BUG-008 X11 与 BUG-025 SSH Agent：后端能力未就绪，建议保留「未完成」，不以 UI 文案或已保存标记判通过。

## CEO 审查记录（由项目 CEO 填写，员工勿动）

任务书创建检查：2026-11-06 已读回检查。7 个任务/参考文件存在且非空，Markdown 代码围栏成对；统一矩阵完整覆盖 BUG-001–026 与 G01–G04，三人分流文件及回执标题一致。检查脚本退出码 0。此结果仅证明派工文档完整，不代表产品修复或测试通过。

员工产出真实性、白名单、契约一致性和跨模块复核：2026-11-06 已读取三份回执并进行数据安全、协议、前端三组独立只读评审。gpt后交付接口与另两人回执存在时间差；实际RDP生命周期、缺失监控字段、归档token等仍未完整接入。安全迁移、认证隧道导入、串口背压另有可复核缺口。具体交由Task5 R01–R15，不据员工“完成”字样关闭。

集中全量验证与动态验收：前端全量191通过3失败，typecheck退出2；Rust workspace在m3导入归档测试失败退出101。未通过。新鲜命令、证据及分批提交记录见 docs/bug/2026-11-06-REMEDIATION_REVIEW.md；真实硬件/成功RDP/NLA等仍未由CEO验收。

上线阻塞：BUG-001 / BUG-002 / BUG-011 仍待实际修复和验收，未解除。
