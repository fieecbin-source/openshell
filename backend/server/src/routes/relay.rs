use crate::middleware::{make_error, AuthUser};
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use openshell_sync_protocol::{
    ApiErrorCode, RelayTicketRequest, RelayTicketResponse, RelayWsControl, RELAY_WS_PROTOCOL,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use ulid::Ulid;

pub async fn create_ticket(
    user: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<RelayTicketRequest>,
) -> Result<(StatusCode, Json<RelayTicketResponse>), crate::middleware::ApiError> {
    if !state.config.relay_enabled {
        return Err(make_error(
            ApiErrorCode::RelayDisabled,
            "Relay service is not enabled on this server",
        ));
    }

    // 先解析目标，只有全部解析结果都落在允许网段内才放行；票据存解析后的 IP，
    // 后续隧道直接连接该 IP，避免 DNS 重绑定绕过校验。
    let resolved_host = resolve_allowed_destination(
        &req.dest_host,
        req.dest_port,
        &state.config.relay_allowed_nets,
    )
    .await
    .ok_or_else(|| {
        make_error(
            ApiErrorCode::DestinationNotAllowed,
            format!(
                "Destination {}:{} is not in relay allowed networks",
                req.dest_host, req.dest_port
            ),
        )
    })?;

    let ticket_id = Ulid::new().to_string();
    let raw_ticket = new_ticket_secret();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires_epoch = now + req.ttl_sec as u64;
    let expires_iso = time::OffsetDateTime::from_unix_timestamp(expires_epoch as i64)
        .unwrap_or(time::OffsetDateTime::now_utc())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    let created_iso = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    state.db.with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
        conn.execute(
            "INSERT INTO relay_ticket (ticket_id, ticket, account_id, device_id, dest_host, dest_port, protocol, bytes_limit, max_idle_sec, expires_at, used, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 300, ?9, 0, ?10)",
            rusqlite::params![&ticket_id, &raw_ticket, &user.account_id, &user.device_id, &resolved_host, req.dest_port, &req.protocol, req.bytes_limit, expires_epoch as i64, &created_iso],
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;
        Ok(())
    })?;

    let ws_url = format!(
        "ws://{}:{}/v1/relay/stream?ticket={}",
        state.config.host, state.config.port, raw_ticket
    );

    Ok((
        StatusCode::CREATED,
        Json(RelayTicketResponse {
            ticket_id,
            ticket: raw_ticket,
            ws_url,
            expires_at: expires_iso,
            max_bytes: req.bytes_limit,
            max_idle_sec: 300,
        }),
    ))
}

