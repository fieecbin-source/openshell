# OpenShell 独立只读验收补充报告（第二轮）

固定审查快照：`openshell-verification-20261105`（本地临时目录，绝对路径已省略）；Git 基线/HEAD：`3c17ab1d852bc3991687c7f9dfed1720d2a26dee`。依据仍为仓库内 `audit/verification-20261105/FEATURE_INVENTORY.md`、当前源码和当前界面入口。本报告只补充第一轮之外的新发现，不重新引用第一轮结论作为证据。以下源码路径均相对于固定快照根目录，行号对应该快照。

本轮未读取主审报告、真实用户数据、系统凭据或密钥，未访问真实网络主机，未运行产品或网络测试，未修改产品、快照或 Git 状态。仅新增本验收文档。下列实际行为均为当前源码调用链可推导行为；验证方式为后续隔离复核步骤，不代表动态复现已经完成。

## 新发现

### A01 — 阻塞上线：代理认证密码明文写入 SQLite，动态转发密码也被当成普通文本字段保存

**代理入口至持久化：** `frontend/src/components/ProxyManagerModal.tsx:232–247` 将表单密码直接放进 `ProxyServerConfig.password`；`:181–184` 调用 `proxyListSave`，并将成功返回列表写入 fallback 缓存。`backend/crates/core-domain/src/value_objects.rs:316–326` 的密码是可序列化的 `Option<String>`。`backend/desktop/src/commands.rs:1903–1907` 将整个代理列表原样转为 JSON，写入 `global/proxy_list`；`backend/crates/store/src/repositories/settings.rs:78–82`、`:103–117` 直接写 SQLite `setting.value_json`，没有加密。`frontend/src/components/ProxyManagerModal.tsx:53–56`、`:131–134`、`:181–184` 在正常成功路径也把完整含密码列表放入 renderer localStorage，并非只在故障降级时缓存。

**动态转发路径：** `frontend/src/components/PortForwardModal.tsx:153` 把实际密码放入 `socks_password_ref`；`backend/crates/store/src/repositories/port_forward.rs:87–106`、`:174–193` 直接持久化该字符串，`backend/crates/forward/src/manager.rs:93–101` 直接拿它作为认证密码，没有解析任何保险库引用。该路径还会被明文 JSON 导出：`backend/desktop/src/commands.rs:1252–1255`、`backend/crates/importer/src/json_export.rs:13–16,37–39`。注意当前普通 UI 的认证规则保存还受 A02 阻断；但使用后端认可的 `userpass` 契约通过 IPC 创建的规则、已有规则及同步导入规则仍会进入此明文存储路径，不能因字段名含 ref 而认定加密。

**触发条件：** 在代理管理器保存带认证的代理；或通过现有后端契约保存/接收带认证的动态转发规则。**实际/预期：** 实际密码在普通 SQLite 文本字段，代理列表还在 localStorage 中有完整副本；预期密码只以加密秘密或系统凭据引用持久化。违反本次密码不得明文持久化要求及 UI-037。SQLite 快照通过 `backend/crates/store/src/backup.rs:123–126` 复制这些字段，因此会扩大现存明文副本数量。这里不假设 incognito WebView 的 localStorage 跨进程保留，SQLite 明文落盘已经足以确定问题。

**验证方式：** 仅在新建隔离 profile 使用随机测试密码保存代理，直接读取该测试 SQLite 的 `setting.value_json`；动态转发用 `userpass` 测试输入查询 `port_forward.socks_password_ref`。不能读取真实配置来验证。

### A02 — 应修复：动态 SOCKS 用户名密码认证的前后端枚举不一致，界面不能保存该配置

**证据链：** `frontend/src/types/ipc.ts:361` 定义 `"user_pass"`，`frontend/src/components/PortForwardModal.tsx:132,151–153` 按该值生成输入，经 `frontend/src/stores/forwardStore.ts:58–65` 调用创建/更新。`backend/desktop/src/commands.rs:965–980` 接收 `PortForwardRuleInput`，其 `socks_auth` 在 `backend/crates/core-domain/src/entities.rs:354` 为 `SocksAuth`；`value_objects.rs:262–266` 使用 serde snake_case 的 `Userpass`，实际线值为 `"userpass"`，没有 `user_pass` 别名。

