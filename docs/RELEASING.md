# 发布手册

面向维护者：从「准备发版」到「用户收到更新」的全部步骤。全程不需要 Tauri 升级签名密钥。

每次发布必须递增版本号并新建 GitHub Release。保留旧版本、标签和全部资产，不覆盖同名文件；已发布版本需要修复时另发新版本。更新源分支通过追加提交维护，禁止强制推送。

---

## 0. 一次性准备

| 项目 | 说明 |
| --- | --- |
| `frontend/package.json` 的 `version` | **唯一真源**，其余两处由脚本同步 |
| `CHANGELOG.md` | 必须能查到当前版本的 `## [x.y.z]` 小节 |
| 仓库 slug | 默认 `fieecbin-source/openshell`，用户可在设置中覆盖 |
| `updater-meta` 分支 | 由流水线自动创建并维护，用于 jsDelivr 备用源 |
| 更新签名密钥 | 至少一把 `active` + 一把 `next`；私钥离线保存，仓库只提交 `backend/crates/updater/keys/*.pub` |

---

## 0.1 更新签名密钥生命周期

更新清单使用 Ed25519 分离签名，客户端内置公钥、先验签再校验 sha256（fail-closed）。
仓库里**只允许**出现公钥与文档；私钥不得进入仓库、CI 变量、构建日志或聊天记录。

### 生成（一次性，离线机器）

```bash
node scripts/updater-sign.mjs keygen --id openshell-updater-2026a --out /mnt/offline/openshell-keys
node scripts/updater-sign.mjs keygen --id openshell-updater-2027a --status next --out /mnt/offline/openshell-keys
```

- `<id>.key` 是私钥，必须放在加密磁盘/硬件令牌等离线位置，权限 0600；
- `<id>.pub` 是公钥，复制到 `backend/crates/updater/keys/` 并提交；
- 构建时 `backend/crates/updater/build.rs` 会把该目录下所有 `.pub` 编进客户端；
- **目录为空时客户端拒绝所有自动安装**（报「签名未配置」），这是预期的 fail-closed。

提交的公钥示例：

```
key_id = openshell-updater-2026a
status = active
created = 2026-11-04
public_key = <base64url 32 字节>
```

`status` 语义：`active` 当前密钥、`next` 下一把（提前内置，接受签名）、`revoked` 已吊销（永久拒绝）。

### 每次发版

本地打包产出 `artifacts/update-meta.json` / `latest.json` 后，在**离线签名机**执行。
使用 CI 时，先在联网机器下载对应构建的 Actions 产物，再转移到离线签名机；
CI 草稿仅上传安装包与校验和，不上传未签名清单：

```bash
gh run download <run-id> --name updater-manifests --dir artifacts
```

```bash
node scripts/updater-sign.mjs sign \
  --key /mnt/offline/openshell-keys/openshell-updater-2026a.key \
  --meta artifacts/update-meta.json \
  --out artifacts/update-meta.json.sig \
  --latest artifacts/latest.json
node scripts/updater-sign.mjs verify \
  --meta artifacts/update-meta.json \
  --sig artifacts/update-meta.json.sig
```

签名工具会把 `key_id` 写进 `update-meta.json`、把清单与签名原文内嵌进 `latest.json`，
然后对**写入后的原始字节**签名。把这三个签名后的文件转移回联网机器，
上传到本次新版本的草稿（不加 `--clobber`，同名资产存在时停止检查）：

```bash
gh release upload vX.Y.Z artifacts/update-meta.json artifacts/update-meta.json.sig artifacts/latest.json
```

预发布版本只上传 `update-meta.json` 与 `.sig`，不得上传 `latest.json`。
发布前核对本地验签结果与草稿中的文件名；有问题时停止发布，不覆盖已上传资产。
发布后运行 `node scripts/e2e-upgrade/check-release.mjs --repo fieecbin-source/openshell --tag vX.Y.Z`
检查公开下载与签名链路。

CI 不持有私钥；签名在离线机完成后上传到 Release（草稿阶段）。若未来要流水线自动签名，
应使用独立的签名服务/HSM，且不得把私钥放进仓库 Secret 或构建日志。

### 仅供手动下载安装的发布

尚未内置受信公钥、或暂时无法完成离线签名时，可以发布已验证的安装包与
`SHA256SUMS.txt`，供用户手动下载安装。此模式不属于上面的签名更新发布：