pub async fn delete_ticket(
    user: AuthUser,
    State(state): State<AppState>,
    Path(ticket_id): Path<String>,
) -> Result<StatusCode, crate::middleware::ApiError> {
    state
        .db
        .with_conn(|conn| -> Result<(), crate::middleware::ApiError> {
            let deleted = conn
                .execute(
                    "DELETE FROM relay_ticket WHERE ticket_id = ?1 AND account_id = ?2",
                    [&ticket_id, &user.account_id],
                )
                .map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

            if deleted == 0 {
                return Err(make_error(ApiErrorCode::NotFound, "Ticket not found"));
            }
            Ok(())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RelayWsQuery {
    pub ticket: String,
}

pub async fn relay_stream(
    State(state): State<AppState>,
    Query(query): Query<RelayWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, crate::middleware::ApiError> {
    if !state.config.relay_enabled {
        return Err(make_error(
            ApiErrorCode::RelayDisabled,
            "Relay service is disabled",
        ));
    }

    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Verify ticket in db
    let (dest_host, dest_port, bytes_limit) = state.db.with_conn(|conn| -> Result<(String, u16, u64), crate::middleware::ApiError> {
        let mut stmt = conn.prepare(
            "SELECT dest_host, dest_port, bytes_limit, expires_at, used FROM relay_ticket WHERE ticket = ?1",
        ).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let mut rows = stmt.query([&query.ticket]).map_err(|e| make_error(ApiErrorCode::Internal, e.to_string()))?;

        let (host, port, limit, exp, used): (String, u16, i64, i64, i32) = match rows.next() {
            Ok(Some(r)) => (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
            _ => return Err(make_error(ApiErrorCode::NotFound, "Ticket not found or invalid")),
        };

        if used != 0 {
            return Err(make_error(ApiErrorCode::Forbidden, "Ticket has already been used"));
        }

        if (exp as u64) < now_epoch {
            return Err(make_error(ApiErrorCode::Forbidden, "Ticket has expired"));
        }

        // Mark ticket used
        let _ = conn.execute("UPDATE relay_ticket SET used = 1 WHERE ticket = ?1", [&query.ticket]);

        Ok((host, port, limit as u64))
    })?;

    let resp = ws
        .protocols([RELAY_WS_PROTOCOL])
        .on_upgrade(move |socket| handle_relay_tunnel(socket, dest_host, dest_port, bytes_limit));

    Ok(resp)
}

async fn handle_relay_tunnel(
    mut socket: WebSocket,
    dest_host: String,
    dest_port: u16,
    bytes_limit: u64,
) {
    // 票据内保存的是校验时解析出的 IP 字面量，这里不再做 DNS 解析。
    let target_addr = match dest_host.parse::<IpAddr>() {
        Ok(ip) => SocketAddr::new(ip, dest_port),
        Err(_) => {
            let err_msg = serde_json::to_string(&RelayWsControl::Error {
                code: "UPSTREAM_UNREACHABLE".to_string(),
                message: "Ticket destination is not a resolved IP address".to_string(),
            })
            .unwrap_or_default();
            let _ = socket.send(Message::Text(err_msg)).await;
            let _ = socket.close().await;
            return;
        }
    };
    let tcp_conn = match tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(target_addr),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            let err_msg = serde_json::to_string(&RelayWsControl::Error {
                code: "UPSTREAM_UNREACHABLE".to_string(),
                message: format!("TCP connect failed: {e}"),
            })
            .unwrap_or_default();
            let _ = socket.send(Message::Text(err_msg)).await;
            let _ = socket.close().await;
            return;
        }
        Err(_) => {
            let err_msg = serde_json::to_string(&RelayWsControl::Error {
                code: "UPSTREAM_TIMEOUT".to_string(),
                message: "Connect to target timed out".to_string(),
            })
            .unwrap_or_default();
            let _ = socket.send(Message::Text(err_msg)).await;
            let _ = socket.close().await;
            return;
        }
    };

    let remote_addr = tcp_conn
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| target_addr.to_string());

    // Send opened frame
    let opened_msg =
        serde_json::to_string(&RelayWsControl::Opened { remote_addr }).unwrap_or_default();
    if socket.send(Message::Text(opened_msg)).await.is_err() {
        return;
    }

    let (mut tcp_read, mut tcp_write) = tcp_conn.into_split();
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (ws_out_tx, mut ws_out_rx) = tokio::sync::mpsc::channel::<Message>(64);

    let mut transferred_bytes = 0u64;

    // Task: channel -> WS sink
    let sink_task = async {
        while let Some(msg) = ws_out_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    };

    // Bridge: WS -> TCP
    let ws_out_tx_clone = ws_out_tx.clone();
    let ws_to_tcp = async move {
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Binary(bin)) => {
                    transferred_bytes += bin.len() as u64;
                    if transferred_bytes > bytes_limit {
                        break;
                    }
                    if tcp_write.write_all(&bin).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Text(txt)) => {
                    if let Ok(ctrl) = serde_json::from_str::<RelayWsControl>(&txt) {
                        match ctrl {
                            RelayWsControl::Close { .. } => break,
                            RelayWsControl::HalfClose { .. } => {
                                let _ = tcp_write.shutdown().await;
                            }
                            _ => {}
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(p)) => {
                    let _ = ws_out_tx_clone.send(Message::Pong(p)).await;
                }
                _ => {}
            }
        }
        let _ = tcp_write.shutdown().await;
    };

    // Bridge: TCP -> WS channel
    let tcp_to_ws = async move {
        let mut buf = vec![0u8; 16384];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_out_tx
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    tokio::select! {
        _ = sink_task => {},
        _ = ws_to_tcp => {},
        _ = tcp_to_ws => {},
    }
}

/// 生成 relay 票据秘密值：≥128 bit CSPRNG 随机数，URL-safe 编码。
fn new_ticket_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, Clone, Copy)]
struct IpNet {
    base: IpAddr,
    prefix: u8,
}

