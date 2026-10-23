use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_sec: u64,
    pub time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadyResponse {
    pub status: String,
    pub db: String,
    pub migrations: String,
    pub relay: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEventDto {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub at: String,
    pub ip_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEventListResponse {
    pub events: Vec<AuditEventDto>,
    pub has_more: bool,
}