- 在更新日志与 Release 说明中明确标注“仅供手动下载安装，自动安装更新暂不可用”。
- 不上传未签名的 `update-meta.json`、`.sig` 或 `latest.json`；未签名清单仅保留为 Actions 产物。
- 发布前核对所有平台安装包、出厂配置检查与 SHA256；签名链路检查不能标记为通过。
- Release 没有 `latest.json` 时，工作流明确跳过 CDN 更新元数据同步，保留原有通道内容。

未内置受信公钥的客户端会拒绝自动安装。恢复签名更新通道需要先内置维护者提供的
受信公钥、重新编译并离线签名；已有无公钥客户端必须手动升级到包含公钥的版本。
不得通过跳过验签来恢复自动更新。

### 轮换（计划内）

1. **提前内置**：把一个 `status=next` 的新公钥随常规版本发布，至少覆盖两个版本；
2. **双签过渡**：发版时同时用旧 key 与新 key 签名
   `--key old.key --also-key new.key`，客户端只要任一受信签名通过即接受；
3. **切换**：把新公钥改为 `active`、旧公钥改为 `revoked` 发布客户端；
   旧客户端仍能用旧 key 验证（只是继续接受旧 key），不会因换钥锁死；
4. **清理**：确认活跃版本都升级后，可在后续版本删除旧公钥文件。

### 吊销（私钥泄露/丢失）

1. 立即停止用泄露 key 签名；
2. 用**未泄露**的 `next`/备用 key 双签一次发布（签名文件里保留旧 key 条目仅作过渡，
   新客户端会因旧 key 为 `revoked` 而只认新 key）；
3. 在新客户端里把泄露 key 标为 `revoked` 并发布；此后旧 key 的签名一律拒绝；
4. 若所有离线 key 同时丢失且没有可用签名通道，自动更新不可恢复，只能公告并让用户手动下载；
   **不要**为了「先恢复更新」而临时跳过验签。

> 旧客户端无法远程获知吊销（它只内置旧公钥）。风险窗口由「吊销后第一版客户端」的覆盖率决定；
> 若泄露影响面大，可在 `update-meta.json` 设置 `mandatory=true` / 提高 `min_supported_version`
> 强制升级到带吊销列表的版本——这是运维决策，不是客户端静默行为。

### 存量兼容与迁移

- 已安装的旧版本不验签，会像以前一样接受第一个**已签名**版本；旧版本无需强制升级即可进入签名体系。
- 新版本遇到未签名/签名无效的发布时：仍显示版本与说明，但禁用「立即更新」，
  提示「该版本缺少有效签名或 sha256，已禁用自动安装，请前往发布页手动下载」；
  不存在静默降级到「只校验 sha256」的路径。
- 迁移窗口建议：从第一个带签名的版本起，连续 2 个版本保留 `min_supported_version` 不抬高；
  确认覆盖率后再用 `mandatory`/`min_supported_version` 推动强制升级。

---

## 1. 准备发版

```bash
# 1) 改版本号（只改 frontend/package.json）
npm pkg set version=1.1.0 --prefix frontend

# 2) 同步 Cargo.toml / tauri.conf.json
pnpm version:write

# 3) 校验三处一致
pnpm version:check

# 4) 把 CHANGELOG 的 [Unreleased] 改名为 [1.1.0] - YYYY-MM-DD，
#    并补上「升级提示 / 已知问题」等需要用户知道的信息
```

