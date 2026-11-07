你是 gpt。本次任务目标为安全迁移历史代理缓存，作为多 agent 协作的一员，只负责下列任务：ProxyManagerModal.tsx/.test.tsx。

先核对 BASELINE.md。现在打开弹窗已不再删除 openshell_proxy_list_fallback_v1，新密码也不再写 localStorage；不要恢复旧 fallback 写入或先删后迁。任务是闭合存量缓存，保持数据可恢复。

1. 在现有组件/IPC链写红测：后端为空但缓存有独立条目、后端已有条目、同id冲突、锁库/读失败/保存失败、无效JSON/无效行、保存成功后验证失败、pending期间关闭/重开或缓存被新值替换。使用 synthetic 凭据，不读真实缓存。断言旧原值与后端输入，不能只断言不报错。
2. 用现有 proxyListGet/proxyListSave 最小实现。后端已有数据不能被缓存覆盖或删掉；秘密引用不能由前端猜测/编造。对可安全补录的数据，经真实输入DTO提交；确认每条迁移完成后才移除相应旧内容，失败和无法迁移部分原样保留。若现有整表接口不能安全处理冲突，展示简短可操作错误并保留原值，不做危险自动覆盖。
3. 不新增IPC、迁移框架或本地秘密副本。保持显式保留/替换/清除密码，新密码不回填、不缓存、不进日志，成功输出为脱敏配置。迁移写入成功但验证失败不得反复覆盖已持久化新数据。
4. 定向命令：`pnpm --dir frontend exec vitest run src/components/ProxyManagerModal.test.tsx --maxWorkers=1 --minWorkers=1`；限定该组件/测试 ESLint。记录红绿退出码及不支持/人工处理的边界。不会为了清空缓存而删除数据。

交付：代码与测试、本人反馈。不要改backend/IPC/types或他人文件；必要契约提案交CEO。真实用户存量缓存未验收要明确写出。
