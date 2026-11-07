# gpt 内部子集证据

所有命令在仓库根目录执行；只使用合成字符串、临时 profile、回环服务。没有修改用户数据库、配置或历史备份，没有提交/推送。

开工时 ai、monitor、migrator 和 package scanner 的 `git diff --binary` 为空（PowerShell 空管道没有生成 baseline.diff）；app_services.rs 的既有修改由 root 的 `../baseline.diff` 保存。

## G03

- 根因：旧内容规则可从字符串内的 `Password: ` 跨过闭合引号，继续匹配压缩 JS；也遗漏 JSON 中带引号的秘密键。
- 新独立回归：`node --test scripts/check-package.test.mjs`。
- 修复前 exit 1：4 组中 2 组失败，合法 Telnet 提示误报、quoted JSON 秘密漏检。见 `package-red.log`。
- 修复后 exit 0：4 组通过，覆盖合法提示、空设置，unquoted/quoted/backtick/嵌套序列化的合成秘密，私钥头、禁止文件名与合成用户路径。见 `package-green.log`。
- 生产规则没有关闭；既有路径、私钥、CI token、私有指纹检测保留。测试进程的 APPDATA/HOME/USERPROFILE 指向临时目录，未读取真实用户连接数据库。
- 本子集未扫描实际安装包或当前生产构建产物，留 CEO 集中验收。

## AI 初次环境检查

- `cargo +stable-x86_64-pc-windows-msvc test -p openshell-ai --test http_completion --locked --offline --jobs 2` 首次 exit 101。
- 本机 HTTP_PROXY/HTTPS_PROXY 污染回环测试，正常响应被代理成 HTTP 5xx。`ai-red.log` 仅记录环境失败，不能作为 BUG-021/022 有效红测试。后续有效网络验证须在该测试进程设置 `NO_PROXY=*` / `no_proxy=*`。
- 代 root 执行 `cargo +stable-x86_64-pc-windows-msvc test -p openshell-core-domain proxy_password_is_never_serialized --locked --offline --jobs 2` exit 101；Cargo.lock 当时需要更新，测试未执行。见 `root-domain-red.log`。本子集没有改变锁文件。
