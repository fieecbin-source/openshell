//! Authenticate the remote vault using the login password, without shipping local data.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openshell_core_domain::{now_ms, DomainError, DomainResult, ErrorCode, VaultId, VaultRecord};
use openshell_store::{Store, VaultRepo};
use openshell_sync_client::{SyncClient, SyncClientError};
use openshell_sync_protocol::{ApiErrorCode, KdfParamsDto, PutVaultRequest, VaultResponse};
use openshell_vault::{KdfParams, KeySlot, KeySlotParts, VaultManager, CRYPTO_SUITE, DEFAULT_KDF};

fn local_parts(vault: &VaultRecord) -> KeySlotParts {
    KeySlotParts {
        salt: vault.kdf_salt.clone(),
        kdf: KdfParams {
            mem_kib: vault.kdf_mem_kib as u32,
            time: vault.kdf_time as u32,
            parallelism: vault.kdf_parallelism as u32,
        },
        wrapped_vault_key: vault.wrapped_vault_key.clone(),
        key_check: vault.key_check.clone(),
    }
}

fn remote_parts(remote: &VaultResponse) -> DomainResult<KeySlotParts> {
    if remote.kdf.alg != "argon2id"
        || remote.key_version != 1
        || remote.kdf.mem_kib > 262144
        || remote.kdf.time > 10
        || remote.kdf.parallelism > 8
    {
        return Err(DomainError::validation(
            "Unsupported remote vault key or KDF parameters",
        ));
    }
    let decode = |value: &str| {
        BASE64
            .decode(value)
            .map_err(|_| DomainError::validation("Invalid remote vault key encoding"))
    };
    let parts = KeySlotParts {
        salt: decode(&remote.kdf.salt_b64)?,
        kdf: KdfParams {
            mem_kib: remote.kdf.mem_kib,
            time: remote.kdf.time,
            parallelism: remote.kdf.parallelism,
        },
        wrapped_vault_key: decode(&remote.wrapped_key_b64)?,
        key_check: decode(&remote.key_check_b64)?,
    };
    KeySlot::from_parts(&parts)?;
    Ok(parts)
}

fn request(vault_id: String, parts: &KeySlotParts) -> PutVaultRequest {
    PutVaultRequest {
        vault_id,
        schema_version: 2,
        crypto_suite: CRYPTO_SUITE.to_string(),
        key_version: 1,
        kdf: KdfParamsDto {
            alg: "argon2id".into(),
            salt_b64: BASE64.encode(&parts.salt),
            mem_kib: parts.kdf.mem_kib,
            time: parts.kdf.time,
            parallelism: parts.kdf.parallelism,
        },
        wrapped_key_b64: BASE64.encode(&parts.wrapped_vault_key),
        key_check_b64: BASE64.encode(&parts.key_check),
    }
}

fn network(error: SyncClientError) -> DomainError {
    DomainError::new(ErrorCode::Network, error.to_string())
}

pub(crate) async fn prepare(
    store: &Store,
    manager: &VaultManager,
    client: &SyncClient,
    password: &str,
    account_id: &str,
) -> DomainResult<String> {
    let repo = VaultRepo::new(store.clone());
    let local = repo.load()?;
    let remote = match client.get_vault().await {
        Ok(remote) => remote,
        Err(SyncClientError::Api {
            code: ApiErrorCode::NotFound,
            ..
        }) => {
            let (id, parts) = if let Some(vault) = &local {
                if !manager.is_unlocked() {
                    manager.unlock(&local_parts(vault), password).map_err(|_| DomainError::new(
                        ErrorCode::VaultLocked, "首次同步已有保险库前，请先用原主密码解锁；之后新设备只需同步账号密码。"))?;
                }
                let slot = manager.with_key(|key, _| {
                    Ok(KeySlot::create_with_key(key, password, DEFAULT_KDF)?.to_parts())
                })?;
                (vault.id.to_string(), slot)
            } else {
                let (slot, _) = KeySlot::create(password, DEFAULT_KDF)?;
                (VaultId::new().to_string(), slot.to_parts())
            };
            // A concurrent first device may win creation; always read the authoritative slot.
            match client.put_vault(request(id, &parts)).await {
                Ok(_)
                | Err(SyncClientError::Api {
                    code: ApiErrorCode::VaultExists,
                    ..
                }) => {}
                Err(error) => return Err(network(error)),
            }
            client.get_vault().await.map_err(network)?
        }
        Err(error) => return Err(network(error)),
    };
    let parts = remote_parts(&remote)?;
    let key = KeySlot::from_parts(&parts)?.unlock(password).map_err(|_| {
        DomainError::new(
            ErrorCode::VaultDecryptFailed,
            "同步密码不能解密远端保险库；账号密码变更后需要原设备更新同步密钥。",
        )
    })?;
    if let Some(mut vault) = local {
        // Never replace a nonempty local vault with a different key silently.
        manager
            .unlock_with_key(&local_parts(&vault), key)
            .map_err(|_| {
                DomainError::new(
                    ErrorCode::VaultDecryptFailed,
                    "本机与远端使用不同保险库，请先备份并合并本地数据后再同步。",
                )
            })?;
        vault.sync_enabled = true;
        vault.server_url = Some(client.server_url.clone());
        vault.account_id = Some(account_id.into());
        repo.save(&vault)?;
    } else {
        let now = now_ms();
        let record = VaultRecord {
            id: VaultId::from_string(&remote.vault_id)?,
            name: "default".into(),
            schema_version: openshell_store::SCHEMA_VERSION as i64,
            crypto_suite: CRYPTO_SUITE.into(),
            kdf_alg: "argon2id".into(),
            kdf_mem_kib: parts.kdf.mem_kib as i64,
            kdf_time: parts.kdf.time as i64,
            kdf_parallelism: parts.kdf.parallelism as i64,
            kdf_salt: parts.salt.clone(),
            wrapped_vault_key: parts.wrapped_vault_key.clone(),
            key_check: parts.key_check.clone(),
            keychain_ref: None,
            created_at: now,
            updated_at: now,
            last_opened_at: Some(now),
            sync_enabled: true,
            server_url: Some(client.server_url.clone()),
            account_id: Some(account_id.into()),
            quota_bytes: Some(remote.quota as i64),
        };
        repo.save(&record)?;
        manager.unlock_with_key(&parts, key)?;
    }
    Ok(remote.vault_id)
}
