你是 trae。本次任务目标为补齐真实IPC边界的剩余覆盖矩阵，作为多 agent 协作的一员，只负责下列任务：main.md 所列 ImportExportModal、SnippetBar、PortForwardModal、snippetStore、forwardStore 及同名测试。

Task8 CEO 已最小修正 refreshing 在所有UI换代入口重置、恢复选文件清旧refreshError、forward所有status writer共用代次。保留这些修复，不重做终端/串口/RDP；这些文件及backend/IPC只读。

1. 文件读取矩阵：JSON file.text 与加密 arrayBuffer，分别在切tab、显式close、unmount后晚resolve/晚reject。验证不污染新文件/新页、不重复预览/提交、不出现格式化后的旧错误、不保留loading；仅断言原始英文错误不出现或不崩溃不算覆盖。close请调用真实关闭控件，不能用unmount冒充。
2. 保留并回归 commit A pending→B preview pending的loading/token与晚失败，commit成功后全局刷新、组件卸载不取消已成功mutation必要刷新。重试只读，不重提交；恢复A刷新失败→选B文件pending时旧重试不能夺走B的代次。不要修改 archive token 契约。
3. snippetStore 用真实 snippetList IPC补晚reject、兄弟读取失败后retry与旧完成的矩阵；SnippetBar消费真实create/list，不只替换顶层动作。验证写成功刷新失败时用户实际看到错误/可重试状态、toastStore输出，不能只检查mock调用。canonical body/kind与统一发送不变。
4. forward补现有双入口状态读取的晚reject/失败后retry，与真实modal reopen路径；列表filter归属和用户可见错误保持，不能旧status覆盖当前结果。复用现有deferred测试，不新增无意义镜像测试。若发现可达具体缺口，只在本人白名单先红后最小修复，其他问题给CEO提案。

定向跑上述测试单 worker与限定 ESLint（只选本人实际文件），记录每个矩阵的真实覆盖、命令退出码。不得全仓/Cargo/build、不增timeout/skip/allow、不改他人文件或删断言制造通过。证据精简，反馈说明真实WebView/真实归档和远程协议未验证。
