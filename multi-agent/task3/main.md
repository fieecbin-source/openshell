# Task 3 任务总纲：对齐 FinalShell 新建连接架构、重构独立新建弹窗与去杂极简化

## 1. 任务背景与核心要求

用户明确提出对当前「新建连接」流程与界面布局的重大整改要求：
1. **参考 FinalShell 的新建架构**：
   - FinalShell 中，新建连接统一称为「**新建连接**」（而非「新建服务器」）。
   - 用户在入口处通过下拉菜单提前选择连接类型（主流三大类：**SSH**、**Windows (RDP)**、**串口 (Serial)**，其余如 **Telnet**、**本地终端 (Local Shell)** 作为备选项展示）。
   - 选择后弹出针对该类型的专属独立对话框（或预设专属模式），而不是混在同一个由 5 个横向 Tab 切换的杂乱对话框里。
   - **终端设置、端口转发/隧道、代理服务器都是属于各自连接内部的配置标签页**（SSH 拥有完整的常规/终端/代理/隧道，Windows RDP 拥有常规/显示与分辨率/本地资源重定向/代理，串口拥有串口参数/流控/高级终端）。
2. **连接分类与默认分组**：
   - 首页和侧边栏默认按连接类型（如 SSH、Windows 远程桌面、串口等）进行清晰分组展示。
   - 若系统只有一种类型的连接（或没有配置多类型连接），则默认显示一个分组，界面干净清爽，不冗余多余空分组。
3. **极简化、去杂乱与移除预留提示文本**：
   - 新建连接对话框当前次要文本过多，界面杂乱。
   - **将所有次要说明文案移入代码注释，禁止直接暴露在前端界面上**。
   - **清理所有输入框的 placeholder 预留提示文本**（如「例如 192.168.1.100」、「例如 /var/www」、「留空自动按...」等全部移除），保持界面极致简洁清爽。
   - 保持所有底层连接、凭据加密、通道建立等功能绝对稳定无异常。

---

## 2. 团队分工与文件白名单（严格隔离）

### 员工1：`gemini4`（复杂任务 / 前端核心设计）
- **职责**：重构 [`SessionModal.tsx`](file:///e:/projects/openshell/frontend/src/components/SessionModal.tsx)。
- **核心任务**：
  1. 移除弹窗顶部杂乱的 5 协议水平切换条；由传入的 `initialValues.protocol` 或 `protocol` prop 锁定对应模式（同时允许顶部提供轻量切换或纯标题展示）。
  2. 彻底清理界面杂乱文本：所有非必要解释性描述、次要文本全部移除并转为代码注释。
  3. 清除所有 `<input>`、`<textarea>` 中的 `placeholder` 预留文本（留空 `placeholder=""` 或完全移除 `placeholder` 属性）。
  4. 保持 FinalShell 风格的内嵌标签设计：SSH 下保持「常规与认证」「高级与终端」「隧道 / 端口转发」「主机图标」分类；RDP 下分为「常规与认证」「显示与设备」「网络与代理」；保证连接保存、Vault 解锁、内嵌隧道创建等逻辑 100% 稳定完好。
- **文件修改白名单**：
  - `frontend/src/components/SessionModal.tsx`
  - `frontend/src/components/SessionModal.test.tsx`（同步维护单测）

### 员工2：`gtp`（复杂任务 / 后端数据与分组归约）
- **职责**：确保后端连接创建、协议校验与分组元数据的一致性；支持默认按连接类型组织逻辑分组与单类型降级。
- **核心任务**：
  1. 审查并保证 `importer`、`ssh`、`rdp`、`serial` 等协议在后端保存及连接启动逻辑零异常。
  2. 为导入器或会话存储提供类型分组逻辑支撑（若用户没有自定义分组，前端按协议类型聚合时提供一致的协议分组名规范：`SSH 连接`、`Windows 远程桌面`、`串口通信`、`Telnet 会话`、`本地终端`）。
  3. 补充完善后端相关的测试用例，保证协议与端口转发联动无任何回归缺陷。
- **文件修改白名单**：
  - `backend/crates/importer/src/finalshell.rs`
  - `backend/crates/importer/src/preview.rs`
  - `backend/desktop/src/commands.rs`（如有必要）

### 员工3：`trae`（中等难度 / 前端布局与分组视图）
- **职责**：重构 [`HomeHub.tsx`](file:///e:/projects/openshell/frontend/src/components/HomeHub.tsx)、[`TerminalTabs.tsx`](file:///e:/projects/openshell/frontend/src/components/TerminalTabs.tsx) 与 [`AppLayout.tsx`](file:///e:/projects/openshell/frontend/src/components/AppLayout.tsx)。
- **核心任务**：
  1. 将所有「新建服务器」按钮文案统一改为「**新建连接**」。
  2. 实现点击「新建连接」时弹出 FinalShell 风格的下拉菜单：
     - 主流三大类：**SSH 主机连接**、**Windows 远程桌面 (RDP)**、**串口 (Serial) 通信**
     - 次要选项：**Telnet 连接**、**本地终端**
     - 点击具体选项后直接打开对应锁定协议的新建连接对话框。
  3. 首页分组展示优化：默认支持按连接类型聚合分组；若当前列表中只有一种连接类型（例如全是 SSH），则默认仅显示一个平铺分组，不展示冗余多余区块。
  4. 移除首页卡片与列表上冗余的多余说明文本与 placeholder。
- **文件修改白名单**：
  - `frontend/src/components/HomeHub.tsx`
  - `frontend/src/components/TerminalTabs.tsx`
  - `frontend/src/components/AppLayout.tsx`
  - `frontend/src/components/HomeHub.test.tsx`（同步维护单测）

---

## 3. 验收标准
1. `Set-Location e:\projects\openshell\frontend; npx tsc --noEmit; npx vitest run`：前端零报错，全部单测通过。
2. `Set-Location e:\projects\openshell\backend; & "$env:USERPROFILE\.cargo\bin\cargo.exe" +stable-x86_64-pc-windows-msvc check --workspace --locked`：后端零报错。
3. 界面视觉清爽极简，无任何多余 placeholder 与冗余教学文本，完全对齐 FinalShell 的高效连接管理模式。

