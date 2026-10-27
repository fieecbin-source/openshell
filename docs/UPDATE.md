# 更新机制说明

本文描述 OpenShell 桌面客户端「检查 → 下载 → 校验 → 安装」的完整流程、可替换的数据源设计、
以及围绕「更新不丢数据」做的保护措施。发布操作见 [RELEASING.md](./RELEASING.md)。

---

## 1. 分层结构

```
React UI（src/updater/*）
   │ 只依赖统一契约：UpdateCheckResult / UpdateProgress / 错误码
   ▼
Tauri 命令（backend/desktop/src/updater.rs）
   │ 参数校验 + IPC 错误映射
   ▼
openshell-updater（backend/crates/updater）
   ├── source/   数据源：GitHub Release、静态清单 latest.json、服务端占位
   ├── cache/    6h TTL + ETag 条件请求
   ├── policy/   跳过版本、稍后提醒、强制更新
   ├── asset/    平台/架构/扩展名匹配
   ├── notes     说明的 Markdown → 消毒 HTML
   ├── download/ Range 断点续传 + 进度 + 磁盘预检
   ├── verify/   sha256（签名校验预留）
   └── install/  自研安装策略（+ 插件策略空实现位）
```

**数据源可替换**：`UpdateSource` 是唯一扩展点，新增数据源只需实现
`fetch(channel, etag) -> SourceOutcome`，`SourceChain` 会按顺序回退。
未来接入自有服务端时，只需启用 `source::server::ServerSource`，UI 与流程完全不变。

---

## 2. 检测

| 关注点 | 实现 |
| --- | --- |
| 稳定通道 | `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`，草稿与预发布天然被排除 |
| 测试通道 | `GET .../releases?per_page=30`，筛 `prerelease && !draft` 取 semver 最大者；无预发布则回落稳定版 |
| 版本比较 | `semver` 归一化（去 `v` 前缀）；`1.10.0 > 1.9.0`；`1.0.0-rc.1 < 1.0.0` |
| 缓存 | 6 小时内重复检查不发请求；过期后带 `If-None-Match`，304 复用旧结果 |
| 限流 | 解析 `x-ratelimit-remaining/reset`、`retry-after`，403/429 → `RATE_LIMITED`（附重试时间） |
| 超时重试 | 连接 10s / 总 20s；指数退避 3 次（400ms → 1.2s → 3.6s，带抖动），仅对网络/5xx/429 重试 |
| 代理 | 默认跟随系统代理；可选「仅环境变量」「直连」「自定义」（`http/https/socks5/socks5h`） |
| 多源回退 | `[GitHub, 备用清单源, 服务端占位]`；可重试错误或畸形响应才回退，全部失败才报检查失败 |

### 安装包命名规范

```
OpenShell-<version>-<platform>-<arch>.<ext>
   platform ∈ windows | macos | linux
   arch     ∈ x86_64 | aarch64 | universal（macOS 通用包）
   ext      优先级：windows .exe → .msi；macos .dmg；linux .AppImage → .deb
```

匹配失败不会让「检查更新」失败：仍展示版本与说明，只把「立即更新」换成「手动下载」。

---

## 3. 下载与校验

1. 磁盘预检：剩余空间 ≥ 待下载体积 × 1.2 + 64 MB，否则报 `UPDATE_INSUFFICIENT_DISK`。
2. 写入 `<数据目录>/updater/downloads/<name>.part`；已有 `.part` 时发 `Range: bytes=<n>-` 续传，
   服务端忽略 Range（返回 200）则清空重下。
3. 进度通过 Tauri `Channel<DownloadProgress>` 推送：已下载 / 总量 / 百分比 / 速度 / 阶段。
4. 取消：置位令牌，删除 `.part`，状态回到「发现新版本」。
5. 下载完成 → phase 变为 `verifying` → 流式计算 sha256 与清单比对。
   - 不匹配：删除文件并报 `UPDATE_CHECKSUM_MISMATCH`（下次不会续传到坏文件上）。
6. 安装前再校验一次（防止文件在磁盘上被替换或截断）。

