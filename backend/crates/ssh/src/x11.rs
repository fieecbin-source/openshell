//! Only authenticated X11 channels can reach the user's local display.
use openshell_core_domain::{DomainError, DomainResult};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

const AUTH: &[u8] = b"MIT-MAGIC-COOKIE-1";

enum DisplayTarget {
    Tcp(SocketAddr),
    #[cfg(unix)]
    Unix(PathBuf),
}

pub struct X11Forward {
    target: DisplayTarget,
    pub screen: u32,
    fake: Zeroizing<[u8; 16]>,
    real: Zeroizing<[u8; 16]>,
}

fn invalid() -> DomainError {
    DomainError::validation("X11 需要本机 DISPLAY 和有效的 Xauthority 授权")
}

fn display(value: &str) -> DomainResult<(DisplayTarget, u16, u32)> {
    let (host, number) = value.rsplit_once(':').ok_or_else(invalid)?;
    let (number, screen) = number.split_once('.').unwrap_or((number, "0"));
    let number = number.parse::<u16>().map_err(|_| invalid())?;
    let screen = screen.parse::<u32>().map_err(|_| invalid())?;
    let port = 6000u16.checked_add(number).ok_or_else(invalid)?;
    #[cfg(unix)]
    if host.is_empty() || host == "unix" {
        return Ok((
            DisplayTarget::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{number}"))),
            number,
            screen,
        ));
    }
    let ip = match host {
        "" | "unix" | "localhost" | "127.0.0.1" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        "[::1]" => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err(invalid()),
    };
    Ok((
        DisplayTarget::Tcp(SocketAddr::new(ip, port)),
        number,
        screen,
    ))
}

fn field<'a>(bytes: &mut &'a [u8]) -> DomainResult<&'a [u8]> {
    if bytes.len() < 2 {
        return Err(invalid());
    }
    let length = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    *bytes = &bytes[2..];
    if bytes.len() < length {
        return Err(invalid());
    }
    let (value, rest) = bytes.split_at(length);
    *bytes = rest;
    Ok(value)
}

fn cookie(mut bytes: &[u8], number: u16, hostname: &str) -> DomainResult<[u8; 16]> {
    let number = number.to_string();
    let mut found = None;
    while !bytes.is_empty() {
        if bytes.len() < 2 {
            return Err(invalid());
        }
        let family = u16::from_be_bytes([bytes[0], bytes[1]]);
        bytes = &bytes[2..];
        let address = field(&mut bytes)?;
        let display = field(&mut bytes)?;
        let name = field(&mut bytes)?;
        let data = field(&mut bytes)?;
        let local = match family {
            0 => address == [127, 0, 0, 1],
            6 => address == Ipv6Addr::LOCALHOST.octets(),
            256 => {
                address.is_empty()
                    || (!hostname.is_empty() && address.eq_ignore_ascii_case(hostname.as_bytes()))
            }
            65535 => true,
            _ => false,
        };
        if local && display == number.as_bytes() && name == AUTH && data.len() == 16 {
            let value: [u8; 16] = data.try_into().map_err(|_| invalid())?;
            if found.is_some_and(|previous| previous != value) {
                return Err(invalid());
            }
            found = Some(value);
        }
    }
    found.ok_or_else(invalid)
}

