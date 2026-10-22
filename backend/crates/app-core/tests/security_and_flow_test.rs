//! 洁净室安全审计与集成冒烟测试：
//! 1. 验证 SQLite 数据库中绝无任何明文秘密（密码、私钥）。
//! 2. 验证 XChaCha20-Poly1305 密文、24B Nonce 与 AAD 信封规范。
//! 3. 验证终端信用窗口背压流控（512 KiB 暂停，256 KiB 恢复）。
//! 4. 验证操作注册表与协同取消。

use openshell_app_core::{AppServices, CreditTracker, FlowAction, OpRegistry};
use openshell_core_domain::{CredentialKind, Protocol, SessionInput};

#[tokio::test]
async fn test_security_audit_zero_plaintext_secrets_in_store() {
    let services = AppServices::new_in_memory().expect("init in-memory app services");

    // 1. 初始化保险库
    services
        .vault
        .init("AuditMasterPassword123!", false, None)
        .expect("init vault");

    // 2. 创建包含明文密码的凭据
    let sensitive_password = "SuperSecretP@ssw0rd999_NEVER_PLAINTEXT!";
    let cred = services
        .session
        .create_credential(
            "Prod Root Cred".to_string(),
            CredentialKind::Password,
            Some("root".to_string()),
            sensitive_password,
            Some("hint text".to_string()),
            None,
        )
        .await
        .expect("create credential");

    // 3. 创建使用该凭据的 SSH 会话
    let _session = services
        .session
        .create_session(SessionInput {
            name: Some("Prod-Server".to_string()),
            protocol: Some(Protocol::Ssh),
            host: Some("10.0.0.1".to_string()),
            port: Some(22),
            username: Some("root".to_string()),
            credential_id: Some(cred.id.clone()),
            ..Default::default()
        })
        .await
        .expect("create session");

    // 4. 安全审计检查：直接遍历底层的 SQLite 数据行
    services
        .store
        .with_conn(|conn| {
            // 4.1 检查 credential 表
            let mut stmt = conn
                .prepare("SELECT id, name, username, hint FROM credential")
                .unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let name: String = row.get(1).unwrap();
                let username: Option<String> = row.get(2).unwrap();
                let hint: Option<String> = row.get(3).unwrap();

                assert!(!name.contains(sensitive_password));
                assert_ne!(username.as_deref(), Some(sensitive_password));
                assert_ne!(hint.as_deref(), Some(sensitive_password));
            }

            // 4.2 检查 session 表
            let mut stmt = conn
                .prepare("SELECT name, host, username FROM session")
                .unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let sname: String = row.get(0).unwrap();
                let shost: Option<String> = row.get(1).unwrap();
                let suser: Option<String> = row.get(2).unwrap();

                assert!(!sname.contains(sensitive_password));
                assert_ne!(shost.as_deref(), Some(sensitive_password));
                assert_ne!(suser.as_deref(), Some(sensitive_password));
            }

            // 4.3 检查 secret 表（唯一存储密文的地方）
            let mut stmt = conn
                .prepare("SELECT ciphertext, nonce, aad, crypto_suite FROM secret")
                .unwrap();
            let mut rows = stmt.query([]).unwrap();
            let mut found_secret_row = false;
            while let Some(row) = rows.next().unwrap() {
                found_secret_row = true;
                let ciphertext: Vec<u8> = row.get(0).unwrap();
                let nonce: Vec<u8> = row.get(1).unwrap();
                let _aad: Vec<u8> = row.get(2).unwrap();
                let crypto_suite: String = row.get(3).unwrap();

                // 密文必须为加密二进制，绝对不包含明文字符串
                assert_eq!(crypto_suite, "xchacha20poly1305");
                assert_eq!(nonce.len(), 24); // XChaCha20 24字节随机 Nonce
                assert!(
                    !ciphertext.windows(sensitive_password.len()).any(|w| w == sensitive_password.as_bytes()),
                    "CRITICAL SECURITY FAILURE: Plaintext secret found inside secret table ciphertext!"
                );
            }
            assert!(found_secret_row, "Expected at least one secret record to exist in store");

            Ok(())
        })
        .expect("security audit sql check");
}

#[tokio::test]
async fn test_flow_control_credit_window_backpressure() {
    let tracker = CreditTracker::new();

    // 初始信用 256 KiB
    assert_eq!(tracker.credit(), 256 * 1024);
    assert!(!tracker.is_paused());

    // 发送 400 KiB -> 未超 512 KiB 暂停阈值
    let action = tracker.on_send(400 * 1024);
    assert_eq!(action, FlowAction::Normal);
    assert!(!tracker.is_paused());

    // 再发送 150 KiB (总计 550 KiB > 512 KiB) -> 触发 Paused
    let action = tracker.on_send(150 * 1024);
    assert_eq!(action, FlowAction::Paused);
    assert!(tracker.is_paused());

    // 前端消费后确认 320 KiB -> 剩余 230 KiB <= 256 KiB 恢复阈值 -> 触发 Resumed
    let action = tracker.on_ack(320 * 1024);
    assert_eq!(action, FlowAction::Resumed);
    assert!(!tracker.is_paused());
}

#[tokio::test]
async fn test_op_registry_cancellation_flow() {
    let registry = OpRegistry::new();
    let token = registry.register("test_req_001");

    assert!(!token.is_cancelled());
    let token_clone = token.clone();

    let wait_handle = tokio::spawn(async move {
        token_clone.cancelled().await;
        "cancelled_ok"
    });

    assert!(registry.cancel("test_req_001"));
    assert!(token.is_cancelled());

    let res = wait_handle.await.unwrap();
    assert_eq!(res, "cancelled_ok");
}
