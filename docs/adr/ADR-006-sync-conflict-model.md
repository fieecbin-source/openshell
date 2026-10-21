# ADR-006：同步冲突模型

- 状态：已接受（M1）
- 日期：2026-10-21
- 关联：`docs/architecture.md` §10、§11；ADR-005；`spec/sync-api.md`（SPEC-API-001）、`spec/data-model.md`（SPEC-DM-001）

## 背景

多设备同步会话、片段、转发规则、设置与凭据。要求：

- 服务端只存密文（E2EE），不能理解记录内容，因此**无法做语义合并**；
- 允许离线编辑，恢复网络后增量提交；
- 删除必须能传播到长期离线的设备；
- 任何情况下不得静默丢失用户数据；
- 单用户多设备是默认场景，多用户是可选。

候选冲突策略：

1. Last-Write-Wins（按时间戳）
2. 服务端权威 + 悲观锁（占用/租约）
3. 乐观锁（`base_version`）+ 墓碑 + 客户端三方合并（本项目选择）
4. CRDT（每字段/每字符）

## 决策

采用**方案 3**，具体规则：

1. **逐记录版本**：服务端为每个 `record_id` 维护单调 `version`（从 1 起，每次成功提交 +1），提交响应与拉取结果中称为 `version`，冲突详情中称为 `server_version`。
2. **记录 ID 即实体 ULID**：`record_id` 直接使用实体主键（26 字符 ULID），对服务端是不透明字符串；**不做 HMAC 变换**，服务端无法据此推断内容（ULID 不含语义）。
3. **乐观锁提交**：`POST /v1/sync/commit`（必须带 `Idempotency-Key`）的每条变更携带 `base_version`：
   - `null` + 记录不存在 → 创建，`version=1`；
   - `null` + 记录已存在 → 冲突 `both_created`；
   - 等于当前 `version` → 应用，`version+1`；
   - 小于当前 `version` → 冲突，返回服务端当前密文与 `server_version`；
   - `deleted=true` → 写墓碑并 `version+1`（不要求密文）。
4. **响应语义**：存在冲突时仍返回 **200** `{applied[], conflicts[], new_cursor, head_seq}`，客户端必须同时处理 `applied` 与 `conflicts`；仅当请求整体不可处理（如 `base_cursor` 超前于 `head_seq`）返回 409 `SYNC_CONFLICT`。
5. **并发判定**：客户端收到 `conflicts[]` 后，以本地 `sync_base` 中保存的“上次成功同步版本对应的明文基线”判断：
   - 基线字段与本地改动、远端改动三方比较；
   - 仅一方改动 → 取该方（可自动合并且不提示）；
   - 双方改动且相同 → 取任一；
   - 双方改动且不同 → 进入冲突解决（§6）。
6. **三方合并**：以 `sync_base` 为共同祖先做**字段级**合并；可合并则解密远端、合并、重新加密并以 `base_version=server_version` 提交；不可合并则由用户在“保留本地 / 保留远端 / 逐字段合并 / 另存为副本”中选择。
7. **凭据整条不合并**：口令/私钥冲突一律由用户选择或另存为冲突副本，避免把两份不同私钥揉成不可用数据。
8. **删除墓碑**：`deleted=true` 产生墓碑（`record_id + version + deleted_at`），服务端保留 **90 天**；客户端游标越过墓碑前不得清理本地引用。离线设备用伸出的 `base_version` 提交删除后的修改会得到冲突，并看到墓碑，绝不“复活”已删除记录。
9. **绝不静默丢数据**：无法自动合并时保留本地内容为**冲突副本**（新 ULID、名称加“（冲突副本）”），并接受服务端版本；`sync_record` 中记录 `sync_state='conflict'` 与 `conflict_json`（含 `server_version`、`server_ciphertext`、`detected_at`）。
10. **确定性与幂等**：同一 `Idempotency-Key` 在 24 h 内重放返回首次响应；服务端按到达顺序单调分配 `seq`，客户端的 `base_cursor` 只能推进到整批事务应用成功之后。

### 关于版本向量（Q13）

`spec/sync-api.md` 与 `spec/data-model.md` 的线协议**没有版本向量字段**，只使用 `base_version` + 服务端 `version`。因此：

