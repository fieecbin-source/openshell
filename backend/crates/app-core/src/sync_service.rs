use crate::sync_codec::{
    self, AppliedSyncRecord, ConflictBackupInput, LocalSyncRecord, SyncRecordType,
};
use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use openshell_store::Store;
use openshell_sync_client::{decrypt_entity_record, encrypt_entity_record, SyncClient};
use openshell_sync_protocol::*;
use openshell_vault::VaultManager;
use parking_lot::RwLock;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use ulid::Ulid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub server_url: Option<String>,
    pub account_id: Option<String>,
    pub device_id: String,
    pub auto_sync: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub conflict_count: u64,
    pub is_logged_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub pushed_count: usize,
    pub pulled_count: usize,
    pub conflict_count: usize,
    pub head_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConflict {
    pub id: String,
    pub record_id: String,
    pub record_type: String,
    pub created_at: i64,
    pub has_local_snapshot: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncConflictChoice {
    Local,
    Remote,
}

pub struct SyncService {
    store: Store,
    vault_manager: Arc<VaultManager>,
    cached_token: RwLock<Option<Zeroizing<String>>>,
    cached_refresh: RwLock<Option<Zeroizing<String>>>,
    expires_at: RwLock<Option<String>>,
    operation: tokio::sync::Mutex<()>,
}

impl SyncService {
    pub fn list_conflicts(&self) -> DomainResult<Vec<SyncConflict>> {
        self.store.with_conn(|conn| {
            let mut statement = conn.prepare("SELECT id,record_id,record_type,created_at,local_snapshot_json IS NOT NULL FROM sync_conflict WHERE resolved_at IS NULL ORDER BY created_at DESC,id DESC").map_err(|e| DomainError::internal(e.to_string()))?;
            let rows = statement.query_map([], |r| Ok(SyncConflict { id:r.get(0)?, record_id:r.get(1)?, record_type:r.get(2)?, created_at:r.get(3)?, has_local_snapshot:r.get(4)? })).map_err(|e| DomainError::internal(e.to_string()))?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|e| DomainError::internal(e.to_string()))
        })
    }

    pub async fn resolve_conflict(
        &self,
        conflict_id: &str,
        choice: SyncConflictChoice,
    ) -> DomainResult<()> {
        let _operation = self.operation.lock().await;
        let key = self.vault_manager.with_key(|key, _| Ok(key.clone()))?;
        let (id,kind,snapshot,ciphertext,checksum): (String,String,Option<String>,String,String) = self.store.with_conn(|conn| {
            conn.query_row("SELECT record_id,record_type,local_snapshot_json,remote_ciphertext_b64,remote_checksum FROM sync_conflict WHERE id=?1 AND resolved_at IS NULL", [conflict_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_| DomainError::not_found("sync conflict not found"))
        })?;
        let local = matches!(choice, SyncConflictChoice::Local);
        let record: LocalSyncRecord =
            if local {
                serde_json::from_str(&snapshot.ok_or_else(|| {
                    DomainError::validation("local conflict snapshot is unavailable")
                })?)
                .map_err(|_| DomainError::validation("local conflict snapshot is invalid"))?
            } else {
                decrypt_entity_record(&key, &kind, &id, 1, &ciphertext, &checksum)
                    .map_err(|_| DomainError::validation("remote conflict snapshot is invalid"))?
            };
        sync_codec::resolve_conflict_record(&self.store, conflict_id, local, &record)
    }
    pub fn new(store: Store, vault_manager: Arc<VaultManager>) -> Self {
        // Do not restore login material left by earlier versions, even after vault unlock.
        let _ = store.with_conn(|conn| {
            conn.pragma_update(None, "secure_delete", true).map_err(|e| DomainError::internal(e.to_string()))?;
            conn.execute("DELETE FROM setting WHERE scope='sync' AND key IN ('auth','access_token','refresh_token','password','login_password','remember_password')", [])
                .map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        });
        Self {
            store,
            vault_manager,
            cached_token: RwLock::new(None),
            cached_refresh: RwLock::new(None),
            expires_at: RwLock::new(None),
            operation: tokio::sync::Mutex::new(()),
        }
    }

    pub fn get_or_create_device_id(&self) -> String {
        let res: DomainResult<String> = self.store.with_conn(|conn| {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM device ORDER BY created_at ASC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .ok();

            if let Some(id) = existing {
                Ok(id)
            } else {
                let new_id = Ulid::new().to_string();
                let now = openshell_core_domain::now_ms();
                let _ = conn.execute(
                    "INSERT INTO device (id, name, platform, arch, app_version, device_public_key, created_at, last_seen_at) VALUES (?1, 'OpenShell Client', 'windows', 'x86_64', '0.1.0', 'pubkey', ?2, ?2)",
                    rusqlite::params![&new_id, now],
                );
                Ok(new_id)
            }
        });
        res.unwrap_or_else(|_| "default_device".to_string())
    }

    pub fn get_config(&self) -> DomainResult<SyncConfig> {
        let device_id = self.get_or_create_device_id();
        self.store.with_conn(|conn| {
            let server_url: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM setting WHERE scope = 'sync' AND key = 'server_url'",
                    [],
                    |r| {
                        let v: String = r.get(0)?;
                        Ok(serde_json::from_str(&v).unwrap_or(v))
                    },
                )
                .ok();

            let account_id: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM setting WHERE scope = 'sync' AND key = 'account_id'",
                    [],
                    |r| {
                        let v: String = r.get(0)?;
                        Ok(serde_json::from_str(&v).unwrap_or(v))
                    },
                )
                .ok();

            let auto_sync: bool = conn
                .query_row(
                    "SELECT value_json FROM setting WHERE scope = 'sync' AND key = 'auto_sync'",
                    [],
                    |r| {
                        let v: String = r.get(0)?;
                        Ok(serde_json::from_str(&v).unwrap_or(false))
                    },
                )
                .unwrap_or(false);

            let last_sync_at: Option<i64> = conn
                .query_row("SELECT last_pull_at FROM sync_meta LIMIT 1", [], |r| {
                    r.get(0)
                })
                .ok();

            let conflict_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sync_record WHERE sync_state = 'conflict'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let last_error: Option<String> = conn
                .query_row("SELECT last_error_code FROM sync_meta LIMIT 1", [], |r| {
                    r.get(0)
                })
                .ok();

            let has_token = self.cached_token.read().is_some();

            Ok(SyncConfig {
                server_url,
                account_id,
                device_id,
                auto_sync,
                last_sync_at,
                last_error,
                conflict_count: conflict_count as u64,
                is_logged_in: has_token,
            })
        })
    }

    pub fn save_config(&self, server_url: Option<String>, auto_sync: bool) -> DomainResult<()> {
        if let Some(url) = &server_url {
            let current = self
                .setting("server_url")?
                .map(|value| serde_json::from_str::<String>(&value).unwrap_or(value));
            if current.as_deref().is_some_and(|current| current != url) {
                self.logout()?;
            }
        }
        let now = openshell_core_domain::now_ms();
        self.store.with_conn(|conn| {
            if let Some(url) = server_url {
                let json = serde_json::to_string(&url).unwrap_or_default();
                conn.execute(
                    "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_url', 'sync', NULL, 'server_url', ?1, 'json', 0, ?2) ON CONFLICT(id) DO UPDATE SET value_json = ?1, updated_at = ?2",
                    rusqlite::params![&json, now],
                ).map_err(|e| DomainError::internal(e.to_string()))?;
            }
            let auto_json = serde_json::to_string(&auto_sync).unwrap_or_default();
            conn.execute(
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_auto', 'sync', NULL, 'auto_sync', ?1, 'json', 0, ?2) ON CONFLICT(id) DO UPDATE SET value_json = ?1, updated_at = ?2",
                rusqlite::params![&auto_json, now],
            ).map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })
    }

    pub async fn register(
        &self,
        server_url: &str,
        email: &str,
        password: &str,
        invite_code: Option<String>,
    ) -> DomainResult<AuthResponse> {
        let device_id = self.get_or_create_device_id();
        let client = SyncClient::new(server_url, &device_id)
            .map_err(|e| DomainError::validation(e.to_string()))?;

        let req = RegisterRequest {
            email: email.to_string(),
            password: password.to_string(),
            device_name: "OpenShell Client".to_string(),
            device_platform: "windows".to_string(),
            device_arch: "x86_64".to_string(),
            device_public_key: "client_pubkey".to_string(),
            invite_code,
        };

        let auth = client
            .register(req)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Network, e.to_string()))?;

        self.finish_login(server_url, password, &auth).await?;
        Ok(auth)
    }

    pub async fn login(
        &self,
        server_url: &str,
        email: &str,
        password: &str,
    ) -> DomainResult<AuthResponse> {
        let device_id = self.get_or_create_device_id();
        let client = SyncClient::new(server_url, &device_id)
            .map_err(|e| DomainError::validation(e.to_string()))?;

        let req = LoginRequest {
            email: email.to_string(),
            password: password.to_string(),
            device: LoginDevicePayload {
                id: Some(device_id),
                name: "OpenShell Client".to_string(),
                platform: "windows".to_string(),
                arch: "x86_64".to_string(),
                public_key: "client_pubkey".to_string(),
                app_version: Some("0.1.0".to_string()),
            },
        };

        let auth = client
            .login(req)
            .await
            .map_err(|e| DomainError::new(ErrorCode::AuthFailed, e.to_string()))?;

        self.finish_login(server_url, password, &auth).await?;
        Ok(auth)
    }

    pub fn logout(&self) -> DomainResult<()> {
        *self.cached_token.write() = None;
        *self.cached_refresh.write() = None;
        *self.expires_at.write() = None;

        self.store.with_conn(|conn| {
            let _ = conn.execute(
                "DELETE FROM setting WHERE scope = 'sync' AND key IN ('account_id', 'access_token', 'refresh_token', 'auth')",
                [],
            );
            let _ = conn.execute(
                "UPDATE sync_meta SET sync_state = 'idle', last_error_code = NULL",
                [],
            );
            Ok(())
        })
    }

    fn save_auth_state(&self, server_url: &str, account_id: &str) -> DomainResult<()> {
        let now = openshell_core_domain::now_ms();
        self.store.with_conn(|conn| {
            let url_json = serde_json::to_string(server_url).unwrap_or_default();
            let acc_json = serde_json::to_string(account_id).unwrap_or_default();

            conn.execute(
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_url', 'sync', NULL, 'server_url', ?1, 'json', 0, ?2) ON CONFLICT(id) DO UPDATE SET value_json = ?1, updated_at = ?2",
                rusqlite::params![&url_json, now],
            ).map_err(|e| DomainError::internal(e.to_string()))?;
            conn.execute(
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_acc', 'sync', NULL, 'account_id', ?1, 'json', 0, ?2) ON CONFLICT(id) DO UPDATE SET value_json = ?1, updated_at = ?2",
                rusqlite::params![&acc_json, now],
            ).map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })
    }

    fn setting(&self, key: &str) -> DomainResult<Option<String>> {
        self.store.with_conn(|conn| {
            conn.query_row("SELECT value_json FROM setting WHERE scope='sync' AND key=?1 ORDER BY updated_at DESC LIMIT 1", [key], |row| row.get(0))
                .optional().map_err(|e| DomainError::internal(e.to_string()))
        })
    }

    fn put_setting(&self, key: &str, value: &str) -> DomainResult<()> {
        self.store.with_conn(|conn| {
            conn.execute("INSERT INTO setting (id,scope,key,value_json,syncable,updated_at) VALUES (?1,'sync',?2,?3,0,?4) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![format!("sync.{key}"), key, value, openshell_core_domain::now_ms()])
                .map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })
    }

    fn cache_auth(&self, auth: &AuthResponse) -> DomainResult<()> {
        *self.cached_token.write() = Some(Zeroizing::new(auth.access_token.clone()));
        *self.cached_refresh.write() = Some(Zeroizing::new(auth.refresh_token.clone()));
        *self.expires_at.write() = Some(auth.access_expires_at.clone());
        Ok(())
    }

    async fn finish_login(
        &self,
        server_url: &str,
        password: &str,
        auth: &AuthResponse,
    ) -> DomainResult<()> {
        let _operation = self.operation.lock().await;
        let old = self.get_config()?;
        let client = SyncClient::new(server_url, &auth.device_id)
            .map_err(|e| DomainError::validation(e.to_string()))?
            .with_access_token(&auth.access_token);
        let remote_id = crate::sync_vault::prepare(
            &self.store,
            &self.vault_manager,
            &client,
            password,
            &auth.account_id,
        )
        .await?;
        if old.server_url.as_deref() != Some(server_url)
            || old
                .account_id
                .as_deref()
                .is_some_and(|id| id != auth.account_id)
        {
            self.store.with_conn(|conn| {
                let tx = conn
                    .transaction()
                    .map_err(|e| DomainError::internal(e.to_string()))?;
                tx.execute("DELETE FROM sync_meta", [])
                    .map_err(|e| DomainError::internal(e.to_string()))?;
                tx.execute("DELETE FROM sync_record", [])
                    .map_err(|e| DomainError::internal(e.to_string()))?;
                for table in [
                    "session_group",
                    "secret",
                    "credential",
                    "ssh_key",
                    "session",
                    "known_host",
                    "snippet",
                    "port_forward",
                ] {
                    tx.execute(&format!("UPDATE {table} SET dirty=1,version=0"), [])
                        .map_err(|e| DomainError::internal(e.to_string()))?;
                }
                tx.execute(
                    "UPDATE setting SET dirty=1,version=0 WHERE syncable=1 AND scope='user'",
                    [],
                )
                .map_err(|e| DomainError::internal(e.to_string()))?;
                tx.commit()
                    .map_err(|e| DomainError::internal(e.to_string()))
            })?;
        }
        self.save_auth_state(server_url, &auth.account_id)?;
        self.put_setting("remote_vault_id", &remote_id)?;
        self.cache_auth(auth)?;
        self.save_config(Some(server_url.into()), true)?;
        self.sync_inner().await?;
        Ok(())
    }

    pub async fn sync_now(&self) -> DomainResult<SyncResult> {
        let _operation = self.operation.lock().await;
        self.sync_inner().await
    }

    async fn sync_inner(&self) -> DomainResult<SyncResult> {
        let network_secrets = crate::network_secrets::NetworkSecrets::new(
            self.store.clone(),
            self.vault_manager.clone(),
        );
        network_secrets.proxies()?;
        network_secrets.forwards(None).await?;
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "Vault must be unlocked to perform sync",
            ));
        }
        let config = self.get_config()?;
        let url = config
            .server_url
            .ok_or_else(|| DomainError::validation("Server URL is not configured"))?;
        let remote_id = self
            .setting("remote_vault_id")?
            .ok_or_else(|| DomainError::validation("Log in again to initialize the sync vault"))?;
        let token = self.cached_token.read().clone().ok_or_else(|| {
            DomainError::new(ErrorCode::AuthFailed, "Not logged in to sync server")
        })?;
        let mut client = SyncClient::new(&url, &config.device_id)
            .map_err(|e| DomainError::validation(e.to_string()))?
            .with_access_token(token.as_str());
        let expiry = self.expires_at.read().clone();
        let expires_soon = expiry
            .as_deref()
            .and_then(|v| {
                time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339).ok()
            })
            .is_none_or(|v| {
                v.unix_timestamp() <= time::OffsetDateTime::now_utc().unix_timestamp() + 30
            });
        if expires_soon {
            let refresh =
                self.cached_refresh.read().clone().ok_or_else(|| {
                    DomainError::new(ErrorCode::AuthFailed, "Please log in again")
                })?;
            let renewed = client.refresh(refresh.as_str()).await.map_err(network)?;
            client.set_access_token(&renewed.access_token);
            self.cache_auth(&AuthResponse {
                account_id: config.account_id.clone().unwrap_or_default(),
                access_token: renewed.access_token,
                access_expires_at: renewed.access_expires_at,
                refresh_token: renewed.refresh_token,
                refresh_expires_at: renewed.refresh_expires_at,
                device_id: config.device_id.clone(),
                account: None,
            })?;
        }
        let key = self.vault_manager.with_key(|key, _| Ok(key.clone()))?;
        let mut cursor = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT last_cursor FROM sync_meta WHERE vault_id=?1",
                [&remote_id],
                |r| r.get::<_, u64>(0),
            )
            .optional()
            .map(|v| v.unwrap_or(0))
            .map_err(|e| DomainError::internal(e.to_string()))
        })?;
        let mut incoming = Vec::new();
        let mut envelopes = HashMap::new();
        let mut head;
        loop {
            let page = client
                .get_changes_v2(cursor, Some(500))
                .await
                .map_err(network)?;
            head = page.head_seq;
            for change in page.changes {
                if change.schema_version != sync_codec::SYNC_SCHEMA_VERSION
                    || change.key_version != 1
                {
                    return Err(DomainError::validation("Unsupported sync record version"));
                }
                let record: LocalSyncRecord = decrypt_entity_record(
                    &key,
                    &change.record_type,
                    &change.record_id,
                    1,
                    &change.ciphertext_b64,
                    &change.checksum,
                )
                .map_err(|e| DomainError::validation(e.to_string()))?;
                if record.record_id != change.record_id
                    || record.record_type.as_str() != change.record_type
                    || record.revision != change.revision
                    || record.schema_version != change.schema_version
                    || record.deleted != change.deleted
                    || record.device_id.as_deref() != Some(&change.device_id)
                {
                    return Err(DomainError::validation(
                        "Encrypted sync record metadata mismatch",
                    ));
                }
                envelopes.insert(record.record_id.clone(), change);
                incoming.push(record);
            }
            if page.has_more && page.next_cursor <= cursor {
                return Err(DomainError::validation("Sync cursor did not advance"));
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let dirty = sync_codec::collect_dirty_records(&self.store)?;
        let dirty_by_id: HashMap<_, _> = dirty.iter().map(|r| (r.record_id.clone(), r)).collect();
        let mut conflicts = Vec::new();
        let retained = self.store.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT record_id,record_type,local_snapshot_json,remote_ciphertext_b64,remote_checksum,remote_revision,remote_device_id,remote_deleted,remote_updated_at FROM sync_conflict WHERE resolved_at IS NULL ORDER BY remote_revision DESC,created_at DESC,id DESC")
                .map_err(|e| DomainError::internal(e.to_string()))?;
            let rows = statement.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,u64>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,bool>(7)?,r.get::<_,i64>(8)?)))
                .map_err(|e| DomainError::internal(e.to_string()))?;
            let mut retained = HashMap::new();
            for row in rows {
                let (id,kind,snapshot,ciphertext,checksum,revision,device,deleted,updated) = row.map_err(|e| DomainError::internal(e.to_string()))?;
                retained.entry(id.clone()).or_insert(ConflictBackupInput {
                    record_id:id,record_type:SyncRecordType::parse(&kind)?,
                    local_snapshot:snapshot.map(|value|serde_json::from_str(&value)).transpose().map_err(|e|DomainError::internal(e.to_string()))?,
                    remote_ciphertext_b64:ciphertext,remote_checksum:checksum,remote_revision:revision,
                    remote_device_id:device,remote_deleted:deleted,remote_updated_at:updated,
                });
            }
            Ok(retained)
        })?;
        let mut conflicted: HashSet<String> = retained.keys().cloned().collect();
        for record in &incoming {
            let local = dirty_by_id.get(&record.record_id);
            let previous = retained.get(&record.record_id);
            if local.is_some() || previous.is_some() {
                let revision = self.remote_revision(&record.record_id)?;
                // A lost upload acknowledgement can leave our own remote echo conflicting too.
                if record.revision > revision {
                    let envelope = &envelopes[&record.record_id];
                    conflicts.push(ConflictBackupInput {
                        record_id: record.record_id.clone(),
                        record_type: record.record_type,
                        local_snapshot: local
                            .map(serde_json::to_value)
                            .transpose()
                            .map_err(|e| DomainError::internal(e.to_string()))?
                            .or_else(|| {
                                previous.and_then(|conflict| conflict.local_snapshot.clone())
                            }),
                        remote_ciphertext_b64: envelope.ciphertext_b64.clone(),
                        remote_checksum: envelope.checksum.clone(),
                        remote_revision: record.revision,
                        remote_device_id: record.device_id.clone(),
                        remote_deleted: record.deleted,
                        remote_updated_at: record.updated_at,
                    });
                    conflicted.insert(record.record_id.clone());
                }
            }
        }
        // Refresh changed local copies even without a new remote revision; retain the old rows.
        for local in &dirty {
            if conflicts
                .iter()
                .any(|conflict| conflict.record_id == local.record_id)
            {
                continue;
            }
            if let Some(previous) = retained.get(&local.record_id) {
                let snapshot = previous
                    .local_snapshot
                    .clone()
                    .map(serde_json::from_value::<LocalSyncRecord>)
                    .transpose()
                    .map_err(|e| DomainError::internal(e.to_string()))?;
                if snapshot.as_ref() != Some(local) {
                    let mut refreshed = previous.clone();
                    refreshed.local_snapshot = Some(
                        serde_json::to_value(local)
                            .map_err(|e| DomainError::internal(e.to_string()))?,
                    );
                    conflicts.push(refreshed);
                }
            }
        }
        let summary =
            sync_codec::apply_remote_records_with_conflicts(&self.store, &incoming, conflicts)?;
        self.save_cursor(&remote_id, &url, cursor)?;
        let pending = sync_codec::collect_dirty_records(&self.store)?;
        let mut pushed_count = 0;
        for chunk in pending.chunks(100) {
            let mut sent = Vec::new();
            let mut changes = Vec::new();
            for source in chunk {
                if conflicted.contains(&source.record_id) {
                    continue;
                }
                let base = self.remote_revision(&source.record_id)?;
                let mut record = source.clone();
                record.revision = base + 1;
                record.device_id = Some(config.device_id.clone());
                let (ciphertext_b64, checksum) = encrypt_entity_record(
                    &key,
                    record.record_type.as_str(),
                    &record.record_id,
                    1,
                    &record,
                )
                .map_err(|e| DomainError::validation(e.to_string()))?;
                let updated_at = time::OffsetDateTime::from_unix_timestamp_nanos(
                    record.updated_at as i128 * 1_000_000,
                )
                .map_err(|e| DomainError::validation(e.to_string()))?
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|e| DomainError::validation(e.to_string()))?;
                changes.push(CommitChangeV2 {
                    record_id: record.record_id.clone(),
                    record_type: record.record_type.as_str().into(),
                    schema_version: 2,
                    key_version: 1,
                    base_revision: (base > 0).then_some(base),
                    revision: base + 1,
                    ciphertext_b64,
                    checksum,
                    deleted: record.deleted,
                    updated_at,
                    device_id: config.device_id.clone(),
                });
                sent.push(source.clone());
            }
            if changes.is_empty() {
                continue;
            }
            let response = client
                .commit_v2(CommitRequestV2 {
                    schema_version: 2,
                    base_cursor: Some(cursor),
                    changes: changes.clone(),
                })
                .await
                .map_err(network)?;
            head = response.head_seq;
            let current: HashMap<_, _> = sync_codec::collect_dirty_records(&self.store)?
                .into_iter()
                .map(|r| (r.record_id.clone(), r))
                .collect();
            let mut clean = Vec::new();
            for applied in &response.applied {
                let snapshot = sent
                    .iter()
                    .find(|r| r.record_id == applied.record_id)
                    .ok_or_else(|| {
                        DomainError::validation("Server acknowledged an unknown sync record")
                    })?;
                let envelope = changes
                    .iter()
                    .find(|r| r.record_id == applied.record_id)
                    .ok_or_else(|| {
                        DomainError::validation("Server acknowledged an unknown sync envelope")
                    })?;
                if current.get(&applied.record_id) == Some(snapshot) {
                    clean.push(AppliedSyncRecord {
                        record_id: applied.record_id.clone(),
                        record_type: snapshot.record_type,
                        revision: applied.revision,
                        key_version: 1,
                        checksum: Some(envelope.checksum.clone()),
                        deleted: snapshot.deleted,
                    });
                } else {
                    // A local edit during upload stays dirty, but the next upload uses the acknowledged base.
                    self.store.with_conn(|conn| {
                        conn.execute("INSERT INTO sync_record(record_id,record_type,updated_at,revision,schema_version) VALUES (?1,?2,?3,?4,2) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision",
                            rusqlite::params![&applied.record_id, snapshot.record_type.as_str(), openshell_core_domain::now_ms(), applied.revision])
                            .map_err(|e| DomainError::internal(e.to_string()))?; Ok(())
                    })?;
                }
            }
            sync_codec::mark_uploaded_records(&self.store, &clean, &sent)?;
            pushed_count += response.applied.len();
            for conflict in response.conflicts {
                let local = sent
                    .iter()
                    .find(|r| r.record_id == conflict.record_id)
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(|e| DomainError::internal(e.to_string()))?;
                sync_codec::backup_conflict(
                    &self.store,
                    ConflictBackupInput {
                        record_id: conflict.record_id.clone(),
                        record_type: SyncRecordType::parse(&conflict.server_record_type)?,
                        local_snapshot: local,
                        remote_ciphertext_b64: conflict.server_ciphertext_b64,
                        remote_checksum: conflict.server_checksum,
                        remote_revision: conflict.server_revision,
                        remote_device_id: Some(conflict.server_device_id),
                        remote_deleted: conflict.server_deleted,
                        remote_updated_at: openshell_core_domain::now_ms(),
                    },
                )?;
                conflicted.insert(conflict.record_id);
            }
            // Keep the pulled cursor: commit.new_cursor may include another device's unseen writes.
        }
        Ok(SyncResult {
            pushed_count,
            pulled_count: summary.applied + summary.deleted,
            conflict_count: conflicted.len(),
            head_seq: head,
        })
    }

    fn remote_revision(&self, id: &str) -> DomainResult<u64> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT revision FROM sync_record WHERE record_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.unwrap_or(0))
            .map_err(|e| DomainError::internal(e.to_string()))
        })
    }

    fn save_cursor(&self, vault: &str, url: &str, cursor: u64) -> DomainResult<()> {
        self.store.with_conn(|conn| {
            conn.execute("INSERT INTO sync_meta(vault_id,server_url,last_cursor,last_pull_at,sync_state) VALUES (?1,?2,?3,?4,'idle') ON CONFLICT(vault_id) DO UPDATE SET last_cursor=excluded.last_cursor,last_pull_at=excluded.last_pull_at",
                rusqlite::params![vault,url,cursor,openshell_core_domain::now_ms()]).map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })
    }

    pub async fn check_updates(&self) -> DomainResult<Option<UpdateManifest>> {
        let config = self.get_config()?;
        let server_url = match config.server_url {
            Some(u) => u,
            None => return Ok(None),
        };
        let client = SyncClient::new(server_url, &config.device_id)
            .map_err(|e| DomainError::validation(e.to_string()))?;
        client
            .check_update("windows-x86_64", "stable", &config.device_id)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Network, e.to_string()))
    }
}

fn network(error: openshell_sync_client::SyncClientError) -> DomainError {
    DomainError::new(ErrorCode::Network, error.to_string())
}