本地自检（与 CI 等价）：

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck
pnpm test
pnpm check:copy
pnpm --filter @openshell/frontend build
pnpm check:package
node scripts/release.mjs check            # 版本 + CHANGELOG 一致性
```

### 1.1 干净打包（不要手工 `tauri build` + 手动上传）

```bash
pnpm package:release                 # 预检 → 前端 → 安装包 → 隐私体检 → 清单
pnpm package:release --bundles nsis  # 指定格式
```

它比手工打包多三道闸，目的只有一个：**发布包里绝不带上本机的连接数据**。

1. 工作区必须是干净的 git 树（未提交改动一律拒绝，`--allow-dirty` 才放行）；
2. 仓库里不能有被跟踪的 `*.db` / `.env` / 私钥；
3. 构建完成后跑 `check-package.mjs`：除了私钥与 token，还会把**本机真实存在**的
   连接信息（`<数据目录>/openshell.db` 里的主机地址、账号、SSH 公钥，以及本机用户名路径）
   当作黑名单，对 `frontend/dist` 和安装包二进制抽串比对，命中即失败。

上传时只传 `artifacts/` 里的安装包与清单；便携包必须由 CI 从本次构建的可执行文件、
便携标记和许可文件生成，不能压缩本机安装目录，也不能上传整个 `target/`：

```bash
# 先离线签名（见 0.1），再上传
gh release create v1.1.5 artifacts/OpenShell-* artifacts/SHA256SUMS.txt artifacts/update-meta.json artifacts/update-meta.json.sig artifacts/latest.json --draft --notes-file artifacts/release-notes.md
```

> 用户数据只存在于 `<app_data_dir>`（Windows 为 `%APPDATA%\\dev.openshell.desktop`），
> 由 `resolve_data_dir()` 强制与安装目录隔离，因此**任何安装包本身都不含连接信息**；
> 在同一台机器上重装看到旧主机，属于读到了本机数据目录，不是被打进了包。

发布前还必须通过 `node scripts/check-release-inputs.mjs`：拒绝本地环境文件和被跟踪的私有数据，
并验证 Tauri 资源只包含明确允许的第三方许可文件。全新数据目录的主密码为未设置；
覆盖安装保持用户已有密码与连接数据，不能在安装流程中重置或复制开发者的保险库。

---

## 2. 打 tag 触发流水线

```bash
git add -A
git commit -m "chore(release): v1.1.0"
git tag v1.1.0
git push origin main --tags
```

`.github/workflows/release.yml` 会依次执行：

1. **verify**：三处版本一致 + tag 与版本匹配 + CHANGELOG 有对应小节；
2. **build**（三平台矩阵）：构建 → 把产物改名为
   `OpenShell-<version>-<platform>-<arch>.<ext>` → 上传 artifacts；
3. **publish**：从 `CHANGELOG.md` 当前版本小节生成中文发布说明 →
   合并生成 `SHA256SUMS.txt`、`update-meta.json`、`latest.json` →
   创建 **draft** Release，上传安装包与校验和；清单保存为 `updater-manifests` Actions 产物，
   按 0.1 离线签名后首次上传，再人工发布。

> 发布前先整理当前版本的中文日志，再运行 `node scripts/release.mjs notes`。
> `--from v1.0.1` 仅生成提交历史草稿，不用于正式发布；客户端优先显示发布页正文，正文为空时才回退到元数据说明。

---

## 3. 人工校对后发布

打开 GitHub 的草稿 Release，按 `.github/release-template.md` 校对：

- [ ] 「更新亮点」写成用户能感知的一句话，不罗列内部重构；
- [ ] 「升级提示」是否仍成立（是否需要提醒最低支持版本）；
- [ ] 安装包命名与表格一致（`OpenShell-1.1.0-windows-x86_64.exe` 等）；
- [ ] 预发布版本勾选 *This is a pre-release*（tag 含 `-` 时流水线会自动勾选）；
- [ ] 强更版本需要在 `update-meta.json` 里写 `mandatory` / `min_supported_version`
      （重新上传覆盖该文件后再发布）。

点击 **Publish release** 后，`release: published` 事件会触发 `sync-updater-meta` 任务，
把 `latest.json` 推送到 `updater-meta` 分支，jsDelivr 备用源随即生效（有 CDN 缓存延迟）。

---

## 4. 发布后验证

```bash
# 用旧版本客户端手动检查更新，确认能拿到新版本
# 或直接用 curl 验证清单
curl -sL https://github.com/fieecbin-source/openshell/releases/latest/download/SHA256SUMS.txt
curl -sL https://cdn.jsdelivr.net/gh/fieecbin-source/openshell/updater/latest.json
```

回归要点：

- 下载 → 校验 → 安装全流程走通，安装后连接数据仍在；
- 「设置 → 关于与更新」显示的版本号与新版本一致；
- 日志里出现 `check_done` / `download` / `install` 对应阶段，且没有敏感信息。

---

## 5. 回滚与坏版本处置

**安装包有问题但尚未扩散**：

1. 立即把 Release 改为 *draft*（或删除资产），阻止新用户下载；
2. 已下载的用户不会自动降级 —— 发布一个修复版本，并把 `min_supported_version`
   指向「坏版本之后的修复版本」，旧客户端会进入强制更新；
3. 在 Release 说明与 issues 里写明受影响范围与手工处置方式。

**用户数据被迁移后想退回旧版本**：

- 不建议直接安装旧版本：数据版本高于客户端时客户端会拒绝启动（`SCHEMA_NEWER_THAN_APP`）；
- 正确做法：从 `<数据目录>/backups/` 找到对应的 `pre-migration-*.db` 快照，
  关闭 OpenShell 后用快照覆盖 `openshell.db`（同时删除 `-wal`/`-shm`），再安装旧版本。

**紧急撤销某个版本**：

- 客户端侧没有远程 kill switch，只能靠「发布更高版本 + 提高 `min_supported_version`」引导升级。

---

## 6. 自动化边界（草稿 → 人工发布 → 同步）

### 6.1 两步式流程

```
push tag v1.1.0
   → workflow: verify → build(三平台) → publish：创建 **draft** Release + 上传资产
   ↓（人工）在 GitHub 上校对说明并点 Publish release
   → workflow: release(published) → sync-updater-meta：把 latest.json 推到 updater-meta 分支