> 只接受 HTTPS，且 host 必须命中白名单（`api.github.com`、`github.com`、
> `objects.githubusercontent.com`、`release-assets.githubusercontent.com`、
> `raw.githubusercontent.com`、`cdn.jsdelivr.net`）或用户配置的镜像域名；
> 跟随重定向时逐跳复核，最多 5 跳。

---

## 4. 安装

**先备份 → 再拉起安装器 → 应用退出**，顺序不可颠倒：

| 平台 | 行为 |
| --- | --- |
| Windows | NSIS `Setup.exe /S` 静默安装（当前用户级，无 UAC）；`.msi` 走 `msiexec /i … /qn /norestart`（需提权，失败提示手动） |
| macOS | 打开 `.dmg`，提示把 App 拖入「应用程序」（未公证的包无法静默替换） |
| Linux | `.AppImage` 就地替换（先备份旧文件为 `.old` 再复制、补 755）后重启；`.deb` 用 `pkexec dpkg -i`，无 polkit 时提示手动 |

拿不到数据快照时**拒绝安装**（`InstallStrategy::install` 的硬约束）。
`PluginUpdater`（`tauri-plugin-updater`）保留为空实现位：`is_enabled() == false`，
永远不会被选中，也不引入任何签名密钥依赖。

---

## 5. UI 状态机

```
idle → checking → latest | available | check_failed
available → downloading → verifying → ready
downloading → download_failed | (取消) available
verifying → verify_failed → available
ready → (安装器启动失败) install_failed → 重试 / 手动下载
```

* 顶栏图标右上角红点表示「有新版本」，强制更新时改为红底 `!`；
* 下载中关闭弹窗 = 「后台继续下载」，不打断任务；
* 强制更新时隐藏「跳过此版本 / 稍后提醒」，并说明「升级前会自动备份数据」；
* 后台自动检查失败**不会**把已有「发现新版本」的界面打回错误态。

状态归约逻辑在 `frontend/src/updater/state.ts`（纯函数，离线单测），
中文文案集中在 `frontend/src/updater/copy.ts`（CI 强制检查）。

---

## 6. 数据保护

| 措施 | 说明 |
| --- | --- |
| 目录隔离 | 数据只在 `app_data_dir()`；解析失败或落在安装目录内时**拒绝启动**并提示 |
| schema 版本 | 当前 v2；迁移在 `TransactionBehavior::Immediate` 事务内按顺序执行 |
| 迁移前快照 | `VACUUM INTO backups/pre-migration-<from>-to-<to>-<ts>.db`（WAL 下也是一致副本） |
| 失败回滚 | 迁移出错 → 回滚事务 → 关闭连接 → 用快照覆盖数据库（清理 `-wal/-shm`）→ 以旧 schema 启动 |
| 恢复提示 | 前端横幅显示快照路径与时间，用户确认后继续使用 |
| 安装前快照 | 点击「立即重启安装」→ `pre-install` 快照成功才退出安装 |
| 降级保护 | 数据版本高于客户端时返回 `SCHEMA_NEWER_THAN_APP`，绝不覆盖 |
| 保留策略 | 自动快照保留最近 5 份（可配 1-20）；`manual` 快照与 `.osvault` 永不自动删除 |

用户可随时在「设置 → 关于与更新 → 诊断与备份」手动备份或打开备份目录。

---

## 7. Release 资产约定

每个 Release 附带三份元数据（全部为可选，但缺 `sha256` 时禁止自动安装）：

### `SHA256SUMS.txt`

```
<64 位 hex>  OpenShell-1.1.0-windows-x86_64.exe
<64 位 hex>  OpenShell-1.1.0-macos-universal.dmg
```

### `update-meta.json`

```json
{
  "mandatory": false,
  "min_supported_version": "1.0.0",
  "notes": "覆盖 Release 正文的精简说明（可选）",
  "assets": [{ "name": "OpenShell-1.1.0-windows-x86_64.exe", "sha256": "…" }]
}
```

当 `mandatory = true`，或当前版本低于 `min_supported_version`，客户端进入强制更新模式。

### `latest.json`（备用检测源）