- 客户端**不得**在 `commit`/`changes` 中发送或期待 `vv`；
- 若需要在本地辅助区分“真并发”与“陈旧重试”，可在 `sync_base` 扩展表保存 `(record_id, device_id, counter)` 作为**纯本地启发式**，不参与协议、不影响服务端判定；若未来规范引入 `vv`，再升级协议版本。

## 理由

1. 服务端看不到明文，因此**唯一正确的位置是客户端**；把合并放在服务端会破坏 E2EE 承诺。
2. `version` + `base_version` 提供简单、可验证的乐观锁，且与 `spec/sync-api.md` 的 `applied`/`conflicts` 语义一致。
3. 200 + `conflicts[]` 让客户端一次拿到成功与失败，避免整批因个别冲突全部回滚，减少往返。
4. 字段级合并对会话/片段这类结构化记录体验最好；凭据不做自动合并，避免不可用数据。
5. 墓碑是离线设备收敛的必要条件；90 天覆盖绝大多数离线周期；超期设备的陈旧修改会被拒绝并提示重新拉取。
6. 与“服务端只存密文”完全兼容：冲突响应只返回密文，客户端解密后合并。

不选 LWW 的理由：设备时钟不可信，且“后写覆盖”会静默丢数据。
不选悲观锁的理由：移动/离线场景下租约容易僵死，用户体验差。
不选 CRDT 的理由：会话记录是结构化的低冲突对象，CRDT 的复杂度与存储成本远超收益；凭据字段也无法用 CRDT 表达。

## 后果

**正面**

- 无静默数据丢失；冲突可解释、可回退。
- 不同记录的并发修改互不干扰（记录级乐观锁）。
- 离线队列与幂等重试可安全重放。

**负面与缓解**

| 后果 | 缓解 |
|---|---|
| 客户端需保存基线明文，存储开销 | 只保存“上次同步版本”的单条基线；随记录删除而删除；大记录（> 256 KiB）改为整条冲突 |
| 冲突 UI 复杂 | 提供 4 个明确动作（保留本地/保留远端/逐字段合并/另存副本）；默认推荐合并结果 |
| 单批内部分冲突需要重试 | 客户端按 `applied[]` 更新本地版本，只对 `conflicts[]` 走合并/提示 |
| 服务端 90 天墓碑 GC 与离线设备冲突 | GC 前要求所有活跃设备游标已越过墓碑版本；否则延期 |
| 时间戳仅用于展示 | 合并判定只用 `base_version` 与 `sync_base`，不依赖时钟 |
| 属性测试难 | 对合并函数做收敛性/幂等/交换律属性测试（同一冲突集合任意顺序应用结果一致） |

## API 语义（与 `spec/sync-api.md` 对齐）

```
GET /v1/sync/changes?cursor=<n>&limit=<n>&include_deleted=true
→ 200 { changes: [{ seq, record_id, version, ciphertext_b64, checksum,
                    size, deleted, deleted_at, updated_at, device_id }],
        next_cursor, has_more, head_seq }

POST /v1/sync/commit      (Idempotency-Key: <uuid>)
  { base_cursor?,
    changes: [{ record_id, base_version | null, ciphertext_b64, checksum,
                deleted, client_updated_at }] }      // ≤ 500 条
→ 200 { applied:   [{ record_id, version, seq }],
        conflicts: [{ record_id, server_version, server_ciphertext_b64,
                      server_checksum, server_device_id }],
        new_cursor, head_seq }
→ 409 SYNC_CONFLICT   // 仅整体不可处理（如 base_cursor 超前）
```

## 验证与退出条件

- 双设备 e2e：A/B 同时改不同记录 → 无冲突；改同一记录不同字段 → 自动合并；改同一字段 → 冲突并可解决。
- 离线 7 天后重连 → 墓碑正确传播，不“复活”已删除记录。
- 幂等：同一 `Idempotency-Key` 重复提交 10 次，服务端只应用一次。
- 单批 500 条含 3 条冲突 → `applied` 与 `conflicts` 数量正确，无整批回滚。
- 属性测试：任意 3 个并发版本的合并结果在各端收敛一致。
- 若在 M4 发现字段级合并在真实数据上产生不可接受的歧义（例如会话认证字段被部分合并导致连接失败），退化为“整条记录冲突 + 用户选择”，并在 `docs/decisions.md` 记录。
