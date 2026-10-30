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

/// v2 客户端提交的加密记录信封。
///
/// 服务端只校验元数据与密文摘要，不解密 `ciphertext_b64`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitChangeV2 {
    pub record_id: String,
    pub record_type: String,
    pub schema_version: u32,
    pub key_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
    pub revision: u64,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub deleted: bool,
    pub updated_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitRequestV2 {
    pub schema_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_cursor: Option<u64>,
    pub changes: Vec<CommitChangeV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedChangeV2 {
    pub record_id: String,
    pub revision: u64,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictDetailV2 {
    pub record_id: String,
    pub server_record_type: String,
    pub server_schema_version: u32,
    pub server_key_version: u64,
    pub server_revision: u64,
    pub server_ciphertext_b64: String,
    pub server_checksum: String,
    pub server_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_deleted_at: Option<String>,
    pub server_device_id: String,
    pub server_updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitResponseV2 {
    pub schema_version: u32,
    pub applied: Vec<AppliedChangeV2>,
    pub conflicts: Vec<ConflictDetailV2>,
    pub new_cursor: u64,
    pub head_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeRecordV2 {
    pub seq: u64,
    pub record_id: String,
    pub record_type: String,
    pub schema_version: u32,
    pub key_version: u64,
    pub revision: u64,
    pub ciphertext_b64: String,
    pub checksum: String,
    pub size: usize,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub updated_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangesPageResponseV2 {
    pub schema_version: u32,
    pub changes: Vec<ChangeRecordV2>,
    pub next_cursor: u64,
    pub has_more: bool,
    pub head_seq: u64,
}

#[cfg(test)]
mod v2_tests {
    use super::*;

    #[test]
    fn v2_commit_request_roundtrips_all_envelope_metadata() {
        let request = CommitRequestV2 {
            schema_version: 2,
            base_cursor: Some(41),
            changes: vec![CommitChangeV2 {
                record_id: "session:sess_01".to_string(),
                record_type: "session".to_string(),
                schema_version: 2,
                key_version: 3,
                base_revision: Some(7),
                revision: 8,
                ciphertext_b64: "cipher".to_string(),
                checksum: "checksum".to_string(),
                deleted: false,
                updated_at: "2026-10-29T09:00:00Z".to_string(),
                device_id: "device-a".to_string(),
            }],
        };

        let encoded = serde_json::to_string(&request).expect("serialize v2 commit");
        let decoded: CommitRequestV2 =
            serde_json::from_str(&encoded).expect("deserialize v2 commit");
        assert_eq!(decoded, request);
    }
}
