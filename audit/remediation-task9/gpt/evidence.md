# Task9 / 员工1 gpt：历史代理缓存安全迁移

日期：2026-11-07。状态：白名单实现及 CEO 独立复审 P1 修复完成；最新代理定向 45/45 通过，等待 CEO 集成审核与完整门禁。

## 基线与所有权

- 工作区：`E:\Projects\openshell`；执行分支：`codex/task9-closeout`。
- 开工 HEAD：`7b3007a13c839857f19d89ce931c7d8b273a9eee`，与分发冻结基线一致。
- 读了 `multi-agent/task9/main.md`、`gpt1.md`、Task8 `BASELINE.md`；开工时 Task9 `BASELINE.md` 与 Task8 review 缺失，按 CEO 授权继续。后补的 Task9 `BASELINE.md` 已重读，与上述 SHA 一致；缺失的历史 review 未伪造。
- 只修改 `frontend/src/components/ProxyManagerModal.tsx`、`frontend/src/components/ProxyManagerModal.test.tsx`；本文件为授权证据。未修改共享契约、后端、配置、依赖或锁文件；未 add/commit/push/切分支，未覆盖其他员工文件。
- `Task 9 Feedback.md` 由 CEO 依据此报告统一填写，避免并行覆盖。
- 按 systematic-debugging / test-driven-development / verification-before-completion 流程先复现再修改并实际验证；未启动子 agent。

## 实现结果

1. 后端读取成功后才读取隔离来源的旧缓存。有效且 ID 独立的历史条目，通过现有真实 `proxyListSave` / `ProxyServerInput` DTO 提交；保留本次读取的全部后端条目，每条显式 `clear_password: false`，不把缓存引用当作后端秘密归属。
2. 有效行验证包括必填名称/ID/地址、代理类型、整数端口范围、字符串可空字段、整数时间、重复 ID、未知字段、不可证明归属的密码引用和清除密码指令。无效 JSON/无效行/重复 ID/同 ID 冲突均不保存、不改写、不删除原缓存；展示简短处理提示。已有后端与缓存同 ID，即使字段相同也不据此猜测密码相同。
3. 保存后再次执行 `proxyListGet`，逐条检查配置元数据、已有后端引用保留，以及携带临时密码的条目具有后端返回的 `has_password` 和非空引用。仅整批确认且当前缓存字符串仍等于原值时删除旧缓存。
4. 保存失败保留原字节与已有后端界面。保存已经成功而验证读取失败/返回不完整时，保留旧缓存，用不含凭据的布尔标记阻止重复提交；后续刷新/关闭重开仅重新读取并提示核对。缓存在 pending 期间被新值替换也保留新值，不用迁移结果清除它。
5. migration job 在刷新及关闭重开之间共享。读取 generation 只控制列表、错误、loading/finally 的当前界面归属；旧读取不发起迁移，旧 finally 不结束新界面加载。已经发起的保存仍完成后台验证及必要的脱敏 `onChanged` 通知。
6. 所有配置输出剥离 `password` 与 `clear_password`，不将秘密回填表单或缓存。不恢复 fallback 写入。现有显式保留、替换、清除密码与真实 `proxyTest` 的 `clear_password` 回归保留；新建 DTO 也显式发送 `clear_password: false`。迁移加载时禁止普通增删保存与整表迁移竞争。
7. 复审中单独红测复现 `onChanged` 抛错会中断验证；已把通知放到写入成功分支之外。通知失败仍继续后端读回确认，成功确认后可以安全清除同值缓存，界面显示已保存/刷新提示，不把成功持久化判为写失败。

## 测试边界与结果

新增迁移用例保留真实 `proxyListGet` / `proxyListSave` IPC 包装器，仅在 Tauri `invoke` 外部边界注入合成配置与凭据，不读取真实浏览器缓存或用户库。检查真实后端参数、原缓存完整字符串、脱敏回调、密码输入框、列表、错误与加载 finally。