```

**为什么不让流水线直接发布**：Release 正文是给用户看的，机器分类只能作为初稿；
且「发布」是不可逆动作，需要一次人工确认。

### 6.2 `GITHUB_TOKEN` 的关键限制

用 `GITHUB_TOKEN` 发起的 push / release 事件**不会**再触发其它 workflow（GitHub 的递归防护）。
因此：

* 若将来把「点 Publish」也自动化（例如用 `gh release edit --draft=false`），
  这次「发布」是 `GITHUB_TOKEN` 干的 → `release: published` **不会**触发 `sync-updater-meta`，
  `latest.json` 不会更新；
* 想全自动，两条路：
  1. 用 **PAT / GitHub App token**（`secrets.RELEASE_PAT`）执行发布动作，事件才会继续传递；
  2. 把「同步 latest.json」改成**同一个 workflow 内的最后一步**（发布后直接推送），不依赖事件。

当前实现依赖人工点 Publish（用户侧动作），事件由 GitHub 正常派发，因此不受该限制影响。

### 6.3 权限最小化

`release.yml` 顶层声明 `permissions: contents: read`，只有两个 job 单独提升：

| job | 权限 | 理由 |
| --- | --- | --- |
| `publish` | `contents: write` | 创建 draft Release、上传资产 |
| `sync-updater-meta` | `contents: write` | 推送 `updater-meta` 分支 |

其余 job（verify / build）只有只读权限。

### 6.4 `updater-meta` 分支与分支保护

同步在现有 `updater-meta` 分支上追加提交，并使用普通推送保留历史；不得重写该分支或覆盖旧版 Release。
因此**必须**满足以下其一，否则同步会 422/失败：

- 不把 `updater-meta` 纳入分支保护；或
- 分支保护里为该分支添加例外（允许 `github-actions[bot]` 或 workflow 的 token 强推）。

同时请在仓库设置里确认：

- [ ] `updater-meta` 不是默认分支；
- [ ] 未开启「Require pull request before merging」于该分支；
- [ ] Actions 的 `Workflow permissions` 允许读写（否则 job 级 `contents: write` 也无法推送）。

### 6.5 预发布（rc / beta）规则

- tag 含 `-`（如 `v1.0.2-rc.1`）→ Release 自动标记 **prerelease**；
- 预发布**不**触发 `sync-updater-meta`（条件：`!github.event.release.prerelease`），
  因此不会污染稳定通道的备用检测源；
- 预发布**不**上传 `latest.json`（发布侧自检 `scripts/e2e-upgrade/check-release.mjs` 会检查这一点）；
- 测试通道客户端直接从 GitHub 的 prerelease 读取（源实现里 beta = `prerelease && !draft` 取 semver 最大），
  不依赖 `latest.json`。

### 6.6 发布前预检覆盖面

`node scripts/release.mjs check --tag vX.Y.Z` 会校验：

1. `frontend/package.json` / `Cargo.toml [workspace.package]` / `tauri.conf.json` 三处版本一致；
2. tag 与版本号一致（`v` + version）；
3. `CHANGELOG.md` 存在 `## [x.y.z]` 小节。

任一项不满足即非零退出，CI 的 `verify` job 会因此中止，不会产出 Release。

## 7. 常见失败

| 现象 | 处理 |
| --- | --- |
| `verify` 失败：版本不一致 | 本地跑 `pnpm version:write` 后重新提交、重新打 tag |
| `verify` 失败：CHANGELOG 缺条目 | 补 `## [x.y.z]` 小节 |
| `assets` 步骤找不到安装包 | 检查 tauri target 目录（`target/<triple>/release/bundle/**`）是否存在 |
| Windows 用户被 SmartScreen 拦截 | 属已知限制，文档已说明；后续可接入代码签名 |
| macOS 提示「已损坏」 | 未公证导致，指导用户「右键 → 打开」或 `xattr -dr com.apple.quarantine` |
