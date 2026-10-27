# 发布手册

面向维护者：从「准备发版」到「用户收到更新」的全部步骤。全程不需要 Tauri 升级签名密钥。

---

## 0. 一次性准备

| 项目 | 说明 |
| --- | --- |
| `frontend/package.json` 的 `version` | **唯一真源**，其余两处由脚本同步 |
| `CHANGELOG.md` | 必须能查到当前版本的 `## [x.y.z]` 小节 |
| 仓库 slug | 默认 `fieecbin-source/openshell`，用户可在设置中覆盖 |
| `updater-meta` 分支 | 由流水线自动创建并维护，用于 jsDelivr 备用源 |

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
3. **publish**：按 Conventional Commits 生成分类说明（新增 / 改进 / 修复 / 破坏性变更）→
   合并生成 `SHA256SUMS.txt`、`update-meta.json`、`latest.json` →
   创建 **draft** Release 并上传资产。

> 如果说明分类效果不理想，可在工作流日志里找到 `scripts/release.mjs notes` 的输出，
> 本地用 `node scripts/release.mjs notes --from v1.0.1` 复现后手工修改草稿正文。

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

同步使用 `git push origin updater-meta --force`（该分支只承载一个文件，用孤儿提交保持瘦身）。
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
