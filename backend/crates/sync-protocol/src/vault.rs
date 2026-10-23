use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParamsDto {
    pub alg: String,
    pub salt_b64: String,
    pub mem_kib: u32,
    pub time: u32,
    pub parallelism: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutVaultRequest {
    pub vault_id: String,
    pub schema_version: u32,
    pub crypto_suite: String,
    pub kdf: KdfParamsDto,
    pub wrapped_key_b64: String,
    pub key_check_b64: String,
    pub key_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultResponse {
    pub vault_id: String,
    pub schema_version: u32,
    pub key_version: u32,
    pub kdf: KdfParamsDto,
    pub wrapped_key_b64: String,
    pub key_check_b64: String,
    pub head_seq: u64,
    pub record_count: u64,
    pub bytes_used: u64,
    pub quota: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySlotDto {
    pub key_version: u32,
    pub kdf: KdfParamsDto,
    pub wrapped_key_b64: String,
    pub key_check_b64: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddKeySlotRequest {
    pub key_version: u32,
    pub wrapped_key_b64: String,
    pub key_check_b64: String,
    pub kdf: KdfParamsDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySlotListResponse {
    pub slots: Vec<KeySlotDto>,
}
