use openshell_core_domain::{
    AuthMethod, ConnectionId, HostKeyPolicy, PortForwardId, PortForwardRule, PortForwardType,
    SessionId, SocksAuth, SyncMeta,
};
use openshell_forward::{ForwardManager, ForwardStatus};
use openshell_ssh::{ConnectOptions, SshConnection};
use russh::server::{self, Handler, Session};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// 服务端已建立的转发通道。
///
/// 真实 OpenSSH 在 `cancel-tcpip-forward` 后只撤销监听，既有连接继续存在；夹具必须
/// 保持一致，否则服务端自己断开会遮蔽「客户端 stop 是否结束已建立 relay」这个问题。
#[derive(Default, Clone)]
struct Relays(Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>);

#[derive(Default)]
struct Server {
    forwards: HashMap<u32, tokio::task::JoinHandle<()>>,
    relays: Relays,
    reject_cancel_once: bool,
}

impl Drop for Server {
    fn drop(&mut self) {
        for task in self.forwards.values() {
            task.abort();
        }
        for task in self.relays.0.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
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
        let host = host.to_owned();
        let handle = session.handle();
        let relays = self.relays.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, peer)) = listener.accept().await else {
                    break;
                };
                let Ok(channel) = handle
                    .channel_open_forwarded_tcpip(
                        &host,
                        bound_port,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                else {
                    break;
                };
                // 子通道不随监听任务一起被 abort：模拟服务端在取消监听后仍保留既有连接。
                let relay = tokio::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel.into_stream())
                        .await;
                });
                relays.0.lock().unwrap().push(relay);
            }
        });
        self.forwards.insert(bound_port, task);
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        _: &str,
        port: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.reject_cancel_once {
            self.reject_cancel_once = false;
            return Ok(false);
        }
        if let Some(task) = self.forwards.remove(&port) {
            task.abort();
            let _ = task.await;
            return Ok(true);
        }
        Ok(false)
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
        if let Ok(mut target) = TcpStream::connect((host, port as u16)).await {
            reply.accept().await;
            tokio::spawn(async move {
                let _ =
                    tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut target).await;
            });
        }
        Ok(())
    }
}

fn rule(kind: PortForwardType) -> PortForwardRule {
    PortForwardRule {
        id: PortForwardId::new(),
        session_id: None,
        name: "loopback".into(),
        rule_type: kind,
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        dest_host: Some("127.0.0.1".into()),
        dest_port: Some(1),
        auto_start: false,
        auto_reconnect: false,
        reconnect_max: 0,
        socks_auth: SocksAuth::None,
        socks_username: None,
        socks_password_ref: None,
        has_socks_password: false,
        expose_warning_ack: false,
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
        deleted_at: None,
        sync: SyncMeta::default(),
    }
}

async fn connect(port: u16) -> Arc<SshConnection> {
    Arc::new(
        SshConnection::connect(
            ConnectOptions {
                connection_id: ConnectionId::new(),
                session_id: SessionId::new(),
                host: "127.0.0.1".into(),
                port,
                username: "loopback".into(),
                auth_method: AuthMethod::None,
                password: None,
                private_key_pem: None,
                private_key_passphrase: None,
                host_key_policy: HostKeyPolicy::Insecure,
                keepalive_sec: 1,
                keepalive_max_miss: 1,
                timeout_sec: 5,
                compression: false,
                agent_forwarding: false,
                x11_forwarding: None,
            },
            None,
        )
        .await
        .unwrap(),
    )
}

async fn start_server() -> (
    u16,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<server::Handle>,
) {
    start_server_with_cancel_rejection(false).await
}

async fn start_server_with_cancel_rejection(
    reject_cancel_once: bool,
) -> (
    u16,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<server::Handle>,
) {
    let key = russh::keys::PrivateKey::new(
        russh::keys::ssh_key::private::KeypairData::Ed25519(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[74; 32]),
        ),
        "loopback fixture",
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (control_tx, control_rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let control_tx = control_tx.clone();
            tokio::spawn(async move {
                let session = server::run_stream(
                    config,
                    socket,
                    Server {
                        forwards: HashMap::new(),
                        relays: Relays::default(),
                        reject_cancel_once,
                    },
                )
                .await
                .unwrap();
                let _ = control_tx.send(session.handle());
                let _ = session.await;
            });
        }
    });
    (port, task, control_rx)
}

