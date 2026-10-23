use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolloutPolicy {
    pub percent: u32,
    pub seed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackPolicy {
    pub allowed: bool,
    pub to_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactDto {
    pub id: String,
    pub kind: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub signature_b64: String,
    pub signing_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub manifest_version: u32,
    pub target: String,
    pub channel: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    pub min_supported_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_os: Option<String>,
    pub released_at: String,
    pub mandatory: bool,
    pub rollout: RolloutPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes_url: Option<String>,
    pub artifacts: Vec<ArtifactDto>,
    pub revoked_versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback: Option<RollbackPolicy>,
    pub signature_b64: String,
    pub signing_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationsResponse {
    pub revoked_versions: Vec<String>,
    pub min_supported_version: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSummary {
    pub name: String,
    pub latest_version: String,
    pub rollout_percent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelsResponse {
    pub channels: Vec<ChannelSummary>,
}
