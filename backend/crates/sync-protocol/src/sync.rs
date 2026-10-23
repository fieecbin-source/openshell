use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitChange {
    pub record_id: String,
    pub base_version: Option<u64>,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub deleted: bool,
    pub client_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_cursor: Option<u64>,
    pub changes: Vec<CommitChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedChange {
    pub record_id: String,
    pub version: u64,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictDetail {
    pub record_id: String,
    pub server_version: u64,
    pub server_ciphertext_b64: String,
    pub server_checksum: String,
    pub server_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResponse {
    pub applied: Vec<AppliedChange>,
    pub conflicts: Vec<ConflictDetail>,
    pub new_cursor: u64,
    pub head_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeRecordDto {
    pub seq: u64,
    pub record_id: String,
    pub version: u64,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub size: usize,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub updated_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesPageResponse {
    pub changes: Vec<ChangeRecordDto>,
    pub next_cursor: u64,
    pub has_more: bool,
    pub head_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncHeadResponse {
    pub head_seq: u64,
    pub record_count: u64,
    pub bytes_used: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusResponse {
    pub head_seq: u64,
    pub record_count: u64,
    pub bytes_used: u64,
    pub quota: u64,
    pub conflict_retention_days: u32,
    pub snapshot_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordHistoryDto {
    pub version: u64,
    pub seq: u64,
    pub checksum: String,
    pub size: usize,
    pub deleted: bool,
    pub updated_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordHistoryListResponse {
    pub versions: Vec<RecordHistoryDto>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordVersionDetailResponse {
    pub record_id: String,
    pub version: u64,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub deleted: bool,
    pub updated_at: String,
}