**触发条件：** 新建或编辑动态规则，选择用户名口令认证并保存。**实际/预期：** 实际在进入业务服务前 IPC 反序列化失败；预期保存成功并实际验证认证。已有 `userpass` 规则回到编辑界面时也不匹配前端条件，密码字段处理错误。影响 UI-031。

**验证方式：** 隔离应用通过界面保存认证规则，核对传入 JSON 和 Tauri 错误；对照后端枚举的 serde 值。

### A03 — 应修复：动态 SOCKS 在目标通道尚未建立时就返回 CONNECT 成功

**证据链：** `backend/crates/forward/src/socks5.rs:192–200` 在解析目标后立即发送 SOCKS REP=0 成功。调用方 `backend/crates/forward/src/manager.rs:274–292` 在该函数返回之后才调用 `open_direct_tcpip`；`:301–307` 若目标建连失败，仅记录日志并结束任务，没有向客户端发送对应失败回复。前端启动规则的结果和状态只表示监听成功，实际每次目标连接的失败无法正确通过 SOCKS 协议反馈。

**触发条件：** SOCKS 客户端请求不可达或被 SSH 服务端拒绝的回环测试目标。**实际/预期：** 实际先获成功，再连接关闭；预期目标通道建立后才返回成功，失败返回相应 SOCKS 错误。影响 UI-031 的真实结果和失败分支。

**验证方式：** 在隔离 SSH 环境通过动态代理连接一个无监听的测试端口，记录 SOCKS 回复字节及随后 SSH 通道失败。

### A04 — 应修复：本地和动态转发监听不随所属 SSH 连接断开释放，仍显示 Listening

**证据链：** `backend/crates/forward/src/manager.rs:179–190` 只在远端转发分支订阅连接关闭；本地/动态分支 `:205–226` 创建监听，`:230–310` 长期接受连接，失败子任务仅写日志。其 `RunningForward` 保留在 `running`，只有 `stop_rule/stop_all`（`:340–363`）移除。关闭 SSH 的 IPC `backend/desktop/src/commands.rs:403–412` 仅清理 SFTP 并断开 SSH，没有关闭所属转发。前端关闭标签 `frontend/src/stores/terminalStore.ts:800–820` 同样没有停止转发。`frontend/src/stores/forwardStore.ts:75–84` 又依赖 Listening 决定当前规则是否运行。

**触发条件：** 手动启动本地或动态规则后关闭 SSH 标签，或 SSH 连接被动断开。**实际/预期：** 实际本地端口继续占用，状态仍为 Listening，新连接接入后才在已失效 SSH 通道处失败；预期释放监听或明确标为连接失效，并按规则实际处理重连。该缺陷不依赖是否允许已有转发连接在点击停止后继续，本项仅判断已断开 SSH 的监听生命周期。影响 UI-009、UI-031、UI-049。

**验证方式：** 使用回环测试监听启动两种规则，关闭所属 SSH 标签，核对应用仍存活时端口是否释放及 `forward_list_statuses` 是否改变。

### A05 — 应修复：JSON/.osvault 备份无法完整恢复，非会话实体被忽略，外键引用可能直接导致恢复失败

**证据链：** `backend/desktop/src/commands.rs:1246–1253,1265–1272` 导出 sessions、groups、snippets、port_forwards；`backend/crates/importer/src/json_export.rs:9–16` 归档保存四类实体，但没有 credential、ssh_key、secret 或 vault。两种恢复预览在 `backend/desktop/src/commands.rs:1286–1321,1339–1373` 都只消费 `bundle.sessions`，丢弃另外三类实体。预览候选只携带会话，确认导入 `:1203–1239` 不恢复归档里的分组、片段和独立转发。恢复还直接保留原 group_id/credential_id/ssh_key_id（`:1290,1297–1298,1343,1350–1351`）。`backend/crates/store/migrations/001_init.sql:46,53–54` 为这些列设置外键，`backend/crates/store/src/open.rs:63` 启用外键。

