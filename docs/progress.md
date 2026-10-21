# 项目进度（docs/progress.md）

> 用途：中断后可按本文件续跑。每轮结束（每个里程碑/修复循环）更新。
> 目标文档：[docs/openshell_design_prompt.md](openshell_design_prompt.md)

## 当前状态概览

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 分析 | ✅ 完成 | MobaXterm 8 份 + FinalShell 9 份分析文档，含证据与不确定项 |
| M1 规格与架构 | ✅ 完成 | spec/ 4 份（144 条规格）；docs/architecture.md + 8 篇 ADR |
| M2 核心骨架 | 🔄 进行中 | Tauri + 多标签终端 + SSH + 会话管理 + 加密保险库 |
| M3 功能补全 | ⏸ 未开始 | |
| M4 服务端与同步 | ⏸ 未开始 | |
| M5 打磨与发布 | ⏸ 未开始 | |

## 环境（详见 docs/env.md）

- ✅ Node 24.21.0 / npm 11.19 / pnpm 12.5 / Git 2.55 / JDK 21
- ✅ REA 6.7.0（`rea` 已全局安装；`rea setup` 已为 Trae 注册 MCP —— 需重启/重载 IDE 后 MCP 工具才可见；当前用 `rea` CLI 等效完成分析）
- ✅ MSVC Build Tools 2022（VCTools 工作负载）
- ⏳ Rust stable（rustup 已装，stable 工具链下载中）
- ❌ Docker Desktop 未安装（M4 前处理）
- ⏳ Ghidra 12.1.4 下载中断（570MB，本次分析未使用，不阻塞 M0）
- ✅ JADX 1.5.6（E:\Tools\jadx-1.5.6）

## M0 完成内容

- 初始化 git 仓库与目录骨架（analysis/spec/docs/crates/apps/server/deploy/tests），`analysis/` 已 gitignore
- Recon-A：MobaXterm 静态画像（原生 Delphi/VCL + Cygwin 用户态 + SecureBlackbox SSH；监控走 /proc；DPAPI 凭据；SFTP 目录跟随；隧道管理器），产出 `analysis/mobaxterm/00..07`
- Recon-B：FinalShell 画像（Java 17 + Swing；单连接多通道；零 agent 监控；逐记录版本+墓碑同步；更新清单字段；弱凭据保护），产出 `analysis/finalshell/00..08`
- 未做：动态抓包/运行态 UI 枚举；Ghidra 伪代码（下载中断）；竞品性能基线
- 风险：MobaXterm 无函数级证据；FinalShell 同步端点/鉴权未恢复（按合规要求不复刻）

## M1 完成内容

- `spec/product.md`：144 条可验收规格（P0 68 / P1 68 / P2 8），含第 9 节验收映射
- `spec/data-model.md`：实体/字段/关系/索引 + 导入导出格式
- `spec/sync-api.md`：自设计账号、E2EE 同步、冲突、更新、中继、运维 API
- `spec/ux.md`：信息架构、关键流程、快捷键、主题/i18n/可访问性
- `docs/architecture.md`：crate 边界、IPC 契约、存储/加密、同步客户端、CI 矩阵、风险
- `docs/adr/ADR-001..008`：Tauri、React、russh、SQLite、加密、同步冲突、服务端、终端背压

## 下一步（M2）

1. 等 Rust stable 就绪 → 创建 workspace 与 crate 骨架
2. 并行：Core-Dev（core-domain/store/vault/ssh/sftp）、UI-Dev（Tauri + React + xterm.js 多标签）、Architect 收尾 IPC 契约冻结
3. M2 验收：应用能启动、多标签终端、SSH 密码/密钥连接、会话 CRUD、保险库加解密单元测试
4. QA/Security-Reviewer 独立验证后合并

## 需要用户事项

- Trae 需重启/重载一次以加载 REA MCP（分析已用 CLI 完成，不阻塞）
- M4 部署时需要：公网服务器、域名、TLS/备份策略（届时一次性列出）