async fn addr(manager: &ForwardManager, id: &PortForwardId) -> String {
    match manager.get_status(id).await {
        ForwardStatus::Listening { bound_addr } => bound_addr,
        other => panic!("{other:?}"),
    }
}

async fn socks_connect(addr: &str, port: u16) -> (TcpStream, u8) {
    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket.write_all(&[5, 1, 0]).await.unwrap();
    let mut method = [0; 2];
    socket.read_exact(&mut method).await.unwrap();
    assert_eq!(method, [5, 0]);
    let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
    request.extend_from_slice(&port.to_be_bytes());
    socket.write_all(&request).await.unwrap();
    let mut reply = [0; 10];
    socket.read_exact(&mut reply).await.unwrap();
    (socket, reply[1])
}

#[tokio::test]
async fn socks_reports_channel_failure_and_roundtrips_success() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (port, server, _) = start_server().await;
        let conn = connect(port).await;
        let manager = ForwardManager::new();
        let rule = rule(PortForwardType::Dynamic);
        let id = rule.id.clone();
        manager.start_rule(rule, conn.clone(), None).await.unwrap();
        let bound = addr(&manager, &id).await;
        let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused_port = unavailable.local_addr().unwrap().port();
        drop(unavailable);
        let (_, rep) = socks_connect(&bound, refused_port).await;
        assert_ne!(rep, 0, "rejected direct-tcpip must not claim success");
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let (mut socket, _) = echo.accept().await.unwrap();
            let mut bytes = [0; 4];
            socket.read_exact(&mut bytes).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
        });
        let (mut socket, rep) = socks_connect(&bound, echo_port).await;
        assert_eq!(rep, 0);
        socket.write_all(b"ping").await.unwrap();
        let mut bytes = [0; 4];
        socket.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"ping");
        echo_task.await.unwrap();
        manager.stop_all().await;
        conn.close().await.unwrap();
        server.abort();
    })
    .await
    .expect("SOCKS integration timed out");
}

#[tokio::test]
async fn closing_one_connection_releases_its_listeners_only() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (port, server, _) = start_server().await;
        let conn_a = connect(port).await;
        let conn_b = connect(port).await;
        let manager = ForwardManager::new();
        let a_local = rule(PortForwardType::Local);
        let a_local_id = a_local.id.clone();
        let a_dynamic = rule(PortForwardType::Dynamic);
        let a_dynamic_id = a_dynamic.id.clone();
        let a_remote = rule(PortForwardType::Remote);
        let a_remote_id = a_remote.id.clone();
        let b = rule(PortForwardType::Local);
        let b_id = b.id.clone();
        manager
            .start_rule(a_local, conn_a.clone(), None)
            .await
            .unwrap();
        manager
            .start_rule(a_dynamic, conn_a.clone(), None)
            .await
            .unwrap();
        manager.start_rule(b, conn_b.clone(), None).await.unwrap();
        manager
            .start_rule(a_remote, conn_a.clone(), None)
            .await
            .unwrap();
        let remote_bound = addr(&manager, &a_remote_id).await;
        let remote_addr = remote_bound
            .strip_prefix("remote:")
            .unwrap()
            .split(" -> ")
            .next()
            .unwrap()
            .to_owned();
        let a_addrs = [
            addr(&manager, &a_local_id).await,
            addr(&manager, &a_dynamic_id).await,
            remote_addr,
        ];
        let b_addr = addr(&manager, &b_id).await;
        conn_a.close().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let (local, dynamic, remote) = tokio::join!(
                    TcpStream::connect(&a_addrs[0]),
                    TcpStream::connect(&a_addrs[1]),
                    TcpStream::connect(&a_addrs[2]),
                );
                if local.is_err() && dynamic.is_err() && remote.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("listeners were not released");
        assert!(!matches!(
            manager.get_status(&a_local_id).await,
            ForwardStatus::Listening { .. }
        ));
        assert!(!matches!(
            manager.get_status(&a_dynamic_id).await,
            ForwardStatus::Listening { .. }
        ));
        assert!(!matches!(
            manager.get_status(&a_remote_id).await,
            ForwardStatus::Listening { .. }
        ));
        assert!(TcpStream::connect(&b_addr).await.is_ok());
        manager.stop_all().await;
        conn_b.close().await.unwrap();
        server.abort();
    })
    .await
    .expect("lifecycle integration timed out");
}