**触发条件：** 将包含分组或已保存凭据/私钥会话的备份导入全新 profile；或恢复含片段、独立转发的无外键会话备份。**实际/预期：** 前一种情况会引用未导入/根本未归档的实体，提交失败；后一种即使会话导入成功，也丢失归档中明确包含的片段/分组/转发。预期备份可回环恢复其承诺的数据，必要依赖正确导入并重映射引用，不能把会话数成功当完整恢复。影响 UI-035、UI-045。

**验证方式：** 在测试 profile 创建分组、密码会话、私钥会话、片段和独立规则，分别导出两种格式；导入两个新隔离 profile，比较实体计数、引用和测试会话凭据可用性。

### A06 — 应修复：OpenSSH 导入读到了 IdentityFile/ProxyJump/三类转发，却在生成会话时丢弃

**证据链：** `backend/crates/importer/src/openssh.rs:63–77` 解析 IdentityFile、ProxyJump、LocalForward/RemoteForward/DynamicForward。`:106–109` 只用 IdentityFile 把认证方式设为 PublicKey，`:118–129` 生成 SessionInput 时既没有 ssh_key_id、私钥导入信息，也没有 proxy_jump_json 或转发列表。`backend/desktop/src/commands.rs:1094–1100` 直接使用该转换结果；`:1214–1216` 的后续导入仅尝试从 protocol_options_json 提取 FinalShell 嵌入转发，不可能恢复这些已丢数据。`backend/crates/app-core/src/connection_service.rs:234–243` 只有 ssh_key_id 才解析私钥，生成的 PublicKey 会话最终在 `backend/crates/ssh/src/connection.rs:276–279` 报缺少有效私钥。

**触发条件：** 导入带 IdentityFile、ProxyJump 或转发指令的 OpenSSH 配置。**实际/预期：** 实际显示会话导入成功，但密钥认证不可用，跳板连接变成直连，转发未建立；这些已识别指令也不产生丢弃警告。预期转换成可用配置，或预览明确报告需要补录/不支持。影响 UI-035，并涉及 UI-002、UI-004、UI-031。

**验证方式：** 使用不含真实私钥路径的合成 OpenSSH 文本预览，核对候选的 ssh_key_id/proxy_jump_json/protocol_options_json；隔离导入后比较保存会话和转发列表。无需读取用户 .ssh。

### A07 — 应修复：导入冲突检查不处理同一批输入内部的重复项

**证据链：** `backend/crates/importer/src/preview.rs:54–60` 对每个候选仅查最初传入的 existing_sessions；`:124–130` 将未命中的候选全部设为 Create，没有维护本批已接受的身份。`backend/desktop/src/commands.rs:1208–1217` 随后逐个创建，session 表也没有 host/port/username 的唯一约束（`backend/crates/store/migrations/001_init.sql:44–85`）。

**触发条件：** 空测试 profile 导入一个包含两条相同协议/主机/端口/用户名的配置，策略选择跳过已有。**实际/预期：** 实际预览显示新建两个，确认后创建重复会话；预期所选冲突策略也覆盖批次内冲突，或明确将其报告为重复。影响 UI-035。

**验证方式：** 合成两条完全相同的 FinalShell/归档会话输入并预览，核对 new_count 和 action；在隔离 profile 提交后查重复数量。

### A08 — 应修复：同步冲突副本没有恢复/解决入口，产生冲突的记录会永久停止上传

**证据链：** `backend/crates/app-core/src/sync_service.rs:493–520` 备份本地冲突快照并应用远端数据；`:483–491` 每轮读取所有 `resolved_at IS NULL` 的冲突 ID；`:529–530` 无条件跳过这些 ID 的上传。`backend/crates/app-core/src/sync_codec.rs:1197–1213` 插入冲突，未设置 resolved_at。全量搜索桌面命令、app-core 和前端未发现列出/恢复/解决冲突或更新 resolved_at 的业务路径。界面 `frontend/src/components/SyncSettingsModal.tsx:175–186` 只有冲突计数，而 `SyncStatusWidget.tsx:145` 仍提示前往设置合并。所谓清除本地状态的 `frontend/src/stores/syncStore.ts:129–135` 只调用 sync_logout；`backend/crates/app-core/src/sync_service.rs:250–265` 也不清除 sync_conflict。

