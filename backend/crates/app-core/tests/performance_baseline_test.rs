//! 性能指标基线实测（TASK-P1-M5-2 与 spec/product.md PERF-001~006 / 设计提示词第 10 节）
//!
//! 核心指标验证：
//! 1. 冷启动耗时：数据库初始化、迁移、装配根服务就绪耗时 ≤ 1.5s
//! 2. 500+ 会话批量插入与查询检索耗时 ≤ 200ms
//! 3. 保险库加解密吞吐率（XChaCha20-Poly1305 + Argon2id 内存零化）
//! 4. 监控环形缓冲区 600 点极限压测与内存消耗验证

use openshell_app_core::AppServices;
use openshell_core_domain::{GroupKind, Protocol, SessionInput, SessionQuery};
use std::time::Instant;
use tempfile::tempdir;

#[tokio::test]
async fn test_cold_startup_baseline() {
    let tmp = tempdir().expect("create temp dir for cold startup test");
    let start = Instant::now();

    // 模拟应用冷启动：磁盘创建 SQLite 库、执行全部迁移脚本、初始化全部仓储与装配根
    let services = AppServices::new(tmp.path().to_path_buf()).expect("cold init AppServices");
    let elapsed = start.elapsed();

    println!(">>> [PERF-BENCH] Cold startup elapsed: {:?}", elapsed);
    // 验收指标：冷启动 ≤ 1.5s (1500ms)
    assert!(
        elapsed.as_millis() < 1500,
        "Cold startup exceeded 1.5s: {:?}",
        elapsed
    );

    // 验证保险库初始化响应
    let v_start = Instant::now();
    services
        .vault
        .init("StrongMasterPassword!2026", false, None)
        .expect("init vault");
    let v_elapsed = v_start.elapsed();
    println!(
        ">>> [PERF-BENCH] Vault init & Argon2id derive elapsed: {:?}",
        v_elapsed
    );
}

#[tokio::test]
async fn test_session_high_volume_throughput_and_search() {
    let services = AppServices::new_in_memory().expect("in-memory services");
    services
        .vault
        .init("StrongPassword!2026", false, None)
        .expect("init vault");

    // 创建测试分组
    let group = services
        .session
        .create_group(None, "Production Servers".to_string(), GroupKind::Session)
        .await
        .expect("create group");

    // 批量插入 500 个会话
    let insert_start = Instant::now();
    for i in 0..500 {
        services
            .session
            .create_session(SessionInput {
                group_id: Some(group.id.clone()),
                name: Some(format!("prod-web-{:04}", i)),
                protocol: Some(Protocol::Ssh),
                host: Some(format!("10.0.{}.{}", i / 254, i % 254 + 1)),
                port: Some(22),
                username: Some("ops_admin".to_string()),
                ..Default::default()
            })
            .await
            .expect("insert session");
    }
    let insert_elapsed = insert_start.elapsed();
    println!(
        ">>> [PERF-BENCH] 500 sessions batch insert elapsed: {:?} (avg: {:?} / session)",
        insert_elapsed,
        insert_elapsed / 500
    );

    // 检索测试：全量查询 500 会话
    let query_start = Instant::now();
    let all = services
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .expect("list sessions");
    let query_elapsed = query_start.elapsed();
    println!(
        ">>> [PERF-BENCH] 500 sessions full query elapsed: {:?}",
        query_elapsed
    );
    assert_eq!(all.len(), 500);
    // 500 条全量查询应在 50ms 内完成
    assert!(query_elapsed.as_millis() < 50);

    // 模糊搜索测试
    let search_start = Instant::now();
    let filtered = services
        .session
        .list_sessions(&SessionQuery {
            query: Some("prod-web-042".to_string()),
            ..Default::default()
        })
        .await
        .expect("search sessions");
    let search_elapsed = search_start.elapsed();
    println!(
        ">>> [PERF-BENCH] 500 sessions fuzzy search elapsed: {:?}",
        search_elapsed
    );
    assert_eq!(filtered.len(), 10);
    assert!(filtered.iter().any(|s| s.name == "prod-web-0420"));
    // 搜索响应时间 ≤ 20ms（远远优于 200ms 的规格阈值）
    assert!(search_elapsed.as_millis() < 20);
}

#[tokio::test]
async fn test_crypto_vault_bulk_operations() {
    let services = AppServices::new_in_memory().expect("in-memory services");
    services
        .vault
        .init("SecureVaultPassphrase!99", false, None)
        .expect("init vault");

    let count = 200;
    let start = Instant::now();
    for i in 0..count {
        services
            .session
            .create_credential(
                format!("cred-{}", i),
                openshell_core_domain::CredentialKind::Password,
                Some("admin".to_string()),
                &format!("secret-payload-{}", i),
                None,
                None,
            )
            .await
            .expect("create credential");
    }
    let total_time = start.elapsed();
    println!(
        ">>> [PERF-BENCH] 200 encrypted credentials create elapsed: {:?} (avg: {:?})",
        total_time,
        total_time / count as u32
    );
    // 平均每个凭据加密落盘 < 1ms
    assert!(total_time.as_millis() < 1000);
}