#[tokio::test]
async fn stopping_rule_closes_pending_handshake_children() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (port, server, _) = start_server().await;
        let conn = connect(port).await;
        let manager = ForwardManager::new();
        let rule = rule(PortForwardType::Dynamic);
        let id = rule.id.clone();
        manager.start_rule(rule, conn.clone(), None).await.unwrap();
        let mut socket = TcpStream::connect(addr(&manager, &id).await).await.unwrap();
        socket.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0; 2];
        socket.read_exact(&mut method).await.unwrap();
        manager.stop_rule(&id).await.unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
            .await
            .expect("detached SOCKS child survived stop");
        assert!(matches!(read, Ok(0) | Err(_)));
        conn.close().await.unwrap();
        server.abort();
    })
    .await
    .expect("child cleanup integration timed out");
}

#[tokio::test]
async fn server_disconnect_releases_all_rule_types_and_pending_handshakes() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (port, server, mut controls) = start_server().await;
        let conn = connect(port).await;
        let control = controls.recv().await.unwrap();
        let manager = ForwardManager::new();
        let mut rules = Vec::new();
        for kind in [
            PortForwardType::Local,
            PortForwardType::Dynamic,
            PortForwardType::Remote,
        ] {
            let rule = rule(kind);
            let id = rule.id.clone();
            manager.start_rule(rule, conn.clone(), None).await.unwrap();
            let bound = addr(&manager, &id).await;
            let address = bound
                .strip_prefix("remote:")
                .unwrap_or(&bound)
                .split(" -> ")
                .next()
                .unwrap()
                .to_owned();
            rules.push((id, address));
        }
        let mut pending = TcpStream::connect(&rules[1].1).await.unwrap();
        pending.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0; 2];
        pending.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 0]);
        control
            .disconnect(
                russh::Disconnect::ByApplication,
                "test peer closed".into(),
                "en".into(),
            )
            .await
            .unwrap();
        let released = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                // Windows refusal can take two seconds per port; inspect all three concurrently.
                let (local, dynamic, remote) = tokio::join!(
                    TcpStream::connect(&rules[0].1),
                    TcpStream::connect(&rules[1].1),
                    TcpStream::connect(&rules[2].1),
                );
                let mut released = local.is_err() && dynamic.is_err() && remote.is_err();
                for (id, _) in &rules {
                    released &= !matches!(manager.get_status(id).await, ForwardStatus::Listening { .. });
                }
                if released {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if released.is_err() {
            let mut details = Vec::new();
            for (id, address) in &rules {
                details.push((manager.get_status(id).await, TcpStream::connect(address).await.is_ok()));
            }
            panic!("peer disconnect retained listener/status; closed={}, states/connectable={details:?}", *conn.closed_channel().borrow());
        }
        let mut byte = [0];
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), pending.read(&mut byte))
                .await
                .unwrap(),
            Ok(0) | Err(_)
        ));
        for (id, _) in &rules { manager.stop_rule(id).await.unwrap(); }
        manager.stop_all().await;
        server.abort();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn stopping_remote_rule_releases_server_listener() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (port, server, _) = start_server().await;
        let conn = connect(port).await;
        let manager = ForwardManager::new();
        let rule = rule(PortForwardType::Remote);
        let id = rule.id.clone();
        manager.start_rule(rule, conn.clone(), None).await.unwrap();
        let bound = addr(&manager, &id).await;
        let address = bound
            .strip_prefix("remote:")
            .unwrap()
            .split(" -> ")
            .next()
            .unwrap();
        manager.stop_rule(&id).await.unwrap();
        assert_eq!(manager.get_status(&id).await, ForwardStatus::Stopped);
        assert!(
            TcpListener::bind(address).await.is_ok(),
            "remote listener remained bound after cancellation"
        );
        conn.close().await.unwrap();
        server.abort();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn rejected_remote_cancellation_preserves_error_and_can_retry() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (port, server, _) = start_server_with_cancel_rejection(true).await;
        let conn = connect(port).await;
        let manager = ForwardManager::new();
        let rule = rule(PortForwardType::Remote);
        let id = rule.id.clone();
        manager.start_rule(rule, conn.clone(), None).await.unwrap();
        let bound = addr(&manager, &id).await;
        let address = bound
            .strip_prefix("remote:")
            .unwrap()
            .split(" -> ")
            .next()
            .unwrap();
        assert!(manager.stop_rule(&id).await.is_err());
        assert!(
            matches!(manager.get_status(&id).await, ForwardStatus::Error(_)),
            "a rejected remote cancellation must not claim Stopped"
        );
        assert!(
            TcpListener::bind(address).await.is_err(),
            "test server unexpectedly released the refused listener"
        );
        manager.stop_rule(&id).await.unwrap();
        assert_eq!(manager.get_status(&id).await, ForwardStatus::Stopped);
        assert!(
            TcpListener::bind(address).await.is_ok(),
            "retry did not cancel the retained remote listener"
        );
        conn.close().await.unwrap();
        server.abort();
    })
    .await
    .unwrap();
}

