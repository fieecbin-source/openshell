# Task 4 · trae 定向验证证据

时间：2026-11-06（Asia/Shanghai）

## 1. 改动面

- 已跟踪文件 diff：`tracked-diff.patch`（本目录，`git diff` 输出，185,816 字节）
- 新增文件（未跟踪，无法用 git diff 展示）：
  - `frontend/src/lib/terminal-actions.test.ts`
  - `frontend/src/stores/serialStore.test.ts`
  - `frontend/src/stores/containerStore.test.ts`
  - `frontend/src/components/ContainerWorkspace.test.tsx`
  - `frontend/src/components/ServerSidebar.test.tsx`

说明：`git status` 显示仓库中存在大量其他员工/历史会话的未提交改动；本轮只改动上列白名单文件，未回退任何他人改动。

## 2. 定向单元测试

命令：

```
pnpm --dir frontend exec vitest run src/stores/terminalStore.test.ts src/stores/serialStore.test.ts src/stores/monitorStore.test.ts src/stores/containerStore.test.ts src/components/HomeHub.test.tsx src/components/SessionModal.test.tsx src/components/ContainerWorkspace.test.tsx src/components/ServerSidebar.test.tsx src/components/XtermView.test.tsx src/lib/terminal-actions.test.ts
```

退出码：0

结果：Test Files 10 passed (10)，Tests 72 passed (72)。

| 文件 | 用例数 | 结果 |
| --- | --- | --- |
| src/lib/terminal-actions.test.ts | 6 | passed |
| src/stores/serialStore.test.ts | 4 | passed |
| src/stores/containerStore.test.ts | 7 | passed |
| src/stores/monitorStore.test.ts | 6 | passed |
| src/stores/terminalStore.test.ts | 10 | passed |
| src/components/ContainerWorkspace.test.tsx | 2 | passed |
| src/components/ServerSidebar.test.tsx | 4 | passed |
| src/components/XtermView.test.tsx | 7 | passed |
| src/components/SessionModal.test.tsx | 11 | passed |
| src/components/HomeHub.test.tsx | 15 | passed |

## 3. 定向 ESLint

命令：

```
pnpm --dir frontend exec eslint <22 个改动文件>
```

退出码：0

结果：0 error，3 warning（均为既有 `react-hooks/exhaustive-deps` 警告，不在本轮引入）：

- `ContainerWorkspace.tsx:144`（既有 useEffect 依赖）
- `SessionModal.tsx:416`、`SessionModal.tsx:593`（既有 useEffect 依赖）

## 4. TypeScript 类型检查（项目级，仅用于确认本轮文件无错）

命令：`pnpm --dir frontend exec tsc --noEmit`

退出码：1

现状：报错全部位于**非本任务白名单文件**，为其他会话/员工的未完成改动：

- `AppLayout.tsx`、`SftpView.tsx`、`TransferQueueDrawer.tsx` 的 `TransferState` 比较
- `SnippetBar.tsx` / `snippetStore.ts` / 相关测试的 `command_template` 类型
- `aiSettingsStore.ts` 的 `null` 赋给 `string`
- `ImportExportModal.test.tsx`、`AboutUpdateTab.test.tsx` 未使用 React 导入
- `updater/store.test.ts` 的 `BackupInfo` 缺字段

本轮改动的 15 个产品文件 + 5 个测试文件**未出现在任何 TS 报错中**。全量类型检查与修复由 CEO 收尾，未代改他人文件。

## 5. 修复前/后对照

修复前（复现方式见 `multi-agent/task4/trae/spec.md` 与各测试用例；`ServerSidebar.test.tsx` 的 2 项曾真实失败）：

- 串口打开在无端口时回退 `COM1` + `useMock=true`，界面显示成功
- 串口重连硬编码 `COM1`，丢失波特率/数据位等
- ASCII 终端与 HEX 视图各自 `readSerial` 轮询，抢同一后端队列
- 串口读写错误被吞，标签仍显示 connected
- RDP `launchRdp` 成功即写 `connected` / `connectedAt`
- monitor `latest` reject 时静默保留旧值、页面渲染伪 0
- 容器 `action` 不校验连接归属，A 连接可操作 B 连接同名容器
- ServerSidebar 折叠态缺 `aria-label="资源监控"` / `title="容器管理"`（测试失败）

修复后：上述对应测试全部通过；`ServerSidebar.test.tsx` 4/4、`ContainerWorkspace.test.tsx` 2/2、`SessionModal.test.tsx` 11/11 未修改既有断言。

## 6. 未验证范围（无环境）

- 真实串口硬件：热插拔、1 MiB 以上持续接收、RTS/CTS 与 XON/XOFF 流控
- 真实 RDP 远端：NLA/CredSSP、分辨率、多显示器、真正连接成功/失败判定
- X11 转发真实 X Server、SSH Agent 真实认证（后端能力由 gpt 交付）
- 非 Windows 平台串口与路径差异
- 全量 `pnpm build`、全量 vitest、Rust 构建（按分工留给 CEO）