**触发条件：** 两个测试设备离线修改同一记录后同步产生冲突，再在当前设备修改该记录并再次同步。**实际/预期：** 实际本地旧内容仅存在隐藏数据库快照，用户无法在产品中恢复/合并，后续同 ID 的修改永远不上传；预期提供可用冲突解决路径，解决后恢复同步。影响 UI-042。

**验证方式：** 仅在两个新测试 profile 与回环同步服务制造冲突，记录 conflict 表、业务实体和二次修改后的服务端 revision；不能以冲突数显示或“已保留”文案当可恢复通过。

### A09 — 应修复：监控采样失败或数据源缺失会被渲染为实时零值/旧值，没有采集失败状态

**证据链：** `backend/crates/monitor/src/engine.rs:71–87` 只要 SSH exec 返回 Ok，就忽略 exit_code 和 stderr，把 stdout 解析为当前时间指标并发布；`:89–101` 真正 exec 错误仅写日志，没有状态事件。`backend/crates/monitor/src/parser.rs:76–102,118–123` 缺少数据时填 0；空 section 的解析也返回零。前端 `frontend/src/stores/monitorStore.ts:125–136` 只轮询已有快照，失败只写 console，不清理旧值或设置 error；`frontend/src/components/MonitorDashboard.tsx:146–147,188` 显示实时监控和 0.0%，没有检验 timestamp_ms 是否过期。

**触发条件：** 测试环境中 /proc 不可读/采集命令无效但 SSH exec 正常返回；或曾成功采样后 exec 持续失败而 SSH 会话仍在。**实际/预期：** 实际显示新的零值或一直保留最后一次值，并继续标为实时监控；预期将采集错误、无数据和正常零负载区分。影响 UI-029。

**验证方式：** 在受控 SSH 环境令采集命令返回非零/无有效 section，另在取得快照后拒绝后续 exec 通道，核对 UI 与快照时间。无须真实生产主机。

### A10 — 应修复：容器异步请求没有会话归属校验，切换主机会显示旧主机结果，并把旧容器 ID 发给新主机

**证据链：** `frontend/src/components/ServerSidebar.tsx:90–95` 连接改变即调用全局容器 store 的 probe；`frontend/src/stores/containerStore.ts:53–75` 在 await 后直接覆盖 runtime 并调用使用当前全局状态的 reload，`:87–96` reload 捕获当时的 connId/runtime，`:146–148` 返回后直接覆盖全局 containers，没有请求代次或连接校验。`frontend/src/components/ContainerWorkspace.tsx:84–86` 直接使用该全局列表；其操作 `:140–145` 调用 store.action，后者在 `containerStore.ts:152–157` 使用当前全局 connId 和传入旧容器 ID 执行命令。

**触发条件：** A 主机容器列表查询较慢，查询未返回时切到 B，B 查询已完成后 A 的迟到响应到达。**实际/预期：** 实际 B 界面可被 A 列表覆盖，点击动作会向 B 发送 A 的容器 ID；若两个运行时路径不同，迟到 probe 还可能在 B 上使用 A 的路径。预期结果和动作都绑定发起请求的连接。这里不推断一定会删除或停止 B 的某个容器，只认定请求目标与所显示数据失配。涉及 UI-029/UI-030 与容器当前界面。

**验证方式：** 使用两个隔离测试 SSH 服务，分别返回不同标记的 docker 列表；让 A 的查询延迟，切换到 B，记录界面列表及动作最终使用的 connId。

### A11 — 应修复：AI 联通测试会把流式错误、空 200 响应或中断当作连接成功并记录已验证

**证据链：** `frontend/src/components/settings/ai/AiModelSettings.tsx:199–205` 调用已保存档案测试，服务 `backend/crates/app-core/src/ai_service.rs:212–234` 调用真实 HttpProfileTester，result.ok 即写 verified_at。`backend/crates/ai/src/provider/openai_compat.rs:101–107,125–129` 遇 EOF/网络流错误/错误事件直接结束流，`:89–90` 仅检查 HTTP 成功；`backend/crates/ai/src/provider/mod.rs:63–74` 流结束后无条件返回 `Ok(accumulator.finish())`，没有要求有效输出或 Finish。`backend/crates/ai/src/service.rs:50–64` 丢弃 completion 内容，把该 Ok 转为连接成功。Anthropic/Gemini 的流错误也有相同直接结束行为。