```json
{
  "version": "1.1.0",
  "tag": "v1.1.0",
  "name": "OpenShell 1.1.0",
  "published_at": "2026-10-27T00:00:00Z",
  "mandatory": false,
  "min_supported_version": "1.0.0",
  "release_page": "https://github.com/fieecbin-source/openshell/releases",
  "assets": [
    {
      "name": "OpenShell-1.1.0-windows-x86_64.exe",
      "url": "https://github.com/…/releases/download/v1.1.0/OpenShell-1.1.0-windows-x86_64.exe",
      "size": 18432123,
      "sha256": "…",
      "platform": "windows",
      "arch": "x86_64"
    }
  ]
}
```

发布后 `latest.json` 会被同步到 `updater-meta` 分支，默认备用源地址即
`https://cdn.jsdelivr.net/gh/fieecbin-source/openshell/updater/latest.json`，
用户也可在设置里填自建镜像地址。

---

## 8. 完整性保障与已知限制

**能防住**：传输损坏、镜像投毒（哈希不符）、中途被替换的本地文件（安装前二次校验）、
明文 HTTP 劫持（只允许 HTTPS + 域名白名单）。

**防不住**：仓库或发布账号被入侵 —— `SHA256SUMS.txt` 与安装包托管在同一位置，
攻击者可以同时替换两者。要彻底解决需要引入独立渠道的签名（minisign / 平台代码签名），
`verify::SignatureVerifier` 已预留实现位，当前 `is_enabled() == false`。

**系统层面提示**：

- Windows 未做代码签名 → SmartScreen 可能提示「未知发布者」，可选择「更多信息 → 仍要运行」；
- macOS 未公证 → 首次打开需「右键 → 打开」，或在「系统设置 → 隐私与安全性」中允许。

---

## 9. FAQ

**Q：更新会删掉我的连接和密钥吗？**
不会。数据全部在用户数据目录，与安装目录分离；安装前还会自动拍一份快照。

**Q：为什么顶栏没有红点？**
可能已是最新、上一次检查失败，或你跳过了该版本（手动检查仍会提示）。

**Q：公司网络连不上 GitHub 怎么办？**
在「设置 → 关于与更新」里填「备用检测源」（`latest.json` 地址）与「下载镜像」前缀；
仍不通时把系统代理设为客户端代理，或配置 `HTTPS_PROXY` 后选择「仅环境变量」。

**Q：下载卡在 100% 不动？**
那是校验阶段（逐字节比对 sha256），大安装包通常需要几秒。

**Q：安装失败怎么办？**
弹窗里有「重试 / 打开下载目录 / 打开日志」三个入口；日志在 `<数据目录>/updater/updater.log`。

---

## 10. 备份保护（如实说明）

### 10.1 现状：明文快照

`backups/` 下的自动快照由 `VACUUM INTO` 生成，是**未加密的 SQLite 文件**，
内容与主库 `openshell.db` 同级：连接配置、分组、会话卡片，
以及**加密后的**密钥槽位（vault 主密钥在系统钥匙串里，不在数据库内）。

因此：

* 快照里**没有**明文密码或私钥 —— 密钥槽位是用主密码派生密钥加密后的密文；
* 但快照里**有**连接元数据（主机、端口、用户名、分组结构），泄露等同于泄露「你在连什么」；
* 快照与主库同级保护（同一用户数据目录），本阶段**未**单独加密。

### 10.2 目录与文件权限

| 平台 | 措施 |
| --- | --- |
| Linux / macOS | 备份目录 `chmod 0700`、快照文件 `chmod 0600`（创建后立即收紧；失败只记日志，不中断备份） |
| Windows | 依赖用户数据目录 `%APPDATA%\OpenShell` 的继承 ACL：默认仅当前用户与 Administrators 可访问。本阶段**未**额外写入 ACL，也未用 `icacls` 收窄 |

> Windows 说明：若将来允许把数据目录改到 `C:\ProgramData` 或共享盘，继承 ACL 会变宽，
> 那种场景必须显式设置 ACL —— 目前不支持把数据目录移到此类位置。

### 10.3 保留策略不会误删用户数据

`prune()` 只处理同时满足以下条件的文件：

1. 位于 `backups/` 目录内；
2. 文件名以 `openshell_` 开头；
3. 中间段为 `pre-migration` / `pre-install` / `post-upgrade` 之一；
4. 扩展名为 `.db`。

手动导出的 `.osvault`、用户自己放进去的文件、其他目录的文件都不会被删除。
默认保留最近 5 份，可在设置中配置 1–20。

