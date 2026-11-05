use crate::errors::map_io_error;
use base64::Engine;
use openshell_core_domain::{DomainError, DomainResult, ErrorCode, ProxyServerConfig, ProxyType};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn invalid(message: &str) -> DomainError {
    DomainError::new(ErrorCode::Network, message)
}

pub async fn connect_tcp_via_proxy(
    host: &str,
    port: u16,
    proxy: Option<&ProxyServerConfig>,
    timeout: Duration,
) -> DomainResult<TcpStream> {
    tokio::time::timeout(timeout, async {
        if host.is_empty() || host.contains(['\r', '\n', '\0']) || port == 0 {
            return Err(invalid("invalid target address"));
        }
        let Some(proxy) = proxy else {
            return TcpStream::connect((host, port)).await.map_err(map_io_error);
        };
        let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(map_io_error)?;
        match proxy.proxy_type {
            ProxyType::Http => {
                let authority = if host.contains(':') {
                    format!("[{host}]:{port}")
                } else {
                    format!("{host}:{port}")
                };
                let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
                if let Some(user) = &proxy.username {
                    let auth = base64::engine::general_purpose::STANDARD.encode(format!(
                        "{user}:{}",
                        proxy.password.as_deref().unwrap_or("")
                    ));
                    request.push_str(&format!("Proxy-Authorization: Basic {auth}\r\n"));
                }
                request.push_str("\r\n");
                stream
                    .write_all(request.as_bytes())
                    .await
                    .map_err(map_io_error)?;
                // Read exactly the header, preserving any bytes sent by the target immediately after it.
                let mut response = Vec::new();
                while !response.ends_with(b"\r\n\r\n") {
                    if response.len() >= 16384 {
                        return Err(invalid("proxy HTTP header too large"));
                    }
                    response.push(stream.read_u8().await.map_err(map_io_error)?);
                }
                let text = String::from_utf8_lossy(&response);
                let mut status = text.lines().next().unwrap_or("").split_whitespace();
                if !status.next().unwrap_or("").starts_with("HTTP/")
                    || status
                        .next()
                        .and_then(|s| s.parse::<u16>().ok())
                        .map(|s| s / 100)
                        != Some(2)
                {
                    return Err(invalid("HTTP proxy rejected CONNECT"));
                }
            }
            ProxyType::Socks4 => {
                let user = proxy.username.as_deref().unwrap_or("");
                if user.contains('\0') {
                    return Err(invalid("invalid SOCKS4 username"));
                }
                let ip = host.parse::<std::net::Ipv4Addr>().ok();
                let mut request = vec![4, 1];
                request.extend(port.to_be_bytes());
                request.extend(ip.map(|i| i.octets()).unwrap_or([0, 0, 0, 1]));
                request.extend(user.as_bytes());
                request.push(0);
                if ip.is_none() {
                    request.extend(host.as_bytes());
                    request.push(0);
                }
                stream.write_all(&request).await.map_err(map_io_error)?;
                let mut reply = [0; 8];
                stream.read_exact(&mut reply).await.map_err(map_io_error)?;
                if reply[0] != 0 || reply[1] != 90 {
                    return Err(invalid("SOCKS4 proxy rejected CONNECT"));
                }
            }
            ProxyType::Socks5 => {
                let auth = proxy.username.is_some();
                stream
                    .write_all(if auth { &[5, 2, 0, 2] } else { &[5, 1, 0] })
                    .await
                    .map_err(map_io_error)?;
                let mut reply = [0; 2];
                stream.read_exact(&mut reply).await.map_err(map_io_error)?;
                if reply[0] != 5 {
                    return Err(invalid("invalid SOCKS5 greeting"));
                }
                match reply[1] {
                    0 => {}
                    2 if auth => {
                        let user = proxy.username.as_deref().unwrap_or("").as_bytes();
                        let pass = proxy.password.as_deref().unwrap_or("").as_bytes();
                        if user.is_empty()
                            || user.len() > 255
                            || pass.is_empty()
                            || pass.len() > 255
                        {
                            return Err(invalid("SOCKS5 credentials must be 1..255 bytes"));
                        }
                        let mut req = vec![1, user.len() as u8];
                        req.extend(user);
                        req.push(pass.len() as u8);
                        req.extend(pass);
                        stream.write_all(&req).await.map_err(map_io_error)?;
                        stream.read_exact(&mut reply).await.map_err(map_io_error)?;
                        if reply != [1, 0] {
                            return Err(invalid("SOCKS5 authentication failed"));
                        }
                    }
                    _ => return Err(invalid("SOCKS5 authentication method rejected")),
                }
                let mut req = vec![5, 1, 0];
                if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                    match ip {
                        std::net::IpAddr::V4(ip) => {
                            req.push(1);
                            req.extend(ip.octets());
                        }
                        std::net::IpAddr::V6(ip) => {
                            req.push(4);
                            req.extend(ip.octets());
                        }
                    }
                } else {
                    if host.len() > 255 {
                        return Err(invalid("SOCKS5 target name too long"));
                    }
                    req.extend([3, host.len() as u8]);
                    req.extend(host.as_bytes());
                }
                req.extend(port.to_be_bytes());
                stream.write_all(&req).await.map_err(map_io_error)?;
                let mut header = [0; 4];
                stream.read_exact(&mut header).await.map_err(map_io_error)?;
                if header[0] != 5 || header[1] != 0 || header[2] != 0 {
                    return Err(invalid("SOCKS5 proxy rejected CONNECT"));
                }
                let len = match header[3] {
                    1 => 4,
                    4 => 16,
                    3 => stream.read_u8().await.map_err(map_io_error)? as usize,
                    _ => return Err(invalid("invalid SOCKS5 address type")),
                };
                let mut rest = vec![0; len + 2];
                stream.read_exact(&mut rest).await.map_err(map_io_error)?;
            }
        }
        stream.set_nodelay(true).map_err(map_io_error)?;
        Ok(stream)
    })
    .await
    .map_err(|_| DomainError::new(ErrorCode::Timeout, "proxy connection timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    fn config(kind: ProxyType, port: u16) -> ProxyServerConfig {
        ProxyServerConfig {
            id: "p".into(),
            name: "test".into(),
            proxy_type: kind,
            host: "127.0.0.1".into(),
            port,
            username: Some("user".into()),
            password: Some("pass".into()),
            notes: None,
            created_at: None,
            updated_at: None,
        }
    }
    #[tokio::test]
    async fn http_auth_preserves_tunnel_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = config(ProxyType::Http, listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT target.test:22 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"));
            socket
                .write_all(b"HTTP/1.1 200 Connected\r\n\r\nSSH-banner")
                .await
                .unwrap();
        });
        let mut stream =
            connect_tcp_via_proxy("target.test", 22, Some(&proxy), Duration::from_secs(2))
                .await
                .unwrap();
        let mut banner = [0; 10];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-banner");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn socks4a_domain_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = config(ProxyType::Socks4, listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut req = vec![0; 8 + 5 + 12];
            socket.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[..8], &[4, 1, 0, 22, 0, 0, 0, 1]);
            assert_eq!(&req[8..], b"user\0target.test\0");
            socket
                .write_all(&[0, 90, 0, 22, 127, 0, 0, 1])
                .await
                .unwrap();
        });
        connect_tcp_via_proxy("target.test", 22, Some(&proxy), Duration::from_secs(2))
            .await
            .unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn socks5_auth_and_ipv6_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = config(ProxyType::Socks5, listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut hello = [0; 4];
            socket.read_exact(&mut hello).await.unwrap();
            assert_eq!(hello, [5, 2, 0, 2]);
            socket.write_all(&[5, 2]).await.unwrap();
            let mut auth = [0; 11];
            socket.read_exact(&mut auth).await.unwrap();
            assert_eq!(&auth, b"\x01\x04user\x04pass");
            socket.write_all(&[1, 0]).await.unwrap();
            let mut req = [0; 18];
            socket.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[..5], &[5, 1, 0, 3, 11]);
            assert_eq!(&req[5..16], b"target.test");
            let mut reply = vec![5, 0, 0, 4];
            reply.extend([0; 18]);
            socket.write_all(&reply).await.unwrap();
        });
        connect_tcp_via_proxy("target.test", 22, Some(&proxy), Duration::from_secs(2))
            .await
            .unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn rejects_socks5_auth_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = config(ProxyType::Socks5, listener.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut hello = [0; 4];
            socket.read_exact(&mut hello).await.unwrap();
            socket.write_all(&[5, 255]).await.unwrap();
        });
        assert!(
            connect_tcp_via_proxy("target.test", 22, Some(&proxy), Duration::from_secs(2))
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}
