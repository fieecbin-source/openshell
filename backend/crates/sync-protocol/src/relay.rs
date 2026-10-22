use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayTicketRequest {
    pub dest_host: String,
    pub dest_port: u16,
    #[serde(default = "default_tcp")]
    pub protocol: String,
    #[serde(default = "default_ttl")]
    pub ttl_sec: u32,
    #[serde(default = "default_bytes_limit")]
    pub bytes_limit: u64,
}

fn default_tcp() -> String {
    "tcp".to_string()
}

fn default_ttl() -> u32 {
    120
}

fn default_bytes_limit() -> u64 {
    256 * 1024 * 1024 // 256 MiB
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayTicketResponse {
    pub ticket_id: String,
    pub ticket: String,
    pub ws_url: String,
    pub expires_at: String,
    pub max_bytes: u64,
    pub max_idle_sec: u32,
}

/// 中继 WebSocket 控制文本帧定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RelayWsControl {
    #[serde(rename = "open")]
    Open { dest_host: String, dest_port: u16 },
    #[serde(rename = "opened")]
    Opened { remote_addr: String },
    #[serde(rename = "half_close")]
    HalfClose { direction: String },
    #[serde(rename = "close")]
    Close { code: u16, reason: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}
