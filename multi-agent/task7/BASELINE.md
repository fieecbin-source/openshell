# Task7 开工基线（2026-11-07）

- 工作区：E:\projects\openshell。分支：Fce/task7-integration（仅本地，禁止推送整支）。
- 完整HEAD：`1fc1723daf9adb4da0f08b402c1fa1cdc02a9c98`。开始前先运行git branch --show-current、git rev-parse HEAD、git status --short；相对这个SHA记录Task7增量。
- 此HEAD包含本地未验收功能代码。Task6源码先保存在本地`637fd470ae8581434cc613de28162710ccc4dc74`，再合入已验收远端提交；不是上线通过。先前9b05523仍保留在本地历史。
- 已验收远端：Fce/terminal-workspace-ux@`0fafbba9ed06c17264d746c75adbf79eb2f401f7`。ls-remote已核实。独立批准工作区E:\projects\openshell-approved，员工只读，不在此工作或切分支。
- 本轮已推四批：7b0b57e扫描器；d9af78e首页协议选择器；c6a8bbe AI/SFTP测试夹具；0fafbba串口测试模块原样移到末尾。远端分支不包含9b05523或637fd47的未验收祖先。
- 保全过程对749个Git跟踪文件逐个SHA256，合并前后0不一致，索引/工作区均为空；仅一处AppLayout注释冲突，保留现有注释，Git树和文件字节均未变。旧stash保留。证据audit/task7-preserved-source.json。
- 开工首次应干净；若其他员工已经开始，保留其白名单修改，不能清理/恢复别人的文件。忽略的multi-agent、docs/bug、audit继续留本地，不属于可直接发布代码。

新鲜基线验证：主前端239/239、批准副本126/126；两边build/typecheck通过，lint均0错误/12既有warning；主Rust workspace511通过/0失败/1既有ignored（真实安装包下载），随后测试小修的批准副本AI/SFTP88/88、serial --lib7/7；workspace all-targets Clippy -D warnings、fmt、diff检查均退出0；两套真实dist各35文件扫描通过。前两次并发前端有5秒超时，最后单worker全量通过，未改timeout/skip。

上述测试不解除Task6 R01、R03–R09。真实RDP/NLA成功登录、实体串口、外部SSH/X11、真实旧库图形恢复、安装/升级仍未验收；Task7只接着任务书修复，不重跑无关审计或宣称可上线。
