//! 轻量级 SOCKS5 协议解析器（RFC 1928 / RFC 1929 CONNECT 命令）。

use openshell_core_domain::{DomainError, DomainResult, ErrorCode, SocksAuth};
use std::net::{Ipv4Addr, Ipv6Addr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 处理 SOCKS5 握手并返回目标主机与端口。
pub async fn handle_socks5_handshake(
    stream: &mut TcpStream,
    auth_mode: SocksAuth,
    expected_user: Option<&str>,
    expected_pass: Option<&str>,
) -> DomainResult<(String, u16)> {
    // 1. 版本与认证方法协商
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("socks5 read version failed: {e}")))?;

    let version = header[0];
    let nmethods = header[1] as usize;
    if version != 5 {
        return Err(DomainError::new(
            ErrorCode::Unsupported,
            format!("unsupported socks version: {version}"),
        ));
    }

    let mut methods = vec![0u8; nmethods];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("socks5 read methods failed: {e}")))?;

    match auth_mode {
        SocksAuth::None => {
            if !methods.contains(&0x00) {
                stream.write_all(&[0x05, 0xFF]).await.ok();
                return Err(DomainError::new(
                    ErrorCode::AuthFailed,
                    "socks5 client does not support NO_AUTH",
                ));
            }
            stream.write_all(&[0x05, 0x00]).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("socks5 reply failed: {e}"))
            })?;
        }
        SocksAuth::Userpass => {
            if !methods.contains(&0x02) {
                stream.write_all(&[0x05, 0xFF]).await.ok();
                return Err(DomainError::new(
                    ErrorCode::AuthFailed,
                    "socks5 client does not support USERNAME_PASSWORD",
                ));
            }
            stream.write_all(&[0x05, 0x02]).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("socks5 reply failed: {e}"))
            })?;

            // RFC 1929 子协商
            let mut sub_ver = [0u8; 1];
            stream.read_exact(&mut sub_ver).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("read sub ver failed: {e}"))
            })?;
            if sub_ver[0] != 1 {
                return Err(DomainError::new(
                    ErrorCode::AuthFailed,
                    "unsupported sub-negotiation version",
                ));
            }

            let ulen =
                stream.read_u8().await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read ulen failed: {e}"))
                })? as usize;
            let mut ubuf = vec![0u8; ulen];
            stream
                .read_exact(&mut ubuf)
                .await
                .map_err(|e| DomainError::new(ErrorCode::Io, format!("read user failed: {e}")))?;
            let user = String::from_utf8_lossy(&ubuf).to_string();

            let plen =
                stream.read_u8().await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read plen failed: {e}"))
                })? as usize;
            let mut pbuf = vec![0u8; plen];
            stream
                .read_exact(&mut pbuf)
                .await
                .map_err(|e| DomainError::new(ErrorCode::Io, format!("read pass failed: {e}")))?;
            let pass = String::from_utf8_lossy(&pbuf).to_string();

            // 只有同时配置了期望用户名与口令才可能通过校验。
            // 缺少任一项时必须拒绝：否则「配置了认证」的动态转发会对任意凭据放行，
            // 配合 0.0.0.0 监听就等价于一个无需认证的开放代理。
            let matched = match (expected_user, expected_pass) {
                (Some(eu), Some(ep)) => user == eu && pass == ep,
                _ => false,
            };

            if matched {
                stream.write_all(&[0x01, 0x00]).await.ok();
            } else {
                stream.write_all(&[0x01, 0x01]).await.ok();
                return Err(DomainError::new(
                    ErrorCode::AuthFailed,
                    "socks5 username or password rejected",
                ));
            }
        }
    }

    // 2. 请求报文：VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req_header = [0u8; 4];
    stream
        .read_exact(&mut req_header)
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("read req header failed: {e}")))?;

    let req_ver = req_header[0];
    let cmd = req_header[1];
    let atyp = req_header[3];

    if req_ver != 5 {
        return Err(DomainError::new(
            ErrorCode::Unsupported,
            "socks5 invalid request version",
        ));
    }

    if cmd != 1 {
        // 仅支持 CONNECT (0x01)
        stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await
            .ok();
        return Err(DomainError::new(
            ErrorCode::Unsupported,
            format!("unsupported socks5 cmd: {cmd} (only CONNECT is supported)"),
        ));
    }

    let target_host =
        match atyp {
            1 => {
                // IPv4 (4 字节)
                let mut ip_buf = [0u8; 4];
                stream.read_exact(&mut ip_buf).await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read ipv4 failed: {e}"))
                })?;
                Ipv4Addr::from(ip_buf).to_string()
            }
            3 => {
                // 域名 (1 字节长度 + 字符串)
                let dlen = stream.read_u8().await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read domain len failed: {e}"))
                })? as usize;
                let mut dbuf = vec![0u8; dlen];
                stream.read_exact(&mut dbuf).await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read domain failed: {e}"))
                })?;
                String::from_utf8_lossy(&dbuf).to_string()
            }
            4 => {
                // IPv6 (16 字节)
                let mut ip_buf = [0u8; 16];
                stream.read_exact(&mut ip_buf).await.map_err(|e| {
                    DomainError::new(ErrorCode::Io, format!("read ipv6 failed: {e}"))
                })?;
                Ipv6Addr::from(ip_buf).to_string()
            }
            other => {
                stream
                    .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                    .await
                    .ok();
                return Err(DomainError::new(
                    ErrorCode::Unsupported,
                    format!("unsupported socks5 atyp: {other}"),
                ));
            }
        };

    let target_port = stream
        .read_u16()
        .await
        .map_err(|e| DomainError::new(ErrorCode::Io, format!("read target port failed: {e}")))?;

    // 回送成功响应：0x05, 0x00, 0x00, 0x01, BND.ADDR(0), BND.PORT(0)
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| {
            DomainError::new(ErrorCode::Io, format!("write socks5 success failed: {e}"))
        })?;

    Ok((target_host, target_port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn test_socks5_no_auth_ipv4() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            handle_socks5_handshake(&mut stream, SocksAuth::None, None, None)
                .await
                .expect("handshake")
        });

        let mut client = TcpStream::connect(addr).await.expect("connect");
        // 1. Version + Methods: VER=5, NMETHODS=1, METHOD=0 (No Auth)
        client
            .write_all(&[0x05, 0x01, 0x00])
            .await
            .expect("send methods");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method resp");
        assert_eq!(resp, [0x05, 0x00]);

        // 2. Request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP=1 (IPv4: 1.2.3.4), PORT=8080 (0x1F90)
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x1F, 0x90])
            .await
            .expect("send req");

        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(reply[0], 0x05);
        assert_eq!(reply[1], 0x00); // SUCCESS

        let (target_host, target_port) = server_task.await.expect("task");
        assert_eq!(target_host, "1.2.3.4");
        assert_eq!(target_port, 8080);
    }

    #[tokio::test]
    async fn test_socks5_domain_name() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            handle_socks5_handshake(&mut stream, SocksAuth::None, None, None)
                .await
                .expect("handshake")
        });

        let mut client = TcpStream::connect(addr).await.expect("connect");
        client
            .write_all(&[0x05, 0x01, 0x00])
            .await
            .expect("send methods");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method resp");

        // Request: VER=5, CMD=1, RSV=0, ATYP=3 (Domain: "example.com"), PORT=443 (0x01BB)
        let domain = b"example.com";
        let mut req = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
        req.extend_from_slice(domain);
        req.extend_from_slice(&[0x01, 0xBB]);

        client.write_all(&req).await.expect("send req");

        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(reply[1], 0x00);

        let (target_host, target_port) = server_task.await.expect("task");
        assert_eq!(target_host, "example.com");
        assert_eq!(target_port, 443);
    }

    #[tokio::test]
    async fn test_socks5_userpass_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            handle_socks5_handshake(
                &mut stream,
                SocksAuth::Userpass,
                Some("admin"),
                Some("secret123"),
            )
            .await
            .expect("handshake")
        });

        let mut client = TcpStream::connect(addr).await.expect("connect");
        // Methods: offer 0x02 (Username/Password)
        client
            .write_all(&[0x05, 0x01, 0x02])
            .await
            .expect("send methods");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method resp");
        assert_eq!(resp, [0x05, 0x02]);

        // Subnegotiation: VER=1, ULEN=5, "admin", PLEN=9, "secret123"
        let mut subneg = vec![0x01, 5];
        subneg.extend_from_slice(b"admin");
        subneg.push(9);
        subneg.extend_from_slice(b"secret123");
        client.write_all(&subneg).await.expect("send subneg");

        let mut subneg_resp = [0u8; 2];
        client
            .read_exact(&mut subneg_resp)
            .await
            .expect("read subneg resp");
        assert_eq!(subneg_resp, [0x01, 0x00]); // Success

        // Request: IPv4 127.0.0.1:22
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 22])
            .await
            .expect("send req");
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(reply[1], 0x00);

        let (target_host, target_port) = server_task.await.expect("task");
        assert_eq!(target_host, "127.0.0.1");
        assert_eq!(target_port, 22);
    }

    /// 回归：配置了 USERPASS 认证但未提供期望凭据时必须拒绝，而不是放行任意口令。
    #[tokio::test]
    async fn test_socks5_userpass_without_expected_credentials_is_rejected() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            handle_socks5_handshake(&mut stream, SocksAuth::Userpass, None, None).await
        });

        let mut client = TcpStream::connect(addr).await.expect("connect");
        client
            .write_all(&[0x05, 0x01, 0x02])
            .await
            .expect("send methods");
        let mut resp = [0u8; 2];
        client
            .read_exact(&mut resp)
            .await
            .expect("read method resp");
        assert_eq!(resp, [0x05, 0x02]);

        let mut subneg = vec![0x01, 5];
        subneg.extend_from_slice(b"admin");
        subneg.push(9);
        subneg.extend_from_slice(b"anything1");
        client.write_all(&subneg).await.expect("send subneg");

        let mut subneg_resp = [0u8; 2];
        client
            .read_exact(&mut subneg_resp)
            .await
            .expect("read subneg resp");
        assert_eq!(subneg_resp, [0x01, 0x01]); // 认证失败

        let result = server_task.await.expect("task");
        assert!(result.is_err());
    }
}
