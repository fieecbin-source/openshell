use crate::encryptor::CryptoSyncError;
use openshell_sync_protocol::*;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncClientError {
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error [{code:?}]: {message}")]
    Api {
        code: ApiErrorCode,
        message: String,
        status: u16,
    },
    #[error("Crypto error: {0}")]
    Crypto(#[from] CryptoSyncError),
    #[error("Store error: {0}")]
    Store(String),
    #[error("Configuration error: {0}")]
    Config(String),
}

#[derive(Clone)]
pub struct SyncClient {
    pub server_url: String,
    pub device_id: String,
    pub access_token: Option<String>,
    client: reqwest::Client,
}

impl SyncClient {
    pub fn new(server_url: impl Into<String>, device_id: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        Self {
            server_url: server_url.into().trim_end_matches('/').to_string(),
            device_id: device_id.into(),
            access_token: None,
            client,
        }
    }

    pub fn with_access_token(mut self, token: impl Into<String>) -> Self {
        self.access_token = Some(token.into());
        self
    }

    pub fn set_access_token(&mut self, token: impl Into<String>) {
        self.access_token = Some(token.into());
    }

    pub fn set_device_id(&mut self, device_id: impl Into<String>) {
        self.device_id = device_id.into();
    }

    fn default_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_API_VERSION, HeaderValue::from_static("1"));
        if let Ok(did) = HeaderValue::from_str(&self.device_id) {
            headers.insert(HEADER_DEVICE_ID, did);
        }
        if let Some(token) = &self.access_token {
            if let Ok(auth) = HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(AUTHORIZATION, auth);
            }
        }
        headers
    }

    pub async fn register(&self, req: RegisterRequest) -> Result<AuthResponse, SyncClientError> {
        let url = format!("{}/v1/auth/register", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            let auth: AuthResponse = resp.json().await?;
            Ok(auth)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::Internal,
                    message: "Registration request failed".to_string(),
                    status: 500,
                })
            }
        }
    }

    pub async fn login(&self, req: LoginRequest) -> Result<AuthResponse, SyncClientError> {
        let url = format!("{}/v1/auth/login", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            let auth: AuthResponse = resp.json().await?;
            Ok(auth)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::Unauthenticated,
                    message: "Login failed".to_string(),
                    status: 401,
                })
            }
        }
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResponse, SyncClientError> {
        let url = format!("{}/v1/auth/refresh", self.server_url);
        let req = RefreshRequest {
            refresh_token: refresh_token.to_string(),
            device_id: self.device_id.clone(),
        };

        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            let tok: TokenResponse = resp.json().await?;
            Ok(tok)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::TokenExpired,
                    message: "Refresh token failed".to_string(),
                    status: 401,
                })
            }
        }
    }

    pub async fn put_vault(&self, req: PutVaultRequest) -> Result<VaultResponse, SyncClientError> {
        let url = format!("{}/v1/vault", self.server_url);
        let resp = self
            .client
            .put(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            let v: VaultResponse = resp.json().await?;
            Ok(v)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::Internal,
                    message: "Put vault failed".to_string(),
                    status: 500,
                })
            }
        }
    }

    pub async fn get_vault(&self) -> Result<VaultResponse, SyncClientError> {
        let url = format!("{}/v1/vault", self.server_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            let v: VaultResponse = resp.json().await?;
            Ok(v)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::NotFound,
                    message: "Vault not found".to_string(),
                    status: 404,
                })
            }
        }
    }

    pub async fn commit(&self, req: CommitRequest) -> Result<CommitResponse, SyncClientError> {
        let url = format!("{}/v1/sync/commit", self.server_url);
        let mut headers = self.default_headers();
        let idem_key = ulid::Ulid::new().to_string();
        headers.insert(
            HEADER_IDEMPOTENCY_KEY,
            HeaderValue::from_str(&idem_key).unwrap_or(HeaderValue::from_static("key")),
        );

        let resp = self
            .client
            .post(&url)
            .headers(headers)
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            let r: CommitResponse = resp.json().await?;
            Ok(r)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::Internal,
                    message: "Sync commit failed".to_string(),
                    status: 500,
                })
            }
        }
    }

    pub async fn get_changes(
        &self,
        cursor: u64,
        limit: Option<usize>,
    ) -> Result<ChangesPageResponse, SyncClientError> {
        let limit_val = limit.unwrap_or(200);
        let url = format!(
            "{}/v1/sync/changes?cursor={}&limit={}&include_deleted=true",
            self.server_url, cursor, limit_val
        );

        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            let r: ChangesPageResponse = resp.json().await?;
            Ok(r)
        } else {
            let err_env: Result<ApiErrorEnvelope, _> = resp.json().await;
            if let Ok(env) = err_env {
                Err(SyncClientError::Api {
                    code: env.error.code,
                    message: env.error.message,
                    status: env.error.code.http_status(),
                })
            } else {
                Err(SyncClientError::Api {
                    code: ApiErrorCode::Internal,
                    message: "Get changes failed".to_string(),
                    status: 500,
                })
            }
        }
    }

    pub async fn check_update(
        &self,
        target: &str,
        channel: &str,
        install_id: &str,
    ) -> Result<Option<UpdateManifest>, SyncClientError> {
        let url = format!("{}/updates/{}/latest", self.server_url, target);
        let mut headers = self.default_headers();
        if let Ok(c) = HeaderValue::from_str(channel) {
            headers.insert(HEADER_CHANNEL, c);
        }
        if let Ok(inst) = HeaderValue::from_str(install_id) {
            headers.insert(HEADER_INSTALL_ID, inst);
        }

        let resp = self.client.get(&url).headers(headers).send().await?;

        if resp.status() == reqwest::StatusCode::NOT_MODIFIED
            || resp.status() == reqwest::StatusCode::NOT_FOUND
        {
            return Ok(None);
        }

        if resp.status().is_success() {
            let manifest: UpdateManifest = resp.json().await?;
            Ok(Some(manifest))
        } else {
            Ok(None)
        }
    }

    pub async fn register_device(
        &self,
        req: CreateDeviceRequest,
    ) -> Result<DeviceDto, SyncClientError> {
        let url = format!("{}/v1/devices", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(resp.json().await?)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Register device failed"))
        }
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceDto>, SyncClientError> {
        let url = format!("{}/v1/devices", self.server_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            let list: DeviceListResponse = resp.json().await?;
            Ok(list.devices)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "List devices failed"))
        }
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<(), SyncClientError> {
        let url = format!("{}/v1/devices/{}", self.server_url, device_id);
        let resp = self
            .client
            .delete(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Revoke device failed"))
        }
    }

    pub async fn add_key_slot(&self, req: AddKeySlotRequest) -> Result<(), SyncClientError> {
        let url = format!("{}/v1/vault/key-slot", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Add key slot failed"))
        }
    }

    pub async fn list_key_slots(&self) -> Result<Vec<KeySlotDto>, SyncClientError> {
        let url = format!("{}/v1/vault/key-slots", self.server_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            let list: KeySlotListResponse = resp.json().await?;
            Ok(list.slots)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "List key slots failed"))
        }
    }

    pub async fn get_sync_head(&self) -> Result<SyncHeadResponse, SyncClientError> {
        let url = format!("{}/v1/sync/head", self.server_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(resp.json().await?)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Get sync head failed"))
        }
    }

    pub async fn create_snapshot(
        &self,
        req: CreateSnapshotRequest,
    ) -> Result<SnapshotHeaderDto, SyncClientError> {
        let url = format!("{}/v1/vault/snapshots", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(resp.json().await?)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Create snapshot failed"))
        }
    }

    pub async fn list_snapshots(&self) -> Result<Vec<SnapshotHeaderDto>, SyncClientError> {
        let url = format!("{}/v1/vault/snapshots", self.server_url);
        let resp = self
            .client
            .get(&url)
            .headers(self.default_headers())
            .send()
            .await?;

        if resp.status().is_success() {
            let list: SnapshotListResponse = resp.json().await?;
            Ok(list.snapshots)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "List snapshots failed"))
        }
    }

    pub async fn rollback_snapshot(
        &self,
        req: RollbackRequest,
    ) -> Result<RollbackResponse, SyncClientError> {
        let url = format!("{}/v1/vault/rollback", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(resp.json().await?)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Rollback snapshot failed"))
        }
    }

    pub async fn create_relay_ticket(
        &self,
        req: RelayTicketRequest,
    ) -> Result<RelayTicketResponse, SyncClientError> {
        let url = format!("{}/v1/relay/tickets", self.server_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.default_headers())
            .json(&req)
            .send()
            .await?;

        if resp.status().is_success() {
            Ok(resp.json().await?)
        } else {
            let env: Result<ApiErrorEnvelope, _> = resp.json().await;
            Err(Self::extract_err(env, "Create relay ticket failed"))
        }
    }

    fn extract_err(
        env: Result<ApiErrorEnvelope, reqwest::Error>,
        fallback: &str,
    ) -> SyncClientError {
        if let Ok(e) = env {
            SyncClientError::Api {
                code: e.error.code,
                message: e.error.message,
                status: e.error.code.http_status(),
            }
        } else {
            SyncClientError::Api {
                code: ApiErrorCode::Internal,
                message: fallback.to_string(),
                status: 500,
            }
        }
    }
}