impl IpNet {
    fn parse(raw: &str) -> Option<Self> {
        let (addr, prefix) = raw.trim().split_once('/')?;
        let base = addr.trim().parse::<IpAddr>().ok()?;
        let prefix = prefix.trim().parse::<u8>().ok()?;
        let max_prefix = match base {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max_prefix {
            return None;
        }
        Some(Self { base, prefix })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (self.base, ip) {
            (IpAddr::V4(base), IpAddr::V4(candidate)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - self.prefix)
                };
                (u32::from(base) & mask) == (u32::from(candidate) & mask)
            }
            (IpAddr::V6(base), IpAddr::V6(candidate)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - self.prefix)
                };
                (u128::from(base) & mask) == (u128::from(candidate) & mask)
            }
            _ => false,
        }
    }
}

fn parse_allowed_nets(raw: &str) -> Vec<IpNet> {
    raw.split(',').filter_map(IpNet::parse).collect()
}

fn all_ips_allowed(ips: &[IpAddr], nets: &[IpNet]) -> bool {
    !ips.is_empty()
        && ips
            .iter()
            .all(|ip| nets.iter().any(|net| net.contains(*ip)))
}

/// 解析并校验 relay 目标。端口 0、空网段、解析失败或任一解析结果越界都会拒绝。
/// 成功时返回用于建立隧道的 IP 字面量。
async fn resolve_allowed_destination(host: &str, port: u16, allowed_nets: &str) -> Option<String> {
    if port == 0 || host.trim().is_empty() {
        return None;
    }

    let nets = parse_allowed_nets(allowed_nets);
    if nets.is_empty() {
        return None;
    }

    if let Ok(ip) = host.trim().parse::<IpAddr>() {
        return all_ips_allowed(&[ip], &nets).then(|| ip.to_string());
    }

    let resolved = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host.trim(), port)),
    )
    .await
    .ok()?
    .ok()?;

    let ips: Vec<IpAddr> = resolved.map(|addr| addr.ip()).collect();
    if !all_ips_allowed(&ips, &nets) {
        return None;
    }

    ips.first().map(|ip| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETS: &str = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32,::1/128";

    #[test]
    fn cidr_boundaries_match_only_inside_range() {
        let nets = parse_allowed_nets(NETS);
        let allowed = |raw: &str| {
            let ip = raw.parse::<IpAddr>().unwrap();
            all_ips_allowed(&[ip], &nets)
        };
        assert!(allowed("10.0.0.1"));
        assert!(allowed("10.255.255.255"));
        assert!(!allowed("11.0.0.1"));
        assert!(allowed("172.16.0.1"));
        assert!(!allowed("172.32.0.1"));
        assert!(allowed("192.168.1.1"));
        assert!(allowed("127.0.0.1"));
        assert!(!allowed("8.8.8.8"));
        assert!(IpNet::parse("10.0.0.0/33").is_none());
        assert!(IpNet::parse("not-a-cidr").is_none());
    }

    #[tokio::test]
    async fn rejects_public_and_invalid_destinations() {
        assert_eq!(
            resolve_allowed_destination("10.0.0.1", 22, NETS)
                .await
                .as_deref(),
            Some("10.0.0.1")
        );
        assert!(resolve_allowed_destination("8.8.8.8", 22, NETS)
            .await
            .is_none());
        assert!(resolve_allowed_destination("0.0.0.0", 22, NETS)
            .await
            .is_none());
        assert!(resolve_allowed_destination("10.0.0.1", 0, NETS)
            .await
            .is_none());
        assert!(resolve_allowed_destination("10.0.0.1", 22, "")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn localhost_resolves_to_allowed_loopback_ips() {
        assert!(resolve_allowed_destination("localhost", 22, NETS)
            .await
            .is_some());
    }

    #[test]
    fn mixed_public_and_private_resolution_is_rejected() {
        let nets = parse_allowed_nets(NETS);
        let ips = [IpAddr::from([10, 0, 0, 1]), IpAddr::from([8, 8, 8, 8])];
        assert!(!all_ips_allowed(&ips, &nets));
    }

    #[test]
    fn ticket_secret_is_random_and_long_enough() {
        let first = new_ticket_secret();
        let second = new_ticket_secret();
        assert_eq!(first.len(), 43);
        assert_ne!(first, second);
    }
}
