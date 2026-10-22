use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifestDto {
    pub record_count: u64,
    pub bytes: u64,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecordDto {
    pub record_id: String,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnapshotRequest {
    pub snapshot_id: String,
    pub label: String,
    pub manifest: SnapshotManifestDto,
    pub records: Vec<SnapshotRecordDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotHeaderDto {
    pub snapshot_id: String,
    pub label: String,
    pub record_count: u64,
    pub bytes: u64,
    pub created_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotListResponse {
    pub snapshots: Vec<SnapshotHeaderDto>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDetailResponse {
    #[serde(flatten)]
    pub header: SnapshotHeaderDto,
    pub records: Vec<SnapshotRecordDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackRequest {
    pub snapshot_id: String,
    pub expected_head_seq: u64,
    #[serde(default = "default_rollback_mode")]
    pub mode: String,
    #[serde(default = "default_true")]
    pub create_pre_restore_snapshot: bool,
}

fn default_rollback_mode() -> String {
    "restore".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackResponse {
    pub new_head_seq: u64,
    pub restored_records: u64,
    pub deleted_records: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_restore_snapshot_id: Option<String>,
}
