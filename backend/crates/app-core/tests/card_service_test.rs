use openshell_app_core::AppServices;
use openshell_core_domain::{CardMode, CardState, Protocol, SessionInput};

#[tokio::test]
async fn test_session_card_lifecycle_and_mode_switching() {
    let services = AppServices::new_in_memory().unwrap();
    let _ = services.vault.init("MasterPass123!", false, None).unwrap();

    // 创建 SSH 会话
    let ssh_session = services
        .session
        .create_session(SessionInput {
            name: Some("SSH-Server-1".to_string()),
            protocol: Some(Protocol::Ssh),
            host: Some("127.0.0.1".to_string()),
            port: Some(22),
            username: Some("root".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    // 1. 创建视图卡
    let card = services
        .card
        .create_card(&ssh_session.id)
        .await
        .expect("create card");
    assert_eq!(card.state, CardState::Connecting);
    assert_eq!(card.current_mode, CardMode::Command);
    assert_eq!(card.protocol, Protocol::Ssh);

    // 2. 标记连接就绪
    let connected = services
        .card
        .mark_connected(&card.card_id, None)
        .expect("mark connected");
    assert_eq!(connected.state, CardState::Connected);

    // 3. 模式切换：命令模式 -> 视图模式
    let view_card = services
        .card
        .set_mode(&card.card_id, CardMode::View)
        .expect("switch to view");
    assert_eq!(view_card.current_mode, CardMode::View);

    // 4. 模式切换：视图模式 -> 命令模式
    let cmd_card = services
        .card
        .set_mode(&card.card_id, CardMode::Command)
        .expect("switch back to command");
    assert_eq!(cmd_card.current_mode, CardMode::Command);

    // 5. 模拟网络异常断开
    let disconn = services
        .card
        .mark_disconnected(&card.card_id, Some("Connection reset by peer".to_string()))
        .expect("mark disconnected");
    assert_eq!(disconn.state, CardState::Disconnected);

    // 6. 重新连接中
    let reconn = services
        .card
        .mark_reconnecting(&card.card_id)
        .expect("mark reconnecting");
    assert_eq!(reconn.state, CardState::Reconnecting);

    // 7. 再次恢复在线
    let recovered = services
        .card
        .mark_connected(&card.card_id, None)
        .expect("recover connected");
    assert_eq!(recovered.state, CardState::Connected);

    // 8. 关闭卡片
    let _ = services.card.close_card(&card.card_id).unwrap();
    assert!(services.card.get_card(&card.card_id).is_err());
}

#[tokio::test]
async fn test_serial_card_disallows_view_mode() {
    let services = AppServices::new_in_memory().unwrap();
    let _ = services.vault.init("MasterPass123!", false, None).unwrap();

    // 创建 Serial 会话
    let serial_session = services
        .session
        .create_session(SessionInput {
            name: Some("Serial-COM3".to_string()),
            protocol: Some(Protocol::Serial),
            port: None,
            host: None,
            ..Default::default()
        })
        .await
        .unwrap();

    let card = services
        .card
        .create_card(&serial_session.id)
        .await
        .expect("create serial card");
    assert_eq!(card.protocol, Protocol::Serial);

    // 验证：串口会话严禁切到视图模式（spec/session-card.md）
    let switch_res = services.card.set_mode(&card.card_id, CardMode::View);
    assert!(switch_res.is_err());
    let err_msg = switch_res.unwrap_err().to_string();
    assert!(err_msg.contains("串口连接仅支持命令模式"));
}

#[tokio::test]
async fn test_multi_card_isolation_and_lifecycle() {
    let services = AppServices::new_in_memory().unwrap();
    let _ = services.vault.init("MasterPass123!", false, None).unwrap();

    let s1 = services
        .session
        .create_session(SessionInput {
            name: Some("Server-Alpha".to_string()),
            protocol: Some(Protocol::Ssh),
            host: Some("192.168.1.10".to_string()),
            username: Some("root".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    let s2 = services
        .session
        .create_session(SessionInput {
            name: Some("Server-Beta".to_string()),
            protocol: Some(Protocol::Ssh),
            host: Some("192.168.1.20".to_string()),
            username: Some("admin".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    // 1. 同时创建两张卡片（多服务器并发）
    let card1 = services.card.create_card(&s1.id).await.unwrap();
    let card2 = services.card.create_card(&s2.id).await.unwrap();

    assert_ne!(card1.card_id, card2.card_id);
    assert_eq!(services.card.list_cards().len(), 2);

    // 2. 卡片 1 切为视图模式，卡片 2 保持命令模式（互不干扰）
    let _ = services.card.set_mode(&card1.card_id, CardMode::View).unwrap();
    let c1 = services.card.get_card(&card1.card_id).unwrap();
    let c2 = services.card.get_card(&card2.card_id).unwrap();
    assert_eq!(c1.current_mode, CardMode::View);
    assert_eq!(c2.current_mode, CardMode::Command);

    // 3. 关闭卡片 1，卡片 2 保持在线
    let _ = services.card.close_card(&card1.card_id).unwrap();
    assert_eq!(services.card.list_cards().len(), 1);
    assert!(services.card.get_card(&card1.card_id).is_err());
    assert!(services.card.get_card(&card2.card_id).is_ok());
}