覆盖：空后端/已有独立后端；不同与相同内容的同 ID 冲突；无效 JSON/非数组/分数端口/混合无效行/重复 ID/孤立引用；锁库/读取失败/保存失败；成功提交后验证失败和不完整验证；已有后端丢失的验证响应；无凭据条目；并发缓存替换；pending 刷新与实际 form submit 防重入；关闭重开时保存 resolve/reject 和读取 resolve/reject；旧操作不得重复提交或回写新界面；验证失败后的刷新、重开与真正 unmount/remount 不重复保存；脱敏 `onChanged` 抛错后仍继续验证且显示刷新提示。

实际命令（全部在 `E:\Projects\openshell`）：

| 阶段 | 命令 | 退出码 | 实际结果 |
| --- | --- | --- | --- |
| 红测，修改生产代码前 | `pnpm --dir frontend exec vitest run src/components/ProxyManagerModal.test.tsx --maxWorkers=1 --minWorkers=1` | 1 | 27 项：16 fail / 11 pass。缺失迁移导致保存调用为 0；无冲突/无效数据提示；旧读取把重开的后端列表覆盖为空。 |
| 首轮修复 | 同上 | 1 | 27 项：2 fail / 25 pass。两项有效迁移 fixture 的 `it.each` 数组被当成参数列表展开；随后改为对象参数，无删除/弱化断言。 |
| fixture 修正及补充边界 | 同上 | 0 | 32 / 32 pass。 |
| 补充同 ID 相同数据 | 同上 | 0 | 33 / 33 pass，1 文件，0 failed；2026-11-07 22:46:32 起，572ms 测试执行。 |
| 复审新增通知异常红测 | 同上 | 1 | 35 项：1 fail / 34 pass；`onChanged` 抛错后真实调用只有 get/save，缺少保存后的验证 get。真正 unmount/remount 与 pending 表单防重入断言通过。 |
| 第一阶段定向绿测 | 同上 | 0 | 35 / 35 pass，1 文件，0 failed；2026-11-07 22:48:17 起，678ms 测试执行。 |
| 第一阶段限定 lint | `pnpm --dir frontend exec eslint src/components/ProxyManagerModal.tsx src/components/ProxyManagerModal.test.tsx` | 0 | 0 error / 1 warning：原有 effect 的 `loadProxies` 缺失依赖警告，未通过 disable/allow 配置绕过。 |
| 第一阶段 diff 检查 | `git diff --check -- frontend/src/components/ProxyManagerModal.tsx frontend/src/components/ProxyManagerModal.test.tsx` | 0 | 无输出，无空白错误。 |

## Fix：P1 读写反向互斥（CEO 独立复审）

独立复审指出第一阶段只禁止迁移期间普通增删，没有反向保护：首次迁移保存失败留缓存后，普通保存 pending 期间真实刷新入口仍可读取旧列表并再次迁移整表；普通删除也没有持有 saving。只依赖 React render 中的 disabled/saving 闭包不能阻止同一事件轮的重复保存、删除及刷新。

先写真实 `invoke` deferred 红测，生产代码修改前 43 项中新增 8 项全部失败：保存/删除的 resolve/reject 四组合里，同一事件轮「动作 → 再 submit → delete → 真刷新控件」实际发出 5 次整表保存而不是应有的 2 次（首次失败迁移及唯一普通 mutation）；关闭重开四组合在旧 mutation pending 时提前发出额外 backend get。

最小修复仍只在原两文件：

