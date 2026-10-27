# OpenShell {{version}}

> 由 `node scripts/release.mjs notes --from <上一个 tag>` 生成初稿，**发布前请人工校对**：
> 删除内部重构条目、补上用户可感知的细节，并检查「升级提示」是否仍然成立。

## 更新亮点

- 

## 修复

- 

## 已知问题

- 

## 升级提示

- 安装前会自动把本地数据库快照到用户数据目录的 `backups/`，升级失败会自动回滚。
- 覆盖安装不会删除连接配置、密钥与历史记录；卸载时数据目录同样保留。
- 若系统提示「未知发布者」，请核对 Release 附带的 `SHA256SUMS.txt`：

  ```bash
  sha256sum -c SHA256SUMS.txt
  ```

## 安装包

| 平台 | 文件 |
| --- | --- |
| Windows | `OpenShell-{{version}}-windows-x86_64.exe` |
| macOS（Intel / Apple Silicon） | `OpenShell-{{version}}-macos-universal.dmg` |
| Linux | `OpenShell-{{version}}-linux-x86_64.AppImage` |

## 校验与自动更新

- `SHA256SUMS.txt`：所有资产的 sha256 清单。
- `update-meta.json`：自动更新使用的哈希与强更声明。
- `latest.json`：备用检测源（jsDelivr / 自建镜像）使用的版本清单。