**触发条件：** 本地测试端返回 HTTP 200 空响应、非 SSE 页面、`data: {"error":...}`，或响应流中途失败。**实际/预期：** 实际可显示连接成功并标记验证时间；预期只有取得有效模型结果并正常完成才成功，错误应明确失败。违反 UI-043 和禁止假成功要求。

**验证方式：** 对新建测试档案使用回环 HTTP 服务逐项返回上述响应，检查 ProviderTestResult.ok、verified_at 和界面状态；不能以收到 2xx 证明模型可用。

### A12 — 应修复：AI 测试的 15 秒超时只保护响应头阶段，流式响应体可永久等待

**证据链：** `backend/crates/ai/src/service.rs:14` 定义 15 秒测试超时，`:49–56` 没有给整个 complete 包外层 timeout。`backend/crates/ai/src/provider/mod.rs:147–151` HTTP client 仅设 connect_timeout，`:167` 的 timeout 仅包 builder.send；响应体读取 `backend/crates/ai/src/provider/openai_compat.rs:101`、`anthropic.rs:112`、`gemini.rs:108` 直接 await bytes.next。`frontend/src/stores/aiSettingsStore.ts:193–214` 要等 IPC 返回才清除 testingProfileId。

**触发条件：** 回环测试端立即返回 200 SSE 响应头，之后保持连接但不发送完整响应。**实际/预期：** 实际测试可一直处于 testing，超过配置的 15 秒；预期超时覆盖整个测试，并返回明确失败。影响 UI-043。

**验证方式：** 仅用本地服务返回响应头后保持 body 不结束，观察 15 秒之后 IPC 是否结束；测试应设独立外部截止时间以便清理。

### A13 — 应修复：备份保留数量前后端使用不同设置键，用户配置不起作用

**证据链：** `frontend/src/updater/store.ts:35,82,280–281` 读取和保存 `user/update.backup_keep`；`backend/crates/app-core/src/app_services.rs:38,116–123` 却读取 `user/update.backupKeep`，缺失则取 5。迁移及启动后快照裁剪还直接使用默认 5（`app_services.rs:225`、`backend/crates/store/src/migrator.rs:154` 的 opts 来自 `app_services.rs:80` 默认设置）。

**触发条件：** 用户将自动备份保留数设为 5 以外，例如 20，再产生自动快照。**实际/预期：** 界面可重启显示保存的 20，但实际仍按默认 5 裁剪，可能提前删除用户期待保留的恢复点；预期实际裁剪遵循设置。影响 UI-045 及配置真实使用要求。

**验证方式：** 在隔离 profile 保存保留数 20，生成超过 5 份受管理的自动测试快照，检查设置键和保留结果；不操作用户备份目录。

### A14 — 应修复：手动备份失败被 store 吞掉，界面仍显示成功路径

**证据链：** `frontend/src/updater/store.ts:314–317` 对 api.backupNow 的失败仅 console.error，然后继续 refreshRuntime 并正常 resolve；`frontend/src/updater/AboutUpdateTab.tsx:269–272` 的 `.then` 因而仍执行，`:291` 用绿色显示备份目录。后端 `backend/desktop/src/updater.rs:379–388` 本来正确返回备份错误，但未传回用户界面。

**触发条件：** 隔离备份目录不可写或 SQLite 快照失败，而 runtime 查询仍成功。**实际/预期：** 实际没有新快照却展示绿色备份路径，无失败反馈；预期失败明确展示，成功反馈绑定实际新建的快照。影响 UI-045。

**验证方式：** 在新测试 profile 制造可恢复的备份写入失败，点击立即备份，核对后端错误、文件数量和界面反馈，不改变真实目录权限。

## 凭据持久化路径核对