impl X11Forward {
    pub fn from_environment() -> DomainResult<Self> {
        let value = std::env::var("DISPLAY").map_err(|_| invalid())?;
        let (target, number, screen) = display(&value)?;
        let authority = std::env::var_os("XAUTHORITY")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(|home| PathBuf::from(home).join(".Xauthority"))
            })
            .ok_or_else(invalid)?;
        if std::fs::metadata(&authority).map_err(|_| invalid())?.len() > 1024 * 1024 {
            return Err(invalid());
        }
        let bytes = Zeroizing::new(std::fs::read(authority).map_err(|_| invalid())?);
        let hostname = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| std::fs::read_to_string("/etc/hostname").unwrap_or_default());
        let real = cookie(&bytes, number, hostname.trim())?;
        Ok(Self {
            target,
            screen,
            fake: Zeroizing::new(rand::random()),
            real: Zeroizing::new(real),
        })
    }

    pub(crate) fn request_cookie(&self) -> String {
        self.fake.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    async fn setup<S: AsyncRead + Unpin>(
        &self,
        stream: &mut S,
    ) -> std::io::Result<Zeroizing<Vec<u8>>> {
        let mut header = [0u8; 12];
        stream.read_exact(&mut header).await?;
        let word = |offset| match header[0] {
            b'l' => Ok(u16::from_le_bytes([header[offset], header[offset + 1]])),
            b'B' => Ok(u16::from_be_bytes([header[offset], header[offset + 1]])),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "X11 authentication rejected",
            )),
        };
        if word(2)? != 11 || word(6)? != AUTH.len() as u16 || word(8)? != 16 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "X11 authentication rejected",
            ));
        }
        let mut setup = Zeroizing::new(vec![0u8; 48]);
        setup[..12].copy_from_slice(&header);
        stream.read_exact(&mut setup[12..]).await?;
        let difference = setup[32..48]
            .iter()
            .zip(self.fake.iter())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right));
        if &setup[12..30] != AUTH || difference != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "X11 authentication rejected",
            ));
        }
        setup[32..48].copy_from_slice(self.real.as_ref());
        Ok(setup)
    }

    pub(crate) async fn forward<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        stream: &mut S,
    ) -> std::io::Result<()> {
        let setup = tokio::time::timeout(std::time::Duration::from_secs(10), self.setup(stream))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "X11 authentication timed out")
            })??;
        match &self.target {
            DisplayTarget::Tcp(address) => {
                let mut socket = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tokio::net::TcpStream::connect(address),
                )
                .await
                .map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "X11 display unavailable")
                })??;
                socket.write_all(&setup).await?;
                tokio::io::copy_bidirectional(stream, &mut socket).await?;
            }
            #[cfg(unix)]
            DisplayTarget::Unix(path) => {
                let mut socket = tokio::net::UnixStream::connect(path).await?;
                socket.write_all(&setup).await?;
                tokio::io::copy_bidirectional(stream, &mut socket).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authority() -> Vec<u8> {
        let mut value = 65535u16.to_be_bytes().to_vec();
        for field in [b"".as_slice(), b"0", AUTH, &[7; 16]] {
            value.extend_from_slice(&(field.len() as u16).to_be_bytes());
            value.extend_from_slice(field);
        }
        value
    }
    fn setup(fake: &[u8; 16], big: bool) -> Vec<u8> {
        let mut bytes = vec![0; 48];
        bytes[0] = if big { b'B' } else { b'l' };
        for (offset, value) in [(2, 11u16), (6, 18), (8, 16)] {
            bytes[offset..offset + 2].copy_from_slice(&if big {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            });
        }
        bytes[12..30].copy_from_slice(AUTH);
        bytes[32..48].copy_from_slice(fake);
        bytes
    }
    #[test]
    fn rejects_nonlocal_displays_and_malformed_or_missing_authority() {
        assert!(display(":0.1").is_ok());
        assert!(display("localhost:0").is_ok());
        assert!(display("[::1]:0").is_ok());
        for value in [
            "remote.example:0",
            "192.0.2.1:0",
            ":99999",
            ":0.bad",
            "localhost",
        ] {
            assert!(display(value).is_err());
        }
        let bytes = authority();
        assert_eq!(cookie(&bytes, 0, "local").unwrap(), [7; 16]);
        assert!(cookie(&bytes, 1, "local").is_err());
        assert!(cookie(&bytes[..bytes.len() - 1], 0, "local").is_err());
    }
    #[tokio::test]
    async fn authenticates_both_byte_orders_replaces_cookie_and_relays_real_loopback_bytes() {
        for big in [false, true] {
            let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let proxy = X11Forward {
                target: DisplayTarget::Tcp(listener.local_addr().unwrap()),
                screen: 0,
                fake: Zeroizing::new([9; 16]),
                real: Zeroizing::new([7; 16]),
            };
            let (mut remote, mut stream) = tokio::io::duplex(256);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 48];
                socket.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes[32..48], &[7; 16]);
                socket.write_all(b"real-x-server").await.unwrap();
                let mut reply = [0; 6];
                socket.read_exact(&mut reply).await.unwrap();
                assert_eq!(&reply, b"client");
            });
            let relay = tokio::spawn(async move {
                proxy.forward(&mut stream).await.unwrap();
            });
            remote.write_all(&setup(&[9; 16], big)).await.unwrap();
            let mut bytes = [0; 13];
            remote.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"real-x-server");
            remote.write_all(b"client").await.unwrap();
            remote.shutdown().await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(3), server)
                .await
                .unwrap()
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(3), relay)
                .await
                .unwrap()
                .unwrap();
        }
    }
    #[tokio::test]
    async fn invalid_cookie_never_reaches_the_local_server() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let proxy = X11Forward {
            target: DisplayTarget::Tcp(listener.local_addr().unwrap()),
            screen: 0,
            fake: Zeroizing::new([9; 16]),
            real: Zeroizing::new([7; 16]),
        };
        let (mut remote, mut stream) = tokio::io::duplex(128);
        remote.write_all(&setup(&[8; 16], false)).await.unwrap();
        assert_eq!(
            proxy.forward(&mut stream).await.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn real_ssh_x11_request_rewrites_authorization_and_closes_the_local_socket() {
        use crate::{ConnectOptions, SshConnection};
        use openshell_core_domain::{AuthMethod, ConnectionId, HostKeyPolicy, SessionId, TermSize};
        use russh::server::{self, Handler, Session};
        use std::sync::Arc;
        struct Server {
            channel: Option<russh::Channel<server::Msg>>,
            ready: Option<tokio::sync::oneshot::Sender<(server::Handle, String)>>,
        }
        impl Handler for Server {
            type Error = russh::Error;
            async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
                Ok(server::Auth::Accept)
            }
            async fn channel_open_session(
                &mut self,
                channel: russh::Channel<server::Msg>,
                reply: server::ChannelOpenHandle,
                _: &mut Session,
            ) -> Result<(), Self::Error> {
                reply.accept().await;
                self.channel = Some(channel);
                Ok(())
            }
            async fn x11_request(
                &mut self,
                channel: russh::ChannelId,
                _: bool,
                protocol: &str,
                cookie: &str,
                screen: u32,
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                assert_eq!(protocol, "MIT-MAGIC-COOKIE-1");
                assert_eq!(screen, 1);
                session.channel_success(channel)?;
                let _ = self
                    .ready
                    .take()
                    .unwrap()
                    .send((session.handle(), cookie.to_owned()));
                Ok(())
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let local = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = Arc::new(X11Forward {
                target: DisplayTarget::Tcp(local.local_addr().unwrap()),
                screen: 1,
                fake: Zeroizing::new([9; 16]),
                real: Zeroizing::new([7; 16]),
            });
            let (received, delivered) = tokio::sync::oneshot::channel();
            let local_task = tokio::spawn(async move {
                let (mut socket, _) = local.accept().await.unwrap();
                let mut auth = [0; 48];
                socket.read_exact(&mut auth).await.unwrap();
                assert_eq!(&auth[32..], &[7; 16]);
                socket.write_all(b"reply").await.unwrap();
                let mut ping = [0; 4];
                socket.read_exact(&mut ping).await.unwrap();
                assert_eq!(&ping, b"ping");
                received.send(()).unwrap();
                let mut extra = [0; 1];
                assert_eq!(socket.read(&mut extra).await.unwrap(), 0);
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (ready, request) = tokio::sync::oneshot::channel();
            let config = Arc::new(server::Config {
                keys: vec![russh::keys::PrivateKey::new(
                    russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[42; 32]).into(),
                    "x11 fixture",
                )
                .unwrap()],
                auth_rejection_time: std::time::Duration::ZERO,
                ..Default::default()
            });
            let server_task = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let session = server::run_stream(
                    config,
                    socket,
                    Server {
                        channel: None,
                        ready: Some(ready),
                    },
                )
                .await
                .unwrap();
                let _ = session.await;
            });
            let connection = SshConnection::connect_stream(
                ConnectOptions {
                    connection_id: ConnectionId::new(),
                    session_id: SessionId::new(),
                    host: "127.0.0.1".into(),
                    port: address.port(),
                    username: "fixture".into(),
                    auth_method: AuthMethod::None,
                    password: None,
                    private_key_pem: None,
                    private_key_passphrase: None,
                    host_key_policy: HostKeyPolicy::Insecure,
                    keepalive_sec: 0,
                    keepalive_max_miss: 3,
                    timeout_sec: 5,
                    compression: false,
                    agent_forwarding: false,
                    x11_forwarding: Some(proxy),
                },
                None,
                tokio::net::TcpStream::connect(address).await.unwrap(),
            )
            .await
            .unwrap();
            let terminal = connection.open_shell(TermSize::DEFAULT).await.unwrap();
            let (handle, cookie) = request.await.unwrap();
            assert_eq!(cookie, "09".repeat(16));
            assert_ne!(cookie, "07".repeat(16));
            let mut channel = handle
                .channel_open_x11("127.0.0.1", 12345)
                .await
                .unwrap()
                .into_stream();
            channel.write_all(&setup(&[9; 16], false)).await.unwrap();
            let mut response = [0; 5];
            channel.read_exact(&mut response).await.unwrap();
            assert_eq!(&response, b"reply");
            channel.write_all(b"ping").await.unwrap();
            delivered.await.unwrap();
            connection.close().await.unwrap();
            local_task.await.unwrap();
            drop(terminal);
            drop(channel);
            server_task.await.unwrap();
        })
        .await
        .unwrap();
    }
}
