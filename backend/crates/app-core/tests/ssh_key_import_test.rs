use openshell_app_core::AppServices;
use openshell_ssh::russh::keys::{self, ssh_key, PrivateKey};

fn private_key() -> PrivateKey {
    PrivateKey::new(
        ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]).into(),
        "import test",
    )
    .unwrap()
}

fn services() -> AppServices {
    let services = AppServices::new_in_memory().unwrap();
    services
        .vault
        .init("TestVaultPassword123!", false, None)
        .unwrap();
    services
}

#[tokio::test]
async fn encrypted_key_is_saved_only_after_a_correct_passphrase() {
    let services = services();
    let pem = private_key()
        .encrypt(&mut keys::key::safe_rng(), "correct")
        .unwrap()
        .to_openssh(ssh_key::LineEnding::LF)
        .unwrap();
    for passphrase in [None, Some("wrong".to_string())] {
        let error = services
            .session
            .import_ssh_key("生产主机".into(), &pem, passphrase, None)
            .await
            .expect_err("missing or wrong passphrase must not save");
        assert!(error.message.contains("口令"));
        assert!(services.session.list_ssh_keys().await.unwrap().is_empty());
    }
    let saved = services
        .session
        .import_ssh_key("  生产主机  ".into(), &pem, Some("correct".into()), None)
        .await
        .unwrap();
    assert_eq!(saved.name, "生产主机");
    assert!(saved.has_passphrase);
    assert_eq!(services.session.list_ssh_keys().await.unwrap().len(), 1);
}

#[tokio::test]
async fn unencrypted_key_needs_no_passphrase_and_public_keys_are_rejected() {
    let services = services();
    let key = private_key();
    let pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
    assert!(services
        .session
        .import_ssh_key("  ".into(), &pem, None, None)
        .await
        .is_err());
    assert!(services
        .session
        .import_ssh_key(
            "公钥".into(),
            &key.public_key().to_openssh().unwrap(),
            None,
            None
        )
        .await
        .is_err());
    assert!(services
        .session
        .import_ssh_key("错误文件".into(), "Host example", None, None)
        .await
        .is_err());
    assert!(services.session.list_ssh_keys().await.unwrap().is_empty());
    let saved = services
        .session
        .import_ssh_key("未加密私钥".into(), &pem, None, None)
        .await
        .unwrap();
    assert_eq!(saved.name, "未加密私钥");
    assert!(!saved.has_passphrase);
}

#[tokio::test]
async fn encrypted_pkcs8_key_requires_a_valid_passphrase() {
    let services = services();
    let mut pem = Vec::new();
    keys::encode_pkcs8_pem_encrypted(&private_key(), b"correct", 1000, &mut pem).unwrap();
    let pem = String::from_utf8(pem).unwrap();
    for passphrase in [None, Some("wrong".to_string())] {
        assert!(services
            .session
            .import_ssh_key("PEM 私钥".into(), &pem, passphrase, None)
            .await
            .is_err());
        assert!(services.session.list_ssh_keys().await.unwrap().is_empty());
    }
    assert!(
        services
            .session
            .import_ssh_key("PEM 私钥".into(), &pem, Some("correct".into()), None)
            .await
            .unwrap()
            .has_passphrase
    );
}