| 路径 | 实际持久化机制与本轮判断 |
|---|---|
| SSH/Telnet/RDP 登录密码与键盘交互凭据 | `credential_create` → `SessionService::create_credential`（`session_service.rs:178–231`）→ `VaultManager::encrypt_secret` → `CredentialRepo::create`（`credential.rs:85–112`）同事务写密文 secret 和引用。未发现此正常路径把秘密原文写 SQLite。 |
| SSH 私钥及私钥口令 | `ssh_key_import` → `session_service.rs:294,335–401` 解析私钥，私钥进入 encrypt_secret；口令通过 create_credential 保存，`ssh_key` 表保存 secret_id/passphrase_credential_id（`store/.../ssh_key.rs:91–106`）。文件选择只读用户明确选择的文件（`desktop/src/ssh_keys.rs:17–41,54–66`），本轮未调用。 |
| 临时连接覆盖 | `ConnectOverrides` 进入 connection_service/protocol runtime，前端 terminalStore 不把 password/passphrase 加入标签或 localStorage。补录私钥口令在认证成功后通过 `ssh_key_set_passphrase` 加密保存（`ConnectAuthModal.tsx:64–70`、`session_service.rs:427–473`）。未发现默认日志打印这些值。 |
| 主保险库密码/密钥槽 | `vault_service.rs:85–128,149–160` 使用随机 VaultKey 和密码包裹槽；`vault/key_slot.rs:53–59` 派生 KEK 并 AEAD 包裹。没有持久化主密码原文。主保险库 remember_in_keychain 当前被忽略，status 明确 false（`vault_service.rs:76–78,88,104`）；不能把 AI keyring 实现误当主保险库系统钥匙串已接通。 |
| 代理密码 | 普通 JSON 设置和 renderer localStorage 明文，见 A01；读取代理后直接交给 `ssh/proxy.rs:42–47,110–123` 使用，并未在使用前解密。 |
| 动态转发 SOCKS 密码 | `socks_password_ref` 实际为密码原文，普通字段落盘，明文 JSON 归档也包含；见 A01/A02。同步网络信封会加密，但不改变本地字段本身明文的事实。冲突 local_snapshot_json 也可包含该字段（`sync_codec.rs:593,1175–1205`）。 |
| 同步账号密码与令牌 | 登录/注册密码经 IPC 的 Zeroizing（`commands.rs:1456,1471`）进入请求和远端密钥槽准备；访问/刷新令牌只缓存内存（`sync_service.rs:302–305`），初始化会删除旧版遗留敏感 setting（`:48–53`）。`sync-client/client.rs:34–59,69–85` 拒绝远端明文 HTTP，禁止重定向，本地回环禁代理。未发现当前正常路径持久化账号密码或令牌原文。 |
| AI API Key | `AiModelSettings` → ai_config_save → `AiService` → `ApiKeyStore`（`ai_service.rs:107–108,134–136`）。系统 keyring 服务 `openshell.ai`（`ai/secrets/keyring_store.rs:9,49–65`）；不可用时 `file_store.rs:81–90,109–121` 写保险库 AEAD 密文信封。SQLite AI profile 不保存 key；配置读取只返回 has_api_key。未发现这一存储链写原文明文。真实 OS keyring 未访问。 |
| RDP 系统凭据副本 | `commands.rs:2294–2304` 使用 cmdkey 保存 TERMSRV 凭据，密码经命令行参数提交，输出被置空。没有 RDP 文件中的明文密码；但本轮不对系统凭据 ACL、外部进程参数可见性或系统清理结果作动态安全结论。源码未见自动删除该 cmdkey 条目的路径。 |
| JSON/.osvault 导出与 SQLite 快照 | `.osvault` 经 `seal_package` 加密；JSON 直接序列化；SQLite `VACUUM INTO` 是未整体加密的 DB 副本。前述安全 secret 保持密文，但 A01 字段仍为明文。两类归档缺少正常密码/私钥秘密实体，恢复问题见 A05。 |

上述“未发现原文”只评价已追踪写入路径，不证明真实文件或日志不存在历史遗留秘密。任意用户命令、notes、shell history、远程容器日志和远端进程参数可能包含用户自行输入的秘密，本轮未将通用文本字段视为可以无损自动识别所有秘密，也未读取这些真实内容。

