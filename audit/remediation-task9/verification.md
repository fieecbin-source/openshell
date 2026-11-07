# Task9 集中验证（2026-11-07）

原始基线 `7b3007a13c839857f19d89ce931c7d8b273a9eee`，执行分支 `codex/task9-closeout`。三条实现线停止产品编辑后执行前端完整验证。历史报告不替代本次结果。

最终远端复核：通过仅本次命令的 HTTPS URL 映射完成 `git fetch origin --prune` 和 `git pull --ff-only origin Fce/task8-integration`，两者 exit 0；pull 返回 Already up to date。远端任务分支仍为上述冻结 SHA，origin/dev 仍为 `fb317f5c6457d93b78138f374f88eb3aeb42d1ae`，未修改保存的 remote 配置。

| 检查 | 实际命令 | 退出码与结果 |
|---|---|---|
| 前端完整测试 | `pnpm --dir frontend exec vitest run --maxWorkers=1 --minWorkers=1` | 0；41 文件、439 passed、0 failed |
| 类型检查 | `pnpm typecheck` | 0；无类型错误 |
| 前端 lint | `pnpm lint` | 0；0 errors、12 既有 Hook warnings |
| 前端构建 | `pnpm build` | 0；TypeScript + Vite 构建成功；既有动态/静态 import 与大 chunk 提示仍存在 |
| Rust 全工作区测试 | `cargo test --workspace --locked` | 0；Windows/MSVC 539 passed、0 failed、1 既有 ignored |
| Rust 检查 | `cargo check --workspace --locked` | 0 |
| Rust lint | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 0；已去除既有 sync_lifecycle_test 冗余 Ok/? 包裹，不放宽门禁 |
| 修改的 Rust 测试文件回归 | `cargo test -p openshell-app-core --test sync_lifecycle_test --locked` | 0；10/10 passed |
| Rust 格式 | `cargo fmt --all -- --check` | 0 |
| 发布/签名/包扫描器测试 | `node --test scripts/release.test.mjs scripts/updater-sign.test.mjs scripts/check-package.test.mjs` | 0；12/12 passed |
| 版本 | `node scripts/version.mjs --check` | 0；三处一致 1.1.7 |
| 更新文案 | `node scripts/check-updater-copy.mjs` | 0；三处既有硬编码移入 copy.ts，行为不变 |
| 新鲜 dist 扫描 | `node scripts/check-package.mjs frontend/dist`，在隔离 profile 的子进程中执行 | 0；35 文件通过；未读取用户真实数据库，无安装包二进制 |
| 补丁格式 | `git diff --check` | 0 |

完整日志保留在 ignored `audit/task9-*.log`。产物扫描子进程把 os.homedir()/APPDATA 指向 `audit/remediation-task9/isolated-profile`；仅扫描新构建的 frontend/dist，不使用旧 artifacts 或用户数据库作为测试输入。

本机 HTTP_PROXY/HTTPS_PROXY 导致最初 AI 回环正例超时。只在 Rust 测试子进程设置 `NO_PROXY=127.0.0.1,localhost,::1` 后，7 项 HTTP 测试与完整工作区通过；未改产品 HTTP 客户端、超时、系统代理或断言。

首轮完整前端测试在最后 sessionStore 首错修复写入期间读到旧实现，421 passed/1 failed；停止编辑后的上述 439/439 是最终结果。首轮类型检查发现新增转发 fixture 漏必填 credential_state，已改为 ForwardRuleView 并补实际状态，不以 any 绕过。初始 Clippy 与格式失败均已最小修复并复跑。

独立初审发现的 R1–R4 与修复后限定复审保留在 `final-review.md`，实现红绿证据分别在 gpt/gemini/trae/evidence.md。测试使用真实 store 或现有 IPC 包装器的边界 fixture，不代表真实 Tauri WebView、远端协议或用户数据验收。

限定复审已完成：R1–R4 全部 ADDRESSED，剩余必修项 0。集中验证后只更新文档与整理提交，未再编辑产品代码。实现按以下依赖批次保留为本地提交：

| 提交 | 内容 |
|---|---|
| `3d68da3` | 代理安全迁移、对称读写归属、真实边界回归 |
| `f2cb30c` | 同步交叉流程/认证归属及 session/group 嵌套读取等待 |
| `7afe5df` | 导入/片段/转发矩阵及两项可见错误最小修复 |
| `ed7f481` | 更新文案集中性和 Rust 测试闭包 CI 修复 |

本次没有推送、合并 dev/main 或发布安装包。历史基线提交保留原样；精简 Markdown 反馈与审查单独提交，原始日志继续 ignored。

真实 RDP/NLA、实体串口、外部 X11/Agent、CredUI、macOS/Linux、安装升级、真实用户旧缓存和跨窗口整表原子写入仍未验证。本次只交付新增修复与回归，不把 Task8 WIP 保全历史视为整产品可发布证明。
