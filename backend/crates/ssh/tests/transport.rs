use openshell_core_domain::{AuthMethod, ConnectionId, HostKeyPolicy, SessionId};
use openshell_ssh::{ConnectOptions, SshConnection};
use russh::server::{self, Handler, Session};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    task::JoinHandle,
};

#[derive(Clone, Default)]
struct TestServer {
    forwards: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
}
impl Handler for TestServer {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        let mut socket = TcpStream::connect((host, port as u16)).await?;
        reply.accept().await;
        tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket).await;
        });
        Ok(())
    }
    async fn tcpip_forward(
        &mut self,
        host: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let listener = TcpListener::bind((host, *port as u16)).await?;
        *port = listener.local_addr()?.port() as u32;
        let bound_port = *port;
        let handle = session.handle();
        let host = host.to_string();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, peer)) = listener.accept().await {
                if let Ok(channel) = handle
                    .channel_open_forwarded_tcpip(
                        &host,
                        bound_port,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    tokio::spawn(async move {
                        let _ =
                            tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket)
                                .await;
                    });
                }
            }
        });
        self.forwards.lock().await.insert(bound_port, task);
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        _: &str,
        port: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        if let Some(task) = self.forwards.lock().await.remove(&port) {
            task.abort();
            let _ = task.await;
            return Ok(true);
        }
        Ok(false)
    }
}
fn options(port: u16) -> ConnectOptions {
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
        host_key_policy: HostKeyPolicy::Insecure,
        keepalive_sec: 0,
        keepalive_max_miss: 3,
        timeout_sec: 5,
        compression: true,
        agent_forwarding: false,
    }
}

#[tokio::test]
async fn jump_stream_remote_forward_roundtrip_and_cancel() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let key = russh::keys::PrivateKey::new(
            russh::keys::ssh_key::private::KeypairData::Ed25519(
                russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[42; 32]),
            ),
            "test fixture",
        )
        .unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(session) =
                        server::run_stream(config, socket, TestServer::default()).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        let jump = SshConnection::connect(options(port), None).await.unwrap();
        let jump_stream = jump.open_direct_tcpip("127.0.0.1", port).await.unwrap();
        let target = SshConnection::connect_stream(options(port), None, jump_stream)
            .await
            .unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dest_port = destination.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut socket, _) = destination.accept().await.unwrap();
            let mut data = [0; 4];
            socket.read_exact(&mut data).await.unwrap();
            assert_eq!(&data, b"ping");
            socket.write_all(b"pong").await.unwrap();
        });
        let remote = target
            .start_remote_forward("127.0.0.1", 0, "127.0.0.1".into(), dest_port)
            .await
            .unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", remote as u16))
            .await
            .unwrap();
        socket.write_all(b"ping").await.unwrap();
        let mut response = [0; 4];
        socket.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"pong");
        echo.await.unwrap();
        target
            .stop_remote_forward("127.0.0.1", remote as u16)
            .await
            .unwrap();
        assert!(TcpStream::connect(("127.0.0.1", remote as u16))
            .await
            .is_err());
        target.close().await.unwrap();
        jump.close().await.unwrap();
        server_task.abort();
    })
    .await
    .expect("SSH transport integration timed out");
}