## 实际审查边界与 declined-to-judge

- 监控/进程：已追踪 MonitorDashboard/ServerSidebar → monitorStore → IPC → MonitorEngine → SSH exec → parser/history → UI，及 SIGTERM/SIGKILL 的命令、PID 类型、非零退出码处理。未执行远程 kill。没有因缺少某种远端 OS 而报告功能缺失；A09 依据当前失败分支与数据状态处理。
- 容器：已追踪 probe、列表、inspect、logs、start/stop/restart 到 ssh_exec/open_exec 真实执行链；没有把任意容器环境缺少 Docker/Podman 判为代码缺失。没有对远端返回的运行时路径被恶意控制后的命令注入风险作独立裁决，因为该 SSH 主机已是被授权执行命令的一方；A10 仅判断跨连接状态归属。
- 三类转发：已读取前端输入/状态、IPC、PortForwardRepo、ForwardManager、本地 direct-tcpip、远端 tcpip_forward/cancel 和 server_channel_open_forwarded_tcpip、动态 SOCKS 协商/认证/目标连接。认证用户名密码实际比较存在，非回环暴露校验存在；没有沿用旧注释声称任意密码放行。未动态验证 TCP 数据往返、服务器 GatewayPorts 策略或停止后已建立子连接应否立即中断；最后一项未在现有需求明确规定，未作为发现。
- 导入/归档：已追踪 OpenSSH/FinalShell 解析、冲突候选、三种策略、确认写入、内嵌转发，以及 JSON/.osvault 序列化与解密恢复入口。未运行含真实密钥路径的导入，未解密用户归档。未以单元测试空 bundle 的 roundtrip 推断业务实体恢复完整。
- 同步：已审查登录/注册/令牌刷新/登出、远端密钥槽、业务记录 AEAD、依赖顺序应用、增量游标、冲突备份和前端显示。未连接真实或本地同步服务，没有动态证明两个 profile 的业务还原通过。当前 `sync_vault.rs:115–160` 存在新 profile 从远端密码槽导入同一密钥及业务 secret 解密所需链路；不将 README 的历史“尚需接通”当作当前缺失证据。已有本地保险库密钥不同会明确拒绝（`:122–131`）；这是防止静默替换本地密钥的保护，本轮未将它当作假同步，也未评价产品是否必须提供跨独立保险库合并。
- AI：已追踪功能开关、厂商目录、档案 CRUD、激活、密钥 keyring/加密文件、三种 HTTP provider 的联通测试返回链。未访问真实厂商、API Key、OS 凭据库。没有把当前需求外的完整 AI 终端代理执行器视为缺失。API Key 在系统 keyring 可用性变化时的迁移/冗余副本策略未作完整生命周期证明，不给出绝无遗留的结论。
- 备份/迁移：已检查 VACUUM INTO 一致性快照、自动/手动保留差异、按版本独立事务迁移、迁移前备份失败拒绝继续、迁移失败关闭连接后恢复快照、恢复提示与手动备份界面。未执行数据库迁移、破坏测试或真实安装升级；未判断 OS 层文件 ACL/断电后的耐久性。SQLite 备份原文不是漏洞本身，A01 的原文秘密进入其中才是本轮确定问题。
- `SavePolicy::Ask/Never` 与 PromptPolicy 语义：注意到 credential repo 不依据该元数据改变加密落盘/解析行为，但当前普通前端没有可追踪的 Ask/Never 选择入口；未把这一未暴露策略作为完整 UI 功能缺失计入新发现，需主审决定是否纳入 IPC 契约验收。
- 本轮不重复第一轮串口、终端编码、SFTP 和 RDP 发现。没有发现新的产品变更，也没有做修复。

## 结论

第二轮新增 14 项源码可证实的问题，其中 A01 触及密码明文持久化硬要求，其余涉及配置不可用、错误被报告为成功、恢复数据不完整、同步冲突无法解决及跨连接状态串用。已审查代码链路不等同动态验收通过；本补充报告不能替代受控环境中的真实连接、数据一致性和重启持久化验证。
