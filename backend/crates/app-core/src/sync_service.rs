use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use openshell_store::Store;
use openshell_sync_client::{encrypt_entity_record, SyncClient};
use openshell_sync_protocol::*;
use openshell_vault::VaultManager;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ulid::Ulid;

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

pub struct SyncService {
    store: Store,
    vault_manager: Arc<VaultManager>,
    cached_token: RwLock<Option<String>>,
    cached_refresh: RwLock<Option<String>>,
}

impl SyncService {
    pub fn new(store: Store, vault_manager: Arc<VaultManager>) -> Self {
        Self {
            store,
            vault_manager,
            cached_token: RwLock::new(None),
            cached_refresh: RwLock::new(None),
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

            let has_token = self.cached_token.read().is_some() || account_id.is_some();

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
        let now = openshell_core_domain::now_ms();
        self.store.with_conn(|conn| {
            if let Some(url) = server_url {
                let json = serde_json::to_string(&url).unwrap_or_default();
                conn.execute(
                    "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_url', 'sync', NULL, 'server_url', ?1, 'json', 0, ?2) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json = ?1, updated_at = ?2",
                    rusqlite::params![&json, now],
                ).map_err(|e| DomainError::internal(e.to_string()))?;
            }
            let auto_json = serde_json::to_string(&auto_sync).unwrap_or_default();
            conn.execute(
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_auto', 'sync', NULL, 'auto_sync', ?1, 'json', 0, ?2) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json = ?1, updated_at = ?2",
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
        let client = SyncClient::new(server_url, &device_id);

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

        *self.cached_token.write() = Some(auth.access_token.clone());
        *self.cached_refresh.write() = Some(auth.refresh_token.clone());

        self.save_auth_state(server_url, &auth.account_id)?;

        Ok(auth)
    }

    pub async fn login(
        &self,
        server_url: &str,
        email: &str,
        password: &str,
    ) -> DomainResult<AuthResponse> {
        let device_id = self.get_or_create_device_id();
        let client = SyncClient::new(server_url, &device_id);

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

        *self.cached_token.write() = Some(auth.access_token.clone());
        *self.cached_refresh.write() = Some(auth.refresh_token.clone());

        self.save_auth_state(server_url, &auth.account_id)?;

        Ok(auth)
    }

    pub fn logout(&self) -> DomainResult<()> {
        *self.cached_token.write() = None;
        *self.cached_refresh.write() = None;

        self.store.with_conn(|conn| {
            let _ = conn.execute(
                "DELETE FROM setting WHERE scope = 'sync' AND key IN ('account_id', 'access_token', 'refresh_token')",
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
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_url', 'sync', NULL, 'server_url', ?1, 'json', 0, ?2) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json = ?1, updated_at = ?2",
                rusqlite::params![&url_json, now],
            ).map_err(|e| DomainError::internal(e.to_string()))?;
            conn.execute(
                "INSERT INTO setting (id, scope, scope_id, key, value_json, value_type, syncable, updated_at) VALUES ('set_acc', 'sync', NULL, 'account_id', ?1, 'json', 0, ?2) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json = ?1, updated_at = ?2",
                rusqlite::params![&acc_json, now],
            ).map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })
    }

    pub async fn sync_now(&self) -> DomainResult<SyncResult> {
        if !self.vault_manager.is_unlocked() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "Vault must be unlocked to perform sync",
            ));
        }

        let config = self.get_config()?;
        let server_url = config
            .server_url
            .ok_or_else(|| DomainError::validation("Server URL is not configured"))?;

        let token = self.cached_token.read().clone().ok_or_else(|| {
            DomainError::new(ErrorCode::AuthFailed, "Not logged in to sync server")
        })?;

        let client = SyncClient::new(&server_url, &config.device_id).with_access_token(token);

        let now_ms = openshell_core_domain::now_ms();
        let now_iso = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();

        // 1. Ensure remote vault exists
        let vault_row: Option<(String, String, String, String, String)> = self.store.with_conn(|conn| {
            let row = conn.query_row(
                "SELECT id, schema_version, wrapped_vault_key, key_check, kdf_json FROM vault LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            ).ok();
            Ok(row)
        })?;

        if let Some((vid, s_ver, w_key, k_check, kdf_str)) = vault_row {
            let kdf: KdfParamsDto = serde_json::from_str(&kdf_str).unwrap_or(KdfParamsDto {
                alg: "argon2id".to_string(),
                salt_b64: "".to_string(),
                mem_kib: 65536,
                time: 3,
                parallelism: 1,
            });

            let put_req = PutVaultRequest {
                vault_id: vid,
                schema_version: s_ver.parse().unwrap_or(1),
                crypto_suite: "xchacha20poly1305".to_string(),
                kdf,
                wrapped_key_b64: w_key,
                key_check_b64: k_check,
                key_version: 1,
            };
            let _ = client.put_vault(put_req).await;
        }

        // 2. Pull remote changes
        let last_cursor: u64 = self.store.with_conn(|conn| {
            let cur: u64 = conn
                .query_row("SELECT last_cursor FROM sync_meta LIMIT 1", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);
            Ok(cur)
        })?;

        let changes_page = client
            .get_changes(last_cursor, Some(500))
            .await
            .map_err(|e| DomainError::new(ErrorCode::Network, e.to_string()))?;

        let mut pulled_count = 0;
        let mut conflict_count = 0;

        self.store.with_conn(|conn| -> DomainResult<()> {
            let tx = conn.transaction().map_err(|e| DomainError::internal(e.to_string()))?;

            for ch in &changes_page.changes {
                pulled_count += 1;
                tx.execute(
                    "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, server_checksum, sync_state, updated_at) VALUES (?1, 'record', ?2, ?2, ?3, 'clean', ?4) ON CONFLICT(record_id) DO UPDATE SET base_version = ?2, server_checksum = ?3, sync_state = 'clean', updated_at = ?4",
                    rusqlite::params![&ch.record_id, ch.version, &ch.checksum, now_ms],
                ).map_err(|e| DomainError::internal(e.to_string()))?;
            }

            tx.execute(
                "INSERT INTO sync_meta (vault_id, server_url, last_cursor, last_pull_at, sync_state) VALUES ('default', ?1, ?2, ?3, 'idle') ON CONFLICT(vault_id) DO UPDATE SET last_cursor = ?2, last_pull_at = ?3, sync_state = 'idle'",
                rusqlite::params![&server_url, changes_page.next_cursor, now_ms],
            ).map_err(|e| DomainError::internal(e.to_string()))?;

            tx.commit().map_err(|e| DomainError::internal(e.to_string()))?;
            Ok(())
        })?;

        // 3. Push local dirty changes
        let mut changes = Vec::new();

        self.vault_manager.with_key(|key, key_ver| {
            self.store.with_conn(|conn| {
                // Collect dirty sessions
                let mut stmt = conn.prepare(
                    "SELECT id, name, protocol, host, port, username, dirty, version FROM session WHERE dirty = 1",
                ).map_err(|e| DomainError::internal(e.to_string()))?;

                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        serde_json::json!({
                            "id": r.get::<_, String>(0)?,
                            "name": r.get::<_, String>(1)?,
                            "protocol": r.get::<_, String>(2)?,
                            "host": r.get::<_, Option<String>>(3)?,
                            "port": r.get::<_, Option<u16>>(4)?,
                            "username": r.get::<_, Option<String>>(5)?,
                        }),
                        r.get::<_, u64>(7)?,
                    ))
                }).map_err(|e| DomainError::internal(e.to_string()))?;

                for (rid, data, ver) in rows.flatten() {
                    if let Ok((cipher, csum)) = encrypt_entity_record(key, "session", &rid, key_ver, &data) {
                        changes.push(CommitChange {
                            record_id: rid,
                            base_version: if ver > 0 { Some(ver) } else { None },
                            ciphertext_b64: cipher,
                            checksum: csum,
                            deleted: false,
                            client_updated_at: now_iso.clone(),
                        });
                    }
                }

                // Collect dirty snippets
                let mut snip_stmt = conn.prepare(
                    "SELECT id, name, body, dirty, version FROM snippet WHERE dirty = 1",
                ).map_err(|e| DomainError::internal(e.to_string()))?;

                let snip_rows = snip_stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        serde_json::json!({
                            "id": r.get::<_, String>(0)?,
                            "name": r.get::<_, String>(1)?,
                            "body": r.get::<_, Option<String>>(2)?,
                        }),
                        r.get::<_, u64>(4)?,
                    ))
                }).map_err(|e| DomainError::internal(e.to_string()))?;

                for (rid, data, ver) in snip_rows.flatten() {
                    if let Ok((cipher, csum)) = encrypt_entity_record(key, "snippet", &rid, key_ver, &data) {
                        changes.push(CommitChange {
                            record_id: rid,
                            base_version: if ver > 0 { Some(ver) } else { None },
                            ciphertext_b64: cipher,
                            checksum: csum,
                            deleted: false,
                            client_updated_at: now_iso.clone(),
                        });
                    }
                }

                Ok(())
            })
        })?;

        let mut pushed_count = 0;
        let mut final_head = changes_page.head_seq;

        if !changes.is_empty() {
            let commit_resp = client
                .commit(CommitRequest {
                    base_cursor: Some(changes_page.next_cursor),
                    changes,
                })
                .await
                .map_err(|e| DomainError::new(ErrorCode::Network, e.to_string()))?;

            pushed_count = commit_resp.applied.len();
            conflict_count = commit_resp.conflicts.len();
            final_head = commit_resp.head_seq;

            self.store.with_conn(|conn| -> DomainResult<()> {
                let tx = conn.transaction().map_err(|e| DomainError::internal(e.to_string()))?;

                for app in commit_resp.applied {
                    tx.execute(
                        "UPDATE session SET dirty = 0, version = ?1 WHERE id = ?2",
                        rusqlite::params![app.version, &app.record_id],
                    ).map_err(|e| DomainError::internal(e.to_string()))?;

                    tx.execute(
                        "UPDATE snippet SET dirty = 0, version = ?1 WHERE id = ?2",
                        rusqlite::params![app.version, &app.record_id],
                    ).map_err(|e| DomainError::internal(e.to_string()))?;

                    tx.execute(
                        "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, sync_state, updated_at) VALUES (?1, 'record', ?2, ?2, 'clean', ?3) ON CONFLICT(record_id) DO UPDATE SET base_version = ?2, sync_state = 'clean', updated_at = ?3",
                        rusqlite::params![&app.record_id, app.version, now_ms],
                    ).map_err(|e| DomainError::internal(e.to_string()))?;
                }

                for conf in commit_resp.conflicts {
                    let conf_json = serde_json::to_string(&conf).unwrap_or_default();
                    tx.execute(
                        "INSERT INTO sync_record (record_id, record_type, base_version, local_rev, sync_state, conflict_json, updated_at) VALUES (?1, 'record', ?2, ?2, 'conflict', ?3, ?4) ON CONFLICT(record_id) DO UPDATE SET sync_state = 'conflict', conflict_json = ?3, updated_at = ?4",
                        rusqlite::params![&conf.record_id, conf.server_version, &conf_json, now_ms],
                    ).map_err(|e| DomainError::internal(e.to_string()))?;
                }

                tx.execute(
                    "UPDATE sync_meta SET last_cursor = ?1, last_push_at = ?2",
                    rusqlite::params![commit_resp.new_cursor, now_ms],
                ).map_err(|e| DomainError::internal(e.to_string()))?;

                tx.commit().map_err(|e| DomainError::internal(e.to_string()))?;
                Ok(())
            })?;
        }

        Ok(SyncResult {
            pushed_count,
            pulled_count,
            conflict_count,
            head_seq: final_head,
        })
    }

    pub async fn check_updates(&self) -> DomainResult<Option<UpdateManifest>> {
        let config = self.get_config()?;
        let server_url = match config.server_url {
            Some(u) => u,
            None => return Ok(None),
        };
        let client = SyncClient::new(server_url, &config.device_id);
        client
            .check_update("windows-x86_64", "stable", &config.device_id)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Network, e.to_string()))
    }
}
