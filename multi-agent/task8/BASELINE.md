# Task8 开工基线（2026-11-07）

- 工作区E:\projects\openshell；本地分支Fce/task8-integration。
- 完整HEAD：`d7bbd25c6c3f296f82e4514d3037601921da8fd3`。先核对git branch --show-current、git rev-parse HEAD、git status --short，相对该SHA记录Task8增量。
- 该基线包含未验收功能保全，不可整支推送。Task7本地保全提交为`92f4d3e8e92d6e91476712104e6855edae1bad6d`；旧1fc/9b历史均保留。
- 已验收远端Fce/terminal-workspace-ux最新`5c6baede3bd3e2172b7b27b6d10865c5c97b321b`，本轮只推8aca310、6e4d04d、5c6baed三批（共享读取、转发筛选、孤儿会话可见性）。未推92f或Task8分支。
- 批准副本E:\projects\openshell-approved只读，员工在主工作区工作，不切换或覆盖其功能分支。
- 本地保全合入批准提交时forwardStore发生冲突；保留已有刷新helper，显式scope修复已在helper内。合并后的Git树未改变，753个源码/测试文件逐个SHA256与合并前一致，0不一致；主工作区与批准副本Git均干净，旧stash保留。证据audit/task8-preserved-source.json。
- 首位员工开工应干净；若其他员工已开始，保留其白名单修改。任务/报告/证据按既有规则ignored保留，不清理别人工作、不恢复旧patch/stash/远端旧树。

新鲜检查：主前端291/291、批准副本143/143及22项定向；两边build/typecheck、lint0错误/12既有warning，真实dist各35文件扫描通过；扫描器7/7。MSVC Rust workspace529通过/0失败/1既有ignored（真实安装包下载）；之后仅去除启动冗余闭包，再跑desktop --lib39/39及workspace all-targets Clippy -D warnings通过。fmt与diff检查通过。

这些通过不关闭Task7报告中的旧库取消副作用、组合刷新归属、串口timer/晚完成缺口。Windows句柄P1修复及恢复回归已保存在本地安全批次，没有随三个前端批次发布。真实CredUI、实体串口、RDP/NLA成功、外部SSH/X11、安装升级仍未验收。
