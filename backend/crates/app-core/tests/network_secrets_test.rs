use openshell_app_core::AppServices;
use openshell_core_domain::{
    PortForwardRepository, PortForwardRuleInput, ProxyServerInput, SecretId, SessionQuery,
};
use openshell_importer::FinalShellParser;
use openshell_store::BackupReason;

#[tokio::test]
async fn new_network_passwords_do_not_appear_in_database_wal_backup_or_json() {
    let directory = tempfile::tempdir().unwrap();
    let app = AppServices::new(directory.path().into()).unwrap();
    app.vault
        .init("isolated-master-password", false, None)
        .unwrap();
    let proxy_password = format!("synthetic-proxy-{}", SecretId::new());
    let socks_password = format!("synthetic-socks-{}", SecretId::new());
    let proxy: ProxyServerInput = serde_json::from_value(serde_json::json!({
        "id":"proxy-test","name":"proxy-test","proxy_type":"socks5","host":"127.0.0.1","port":1080,"password":proxy_password
    })).unwrap();
    let proxies = app.network_secrets.save_proxies(vec![proxy]).unwrap();
    let input = app
        .network_secrets
        .prepare_forward(
            PortForwardRuleInput {
                name: "socks-test".into(),
                bind_port: 1081,
                socks_password: Some(socks_password.clone()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let rule = app.port_forward_repo.create(input).await.unwrap();
    let backup = app.backup_now(BackupReason::Manual).unwrap();
    let json = serde_json::to_vec(&(proxies, rule)).unwrap();
    let export = app.archive.export_json().await.unwrap().into_bytes();
    let mut artifacts = vec![
        json,
        export,
        std::fs::read(&app.paths.db_path).unwrap(),
        std::fs::read(backup.path).unwrap(),
    ];
    let wal = app.paths.db_path.with_file_name("openshell.db-wal");
    if wal.exists() {
        artifacts.push(std::fs::read(wal).unwrap());
    }
    for artifact in artifacts {
        for password in [&proxy_password, &socks_password] {
            assert!(!artifact
                .windows(password.len())
                .any(|part| part == password.as_bytes()));
        }
    }
}

/// R02 回归：FinalShell 导入的认证隧道既不落库口令，也不会被降级成无认证规则。
#[tokio::test]
async fn finalshell_embedded_forward_credentials_never_reach_database_export_or_backup() {
    let directory = tempfile::tempdir().unwrap();
    let app = AppServices::new(directory.path().into()).unwrap();
    app.vault
        .init("isolated-master-password", false, None)
        .unwrap();
    let password = format!("synthetic-finalshell-{}", SecretId::new());
    let source = serde_json::json!([{
        "host":"ssh.test", "connection_type":100, "port_forwarding_list":[
            {"name":"socks","type":300,"port":1080,
             "socks_auth":"user_pass","socks_username":"ops","socks_password":password},
            {"name":"web","type":100,"port":8080,"dst_address":"10.0.0.5","dst_port":80}
        ]
    }]);
    let mut inputs = FinalShellParser::parse_json(&source.to_string()).unwrap();
    let session = app.session.create_session(inputs.remove(0)).await.unwrap();

    // 端口转发规则没有随会话创建（本次导入路径只落会话），
    // 带认证的隧道在预览里已被明确阻断，不会变成无认证规则。
    assert!(app
        .port_forward_repo
        .list(Some(&session.id))
        .await
        .unwrap()
        .is_empty());

    let export = app.archive.export_json().await.unwrap().into_bytes();
    let backup = app.backup_now(BackupReason::Manual).unwrap();
    let mut artifacts = vec![
        export,
        serde_json::to_vec(
            &app.session
                .list_sessions(&SessionQuery::default())
                .await
                .unwrap(),
        )
        .unwrap(),
        std::fs::read(&app.paths.db_path).unwrap(),
        std::fs::read(backup.path).unwrap(),
    ];
    let wal = app.paths.db_path.with_file_name("openshell.db-wal");
    if wal.exists() {
        artifacts.push(std::fs::read(wal).unwrap());
    }
    for artifact in artifacts {
        assert!(!artifact
            .windows(password.len())
            .any(|part| part == password.as_bytes()));
    }

    // 会话 JSON 只留阻断标记，认证字段一个都不剩。
    let sessions = app
        .session
        .list_sessions(&SessionQuery::default())
        .await
        .unwrap();
    let stored = serde_json::to_string(&sessions).unwrap();
    assert!(!stored.contains(&password));
    let entry = sessions[0]
        .protocol_options_json
        .as_ref()
        .unwrap()
        .get("port_forwarding_list")
        .and_then(|value| value.get(0))
        .and_then(|value| value.as_object())
        .expect("blocked forward entry");
    for key in [
        "socks_auth",
        "socks_username",
        "socks_password",
        "socks_password_ref",
    ] {
        assert!(
            !entry.contains_key(key),
            "{key} leaked into the stored session"
        );
    }
    assert!(entry.contains_key("import_blocked"));
}
