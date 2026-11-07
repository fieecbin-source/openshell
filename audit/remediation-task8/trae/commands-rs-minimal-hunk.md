# Task8 · trae 交 CEO：`commands.rs` 路由测试最小 hunk 提案

`backend/desktop/src/commands.rs` 属 CEO 保留的共享入口，本人**未修改**。本提案只供 CEO 集成，
用于补齐 Task7 报告「命令层 `rdp_close` 失败保留 entry 后重试仅静态检查」的缺口：
`rdp_process.rs` 的 helper 测试只能证明 kill 失败保留 child/状态文件，**不能**证明命令注册表
在 `rdp_close` 失败后仍保留 `rdp_launches()` 中的 entry、从而让前端对同一 `launch_id` 的重试有效。

## 插入位置

`backend/desktop/src/commands.rs` 的 `#[cfg(test)] mod protocol_command_tests` 内
（现有 `use super::*;` 已能访问私有的 `rdp_launches()` 与 `RdpRuntimeEntry`，
参见同模块 `application_exit_closes_owned_rdp_launches_and_files`）。

## 最小 hunk（未应用，待 CEO 决定）

```rust
    #[tokio::test]
    async fn task8_rdp_close_failure_retains_launch_entry_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        // 目录路径使 rdp_process::cleanup 的 remove_file 返回 Err（Windows 为 PermissionDenied），
        // 让 rdp_close 走 Err 分支；child: None 避免唤起真实 mstsc。
        let blocked = directory.path().join("blocked-directory");
        std::fs::create_dir(&blocked).unwrap();
        // 全局 RDP_LAUNCHES 是进程级共享状态：用唯一 id 并在结尾移除，不调用 shutdown_rdp_launches()
        let launch_id = format!("task8-rdp-close-retry-{}", std::process::id());
        rdp_launches().lock().unwrap().insert(
            launch_id.clone(),
            RdpRuntimeEntry {
                session_id: String::new(),
                state: "launched",
                error: None,
                exit_code: None,
                child: None,
                file: blocked.clone(),
                events: None,
                reader: None,
                recorded_login: false,
            },
        );

        // 第一次关闭失败：entry 必须保留并标记 failed，前端才能按同一 launch_id 重试
        assert!(rdp_close(launch_id.clone()).await.is_err());
        {
            let launches = rdp_launches().lock().unwrap();
            let entry = launches
                .get(&launch_id)
                .expect("failed cleanup must retain the launch entry for retry");
            assert_eq!(entry.state, "failed");
            assert!(entry.error.is_some());
        }

        // 移除阻塞目录后，对同一 launch_id 重试成功：entry 仍在且转为 closed
        std::fs::remove_dir(&blocked).unwrap();
        assert!(rdp_close(launch_id.clone()).await.is_ok());
        {
            let launches = rdp_launches().lock().unwrap();
            let entry = launches
                .get(&launch_id)
                .expect("successful cleanup must retain the launch entry");
            assert_eq!(entry.state, "closed");
            assert!(entry.error.is_none());
        }
        rdp_launches().lock().unwrap().remove(&launch_id);
    }
```

## 事实依据（只读核对）

- `commands.rs:2552-2573` `rdp_close`：`rdp_process::close` 返回 Err 时只把 `entry.state`
  置 `"failed"` 并 `return Err(error.into())`，**不**从 `rdp_launches()` 移除 entry；
  成功路径置 `"closed"` 并清空 `error`。
- `rdp_process.rs:20-49` `close` → `close_with_kill`：`child` 为 `None` 时跳过 kill，
  直接 `cleanup(file)`；`rdp_process.rs:51-57` `cleanup` 对 `NotFound` 视为成功，
  其余（含目录）如实返回 Err。
- `commands.rs:34-40` `RDP_LAUNCHES` 为 `OnceLock<Mutex<HashMap<...>>>`，进程级共享。
- 前端 `terminalStore.ts:629-647` `retryRdpCleanups` 对记录的同一 `launchId` 重新发真实
  `rdpClose`；`TerminalTabs.test.tsx` 已覆盖该按钮的失败保留 / 重试成功消失。

## 集成注意（交 CEO 决策）

1. `RDP_LAUNCHES` 是进程级全局 map，同模块既有测试
   `application_exit_closes_owned_rdp_launches_and_files`（`commands.rs:2581-2608`）会
   `shutdown_rdp_launches()` **drain 整个 map**。若并行运行，两个用例可能互相清空；
   请 CEO 决定串行化方式或改为非共享注入点，不要靠加 `#[ignore]` / skip / allow 绕过。
2. 失败注入依赖 Windows 上 `remove_file(目录)` 返回 Err；非 Windows 平台若有差异需另选注入点。
3. 本提案不新增依赖、不改 IPC 签名、不改生产代码；只增加一个 `#[tokio::test]`。
4. 该测试只证明命令注册表层面的保留/重试契约，不等于真实 mstsc / RDP / NLA 成功登录。