/// R14 新增边界（BUG014 之外）：停止远端规则后，该路由**已建立**的 relay 必须结束。
///
/// 真实 OpenSSH 在 cancel-tcpip-forward 后只撤销监听、既有连接继续存在，
/// 所以这里用保留子通道的夹具复现客户端侧行为：stop 之后已建立隧道应读到 EOF，
/// 而其他规则的连接不受影响。
#[tokio::test]
async fn stopping_remote_rule_ends_established_relay_but_keeps_other_rules() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (port, server, _) = start_server().await;
        let conn = connect(port).await;
        let manager = ForwardManager::new();

        // 隧道对端：真实回环 echo 服务。
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        // 远端转发：服务端监听 → 客户端连 echo。
        let mut remote = rule(PortForwardType::Remote);
        remote.dest_host = Some("127.0.0.1".into());
        remote.dest_port = Some(echo_port);
        let remote_id = remote.id.clone();
        manager
            .start_rule(remote, conn.clone(), None)
            .await
            .unwrap();
        let remote_addr = addr(&manager, &remote_id)
            .await
            .strip_prefix("remote:")
            .unwrap()
            .split(" -> ")
            .next()
            .unwrap()
            .to_owned();

        let mut tunneled = TcpStream::connect(&remote_addr).await.unwrap();
        tunneled.write_all(b"ping").await.unwrap();
        let mut bytes = [0u8; 4];
        tunneled.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"ping");

        // 对照：另一条规则（本地转发）指向同一个 echo。
        let mut local = rule(PortForwardType::Local);
        local.dest_host = Some("127.0.0.1".into());
        local.dest_port = Some(echo_port);
        let local_id = local.id.clone();
        manager.start_rule(local, conn.clone(), None).await.unwrap();
        let mut control = TcpStream::connect(addr(&manager, &local_id).await)
            .await
            .unwrap();
        control.write_all(b"ok").await.unwrap();
        let mut ok = [0u8; 2];
        control.read_exact(&mut ok).await.unwrap();
        assert_eq!(&ok, b"ok");

        manager.stop_rule(&remote_id).await.unwrap();

        // 已建立的远端 tunnel 必须结束，而不是继续转发。
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(3), tunneled.read(&mut byte))
            .await
            .expect("established remote relay survived stop_rule");
        match read {
            Ok(0) | Err(_) => {}
            Ok(n) => panic!("remote relay still forwarded {n} byte(s) after stop"),
        }

        // 其他规则不受影响。
        control.write_all(b"still").await.unwrap();
        let mut still = [0u8; 5];
        control.read_exact(&mut still).await.unwrap();
        assert_eq!(&still, b"still");

        manager.stop_all().await;
        echo_task.abort();
        conn.close().await.unwrap();
        server.abort();
    })
    .await
    .expect("remote relay lifecycle integration timed out");
}
