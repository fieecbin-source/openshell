# 更新签名公钥目录

这里只允许存放**公钥**（`<key-id>.pub`）和本说明，私钥绝不入库。

## 文件格式

```
# 注释行会被忽略
key_id = openshell-updater-2026a
status = active
created = 2026-11-04
public_key = <base64url 编码的 32 字节 Ed25519 公钥>
```

`status` 取值：

| 值 | 含义 |
| --- | --- |
| `active` | 当前签名密钥，正常接受 |
| `next` | 下一把密钥，提前内置以便轮换；单独签名也被接受 |
| `revoked` | 已吊销；即使签名有效也拒绝 |

构建时 `build.rs` 会把本目录下所有 `.pub` 编进客户端；没有任何公钥时，
客户端会**拒绝所有自动安装**并提示「签名未配置」，这是 fail-closed 预期行为。

## 生成与签名

密钥生成、签名与轮换流程见 [docs/RELEASING.md](../../../../docs/RELEASING.md) 的「更新签名密钥生命周期」。
工具位于 [`scripts/updater-sign.mjs`](../../../../scripts/updater-sign.mjs)。
