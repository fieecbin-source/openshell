use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub device_name: String,
    pub device_platform: String,
    pub device_arch: String,
    pub device_public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginDevicePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub platform: String,
    pub arch: String,
    pub public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub device: LoginDevicePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub account_id: String,
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountSummaryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountSummaryDto {
    pub id: String,
    pub email_masked: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoutRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub all_devices: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaDto {
    pub bytes_used: u64,
    pub bytes_limit: u64,
    pub records_used: u64,
    pub records_limit: u64,
    pub devices_used: u64,
    pub devices_limit: u64,
    pub snapshots_used: u64,
    pub snapshots_limit: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerFeaturesDto {
    pub relay_enabled: bool,
    pub multi_user: bool,
    pub registration_open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountResponse {
    pub account_id: String,
    pub email_masked: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_login_at: Option<String>,
    pub quota: QuotaDto,
    pub features: ServerFeaturesDto,
}
