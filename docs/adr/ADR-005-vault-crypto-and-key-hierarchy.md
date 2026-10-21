# ADR-005：保险库加密与密钥分层

- 状态：已接受（M1）
- 日期：2026-10-21
- 关联：`docs/architecture.md` §9、ADR-004、ADR-006

## 背景

需要满足：

- 落盘无明文凭据（口令、私钥、passphrase 等），错误主密码无法解密；
- 跨平台（Windows/macOS/Linux），不依赖系统 DPAPI 一类单平台能力；
- 支持端到端同步：服务端只见密文；
- 改主密码不应重加密全部数据；
- 用户忘记主密码即无法恢复（可接受，需明确告知）；
- 可选系统钥匙串提升日常体验，但不能成为唯一解锁途径。

候选方案：

1. 主密码 → Argon2id → 直接作为数据密钥（无分层）
2. 主密码 → KDF → KEK → 包裹随机 VaultKey → 按记录派生子密钥（本项目选择）
3. 整库加密（SQLCipher 或自封装容器）
4. 仅用系统钥匙串保管随机密钥（无主密码）

## 决策

采用**方案 2**（与 `spec/data-model.md` §6.1 一致）：

```
master password ──Argon2id(m=64 MiB, t=3, p=1, salt 16B)──► KEK(32B)
KEK ──XChaCha20-Poly1305──► VaultKey(32B)   [vault.wrapped_vault_key]
VaultKey ──HKDF-SHA256(salt=utf8(record_id), info="openshell/v1/record")──► RecordKey(32B)
RecordKey ──XChaCha20-Poly1305──► ciphertext（本地与同步同一份）
```

- **密钥槽**：全部在 `vault` 行——`crypto_suite, kdf_alg, kdf_mem_kib, kdf_time, kdf_parallelism, kdf_salt, wrapped_vault_key, key_check, keychain_ref`；不引入独立密钥文件。
- **信封**：`wrapped_vault_key = [u8 1][24B nonce][32B ct][16B tag]`，AAD = `b"oskey-slot-v1" ‖ vault_id ‖ u32be(key_version)`；`key_check` 用 VaultKey 加密固定串，校验密码是否正确。
- **AEAD**：XChaCha20-Poly1305，24 B 随机 nonce；AAD = `vault_id ‖ record_id ‖ record_type ‖ key_version ‖ schema_version`（spec B-03），**不绑定服务端 `version`**。
- **自动锁定**：默认空闲 15 min、系统休眠/锁屏立即锁定；锁定即 zeroize VaultKey 与派生密钥。
- **钥匙串**：可选，仅保存 `wrapped_vault_key` + `vault_id`/`key_version`；默认关闭；不可用时回退密码解锁。
- **导出**：`.osvault`（magic `OSVLT1`、4 B 大端头长度、明文 JSON 头、AEAD 载荷、尾部 SHA-256），独立 salt/passphrase。

## 理由

1. **分层**让改主密码只需重包裹 VaultKey（O(1)），避免全库重加密；钥匙串与密码解锁共用同一 VaultKey。
2. **逐记录密钥派生**（salt=record_id）使密文与记录一一绑定，服务端无法跨记录复用；本地与同步使用同一份密文，满足 E2EE 与 B-08。
3. **AAD 绑定**防止"密文搬运"（A 记录塞入 B 记录）与跨 key_version/schema 重放。
4. **XChaCha20** 的 24 B nonce 可纯随机生成，几乎消除 nonce 重用风险；跨平台无 AES 硬件依赖。
5. **Argon2id 64 MiB / t=3 / p=1** 在桌面端约 0.3–1.0 s；参数存 `vault` 行，可升级并保留旧参数解密历史备份。
6. 不选 SQLCipher：额外 C 依赖与构建复杂度，且无法自然支持"记录级 AAD"与端到端同步的独立密钥体系。

## 后果

**正面**

- 主密码错误只能表现为解包/校验失败（统一 `VAULT_DECRYPT_FAILED`），不泄露"密码接近正确"的信息。
- 服务端只接触与本地相同的密文，无法解密任何记录。
- 改主密码是常数时间操作；VaultKey 轮换可后台渐进执行。

**负面与缓解**

| 后果 | 缓解 |
|---|---|
| Argon2 64 MiB 在低内存设备可能失败/卡顿 | 解锁前检测可用内存；低配档参数（32 MiB/t=3/p=1）写入 `vault` 行，旧参数保留以解历史备份；UI 显示进度 |
| 主密码遗忘 = 数据不可恢复 | 首次创建时强制确认 + 明确文案；不设后门恢复密钥 |
| 内存中密钥可能被换出/被同用户进程读取 | `zeroize` + `secrecy`；Windows 尽力 `VirtualLock`；不承诺对抗本机管理员 |
| 本地元数据（主机名/用户名）可能明文落盘 | 同步侧一律加密；本地可选 `privacy.encrypt_metadata`（Q4 待 spec 明确） |
| 随机数源异常 | 仅使用 `getrandom`/`OsRng`；启动自检失败直接拒绝创建保险库 |
| 导出包被离线暴力破解 | 导出使用独立 passphrase + 独立 salt；默认不导出秘密 |

## 实现约束

1. 所有 AEAD 调用集中在 `crates/vault::RecordCipher`，业务代码不得直接使用 `chacha20poly1305`。
2. nonce 只能由 `RecordCipher` 生成；禁止复用；每次写入（包括"同内容再保存"）必须新 nonce。
3. 密钥槽随 `vault` 行在同一事务写入；写入前后校验 `wrapped_vault_key` 长度与版本；`key_check` 必须与密钥槽同时更新。
4. 单元测试必须覆盖：正确密码、错误密码、篡改密钥槽、篡改密文、AAD 不匹配、跨记录搬运失败、改密后旧密码失效、`key_version` 不匹配失败。
5. 锁定路径必须可测：注入时钟，断言 15 min 后自动锁定且密钥已 zeroize（通过测试钩子检查缓冲区全零）。
6. 主密码强度：最少 10 字符；前端只做提示，不做静默截断；失败限速（5 次 → 30 s，翻倍至上限 5 min）。

## 验证与退出条件

- 落盘扫描：测试在解锁并写入凭据后，对 `openshell.db`、WAL、日志、临时目录做字符串扫描，断言不含明文口令/私钥。
- 性能：参考机解锁 p50 ≤ 1.0 s；低配档 ≤ 2.5 s。
- 安全审查（独立 agent）确认无 nonce 重用、无明文密钥落盘、无日志泄漏；高危项为 0 方可进入 M4。