- `activeLoad` 在读取入口异步开始之前同步取得归属；普通保存/删除查看这个 ref 及 `migrationJob`，防止读 → 写竞争。
- `activeMutation` 在普通保存/删除异步开始之前同步取得归属，两个写入口与 `loadProxies` 都检查它；删除也持有 saving 并在 finally 释放。刷新控件在保存时禁用，入口 ref 保证禁用尚未 render 的同一事件轮也安全。
- 普通 mutation 有独立 generation，保留 load generation 的原有含义。关闭重开不取消后台保存或清除其 busy owner；旧 mutation 不回写新列表、表单或错误，最终只由实际 mutation owner 释放 busy，并在已经重开的当前界面安全启动新读取。没有新 IPC、取消/事务框架或第三方依赖。
- `persistList` 只在当前 mutation generation 更新界面，始终履行脱敏通知；普通通知抛错同样单独返回已保存/刷新提示，避免把已提交写入判断为失败。

新增 10 项真实 IPC 回归：普通 save/delete pending 各含 resolve/reject，真刷新控件和同一事件轮重复 submit/delete 不读旧库、不迁移、不重复保存，原始缓存原值保持；同四组合关闭重开后，旧 mutation 结束才开始新读取，旧 finally 不覆盖新表单/错误，加载及保存 busy 正确结束；真刷新先开始 pending 读取再同轮 submit/delete 的 resolve/reject 两种反向边界。

| 阶段 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| P1 修改前红测 | `pnpm --dir frontend exec vitest run src/components/ProxyManagerModal.test.tsx --maxWorkers=1 --minWorkers=1` | 1 | 43 项：8 failed / 35 passed；上述反向竞争及提前读取均实际复现。 |
| P1 首轮绿测 | 同上 | 0 | 43 / 43 passed。 |
| P1 最终绿测 | 同上 | 0 | 45 / 45 passed，1 文件，0 failed；2026-11-07 22:58:29 起，782ms 测试执行。 |
| P1 最终限定 lint | `pnpm --dir frontend exec eslint src/components/ProxyManagerModal.tsx src/components/ProxyManagerModal.test.tsx` | 0 | 0 errors / 1 既有 warning：effect 的 loadProxies 依赖。 |
| P1 最终 diff 检查 | `git diff --check -- frontend/src/components/ProxyManagerModal.tsx frontend/src/components/ProxyManagerModal.test.tsx` | 0 | 无输出。 |

该修复覆盖同一组件实例内的读写互斥；不把它当作跨实例/跨进程的 CAS 保证，下面的真实数据和外部竞争未验证边界仍保留。

## 人工处理、发布依赖与未验证边界

- 现有接口是整表保存，没有 revision/CAS 或原子补录接口。任何无效行/冲突会保留整份原文并停止整批自动导入；不自动部分改写包含密码的缓存。不能证明同 ID 的历史密码与现有加密密码相同，也不通过前端猜测秘密引用。
- 已保存但验证失败的旧缓存保留供人工核对；本次挂载内重试只读。重新挂载时同 ID 会成为冲突并保留，不反复覆盖已持久化的新数据。为了不保存额外明文来源快照，没有新增持久化迁移标记；这种情况不自动清空缓存。
- 缓存字符串 compare-before-remove 防止本次测试涵盖的 pending 替换；localStorage 与后端整表接口均无跨窗口 CAS。真正跨进程/跨窗口同时改写后端整表的原子性需要 CEO 提出后端条件写契约，当前未新增 IPC。
- 只凭真实配置读回及后端加密 DTO 契约确认凭据已保存；前端不解密或比对秘密，不以测试数替代真实数据验收。
- 真实用户存量代理缓存、真实锁库/解锁、跨窗口竞争、真实网络代理连通均未验收；此报告不宣称它们已验证。
- 按分发限制未运行全量 Vitest、typecheck、Cargo、build、依赖安装；这些由 CEO 集中执行。真实 RDP/NLA、实体串口、外部 X11/agent、CredUI、macOS/Linux、安装升级仍未验收。
- 本线不要求共享契约变更才能发布上述保守行为；如需冲突自动合并、提交失败跨重启精确重试或跨窗口原子补录，需要另行设计条件写及来源 receipt 契约，不能整支推送当前基线。
