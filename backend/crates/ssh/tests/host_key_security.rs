use async_trait::async_trait;
use openshell_core_domain::{
    AuthMethod, ConnectionId, DomainResult, ErrorCode, HostKeyPolicy, KnownHost, KnownHostId,
    KnownHostRepository, SessionId,
};
use openshell_ssh::{ConnectOptions, SshConnection};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Hosts(Mutex<Vec<KnownHost>>);

#[async_trait]
impl KnownHostRepository for Hosts {
    async fn find(&self, host: &str, port: u16, kind: &str) -> DomainResult<Option<KnownHost>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.host == host && h.port == port && h.key_type == kind)
            .cloned())
    }
    async fn upsert_trusted(&self, host: KnownHost) -> DomainResult<KnownHost> {
        let mut hosts = self.0.lock().unwrap();
        hosts.retain(|h| h.id != host.id);
        hosts.push(host.clone());
        Ok(host)
    }
    async fn mark_changed(&self, _: &KnownHostId, _: &str) -> DomainResult<()> {
        Ok(())
    }
    async fn list(&self) -> DomainResult<Vec<KnownHost>> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn delete(&self, id: &KnownHostId) -> DomainResult<()> {
        self.0.lock().unwrap().retain(|host| &host.id != id);
        Ok(())
    }
}

pub fn options(port: u16, policy: HostKeyPolicy) -> ConnectOptions {
    ConnectOptions {
        connection_id: ConnectionId::new(),
        session_id: SessionId::new(),
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        auth_method: AuthMethod::None,
        password: None,
        private_key_pem: None,
        private_key_passphrase: None,
        host_key_policy: policy,
        keepalive_sec: 0,
        keepalive_max_miss: 3,
        timeout_sec: 5,
        compression: false,
        agent_forwarding: false,
        x11_forwarding: None,
    }
}

struct Server;
impl russh::server::Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }
}

#[tokio::test]
async fn connection_enforces_strict_and_accept_new_host_keys() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for attempt in 0..5 {
                let (socket, _) = listener.accept().await.unwrap();
                let seed = if attempt < 3 { 42 } else { 43 };
                let key = russh::keys::PrivateKey::new(
                    russh::keys::ssh_key::private::KeypairData::Ed25519(
                        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]),
                    ),
                    "synthetic host key fixture",
                )
                .unwrap();
                let config = Arc::new(russh::server::Config {
                    keys: vec![key],
                    auth_rejection_time: Duration::ZERO,
                    ..Default::default()
                });
                tokio::spawn(async move {
                    if let Ok(session) = russh::server::run_stream(config, socket, Server).await {
                        let _ = session.await;
                    }
                });
            }
        });
        let repo: Arc<dyn KnownHostRepository> = Arc::new(Hosts::default());
        let unknown =
            SshConnection::connect(options(port, HostKeyPolicy::Strict), Some(repo.clone())).await;
        assert!(matches!(unknown, Err(e) if e.code == ErrorCode::HostkeyUnknown));
        let first =
            SshConnection::connect(options(port, HostKeyPolicy::AcceptNew), Some(repo.clone()))
                .await
                .unwrap();
        first.close().await.unwrap();
        assert_eq!(repo.list().await.unwrap().len(), 1);
        let known =
            SshConnection::connect(options(port, HostKeyPolicy::Strict), Some(repo.clone()))
                .await
                .unwrap();
        known.close().await.unwrap();
        let changed_strict =
            SshConnection::connect(options(port, HostKeyPolicy::Strict), Some(repo.clone())).await;
        assert!(matches!(changed_strict, Err(e) if e.code == ErrorCode::HostkeyMismatch));
        let changed_accept =
            SshConnection::connect(options(port, HostKeyPolicy::AcceptNew), Some(repo.clone()))
                .await;
        assert!(matches!(changed_accept, Err(e) if e.code == ErrorCode::HostkeyMismatch));
        server.await.unwrap();
    })
    .await
    .expect("host key security regression timed out");
}