### 10.4 后续加密方案（下一版待办，本阶段不实现）

| 方案 | 密钥来源 | 优点 | 代价 / 丢失后果 |
| --- | --- | --- | --- |
| A. 系统钥匙串随机密钥 | 首次运行生成 32 字节随机密钥，存 Keychain / Credential Manager / Secret Service | 用户零感知，快照自动加密；与主密码解耦 | 换机或重装系统后钥匙串丢失 → 旧快照无法解密（主库仍在，影响有限） |
| B. 用户备份口令 | 导出时自设口令，scrypt/PBKDF2 派生 | 可跨机器恢复，语义清晰 | 忘记口令 = 快照永久不可解；需要口令输入 UI 与强度校验 |
| C. 复用 vault 主密码 | 用解锁时的派生密钥加密快照 | 不新增密钥管理 | 自动更新前的快照发生在用户可能未解锁的时刻，**拿不到密钥** → 无法覆盖自动备份场景 |

推荐组合：**A 用于自动快照 + B 用于手动导出**。
现有的加密导出/导入（`.osvault`，`vault::package::seal_package`，口令派生 + AEAD）本阶段未改动。

---

## 11. TOCTOU：校验与启动之间的时间窗

```
读取文件 → sha256（流式全量校验） → 立即 spawn 安装器 → 800ms 后退出应用
```

* 中间**不**插入其它 await IO、不弹确认框、不重新读取清单；
* 安装包只存在于用户数据目录下的 `updater/downloads/`，其权限随用户数据目录
  （Unix 0700 / Windows 继承 ACL），普通用户之外不可写；
* 进程内安装被 `InstallGate` 独占，重复点击不会并行执行两次安装。

**残余风险（如实说明）**：校验完成到最后一次 `spawn` 之间仍有毫秒级窗口，
同机同用户权限下的恶意进程理论上可在此期间替换文件。本方案不做文件句柄锁定
（Windows 上锁定会阻止安装器自己读取该文件）。要彻底消除需引入独立渠道的签名校验，
属后续版本工作。

---

## 12. 平台差异与兜底

| 场景 | 界面提示 | 兜底操作 | 应用是否退出 |
| --- | --- | --- | --- |
| Windows `.exe`（NSIS） | 下载→校验→「正在启动安装程序」 | 失败时提供「重试 / 打开下载目录 / 打开日志」 | 是（800ms 后） |
| Windows `.msi` | 同上；失败提示「需要管理员权限，可右键以管理员身份运行」 | 打开下载目录手动运行 | 是（成功时） |
| macOS `.dmg` | 「已打开安装镜像：请把 OpenShell 拖入「应用程序」，然后重新启动客户端」 | 安装包保留在下载目录，可再次打开 | **否**（保持运行，避免「点了没反应」） |
| Linux `.AppImage` | 就地替换当前可执行文件后重启 | 目录不可写时提示移动到有写权限的位置 | 是 |
| Linux `.deb` | `pkexec dpkg -i`；失败提示「请在终端执行 sudo dpkg -i …」 | 打开下载目录手动安装 | 是（成功时） |
| 便携版（存在 `openshell.portable`） | 「便携版不支持自动安装：新版已下载到 …，请手动替换程序文件」 | 打开下载目录；数据目录在程序旁，不会被覆盖 | **否** |

文案集中在 `frontend/src/updater/copy.ts` 的 `platform` 分组；
后端提示来自 `install/self_install.rs` 的 `manual_hint` / `fallback_hint` / `portable_hint`。

---

## 13. CSP 与说明渲染

`tauri.conf.json` 的 CSP：

* `script-src 'self'`：不允许内联脚本与外部脚本；
* `img-src 'self' data: blob: https:`：保留远程壁纸能力；
* 说明区用 `dangerouslySetInnerHTML` 渲染，但内容由 Rust 侧 `pulldown-cmark + ammonia` 生成，
  `ALLOWED_TAGS` **不含** `img`（有单测 `img_is_not_allowed` 钉死），
  链接强制 `rel="noopener noreferrer"`，点击由前端拦截后交给系统浏览器。

开发模式（Vite HMR）与打包后的实测结果见 `docs/ACCEPTANCE.md` 的「CSP 实测」小节。
