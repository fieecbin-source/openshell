//! 保险库状态机：锁定/解锁、密钥槽管理与秘密加解密。

use crate::error;
use crate::kdf::KdfParams;
use crate::key_hierarchy::VaultKey;
use crate::key_slot::{KeySlot, KeySlotParts};
use crate::record_cipher::{RecordCipher, CRYPTO_SUITE};
use openshell_core_domain::{now_ms, DomainResult, SecretId, SecretRecord, VaultState};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// 当前密钥版本（M2 固定为 1，轮换留待后续里程碑）。
const INITIAL_KEY_VERSION: i64 = 1;

struct Inner {
    state: VaultState,
    key: Option<VaultKey>,
    slot: Option<KeySlotParts>,
    key_version: i64,
}

impl Inner {
    fn new() -> Self {
        Self {
            state: VaultState::Uninitialized,
            key: None,
            slot: None,
            key_version: INITIAL_KEY_VERSION,
        }
    }
}

/// 保险库管理器，实现 `core-domain` 的 `SecretStore`。
pub struct VaultManager {
    inner: RwLock<Inner>,
}

impl Default for VaultManager {
    fn default() -> Self {
        Self::new()
    }
}

impl VaultManager {
    /// 创建未初始化的管理器。
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner::new()),
        }
    }

    /// 当前状态。
    pub fn state(&self) -> VaultState {
        self.read_inner().state
    }

    /// 是否已解锁。
    pub fn is_unlocked(&self) -> bool {
        let inner = self.read_inner();
        inner.state == VaultState::Unlocked && inner.key.is_some()
    }

    /// 当前密钥版本。
    pub fn key_version(&self) -> i64 {
        self.read_inner().key_version
    }

    /// 初始化保险库：生成随机 VaultKey 与密钥槽，并直接进入解锁态。
    ///
    /// 返回可直接写入 `vault` 行的密钥槽字段，以及 VaultKey 副本（调用方用完即弃）。
    pub fn init(
        &self,
        master_password: &str,
        kdf: KdfParams,
    ) -> DomainResult<(KeySlotParts, VaultKey)> {
        let mut inner = self.write_inner();
        if inner.state != VaultState::Uninitialized {
            return Err(error::validation("vault is already initialized"));
        }
        let (slot, key) = KeySlot::create(master_password, kdf)?;
        let parts = slot.to_parts();
        let returned = key.clone();
        inner.state = VaultState::Unlocked;
        inner.key = Some(key);
        inner.slot = Some(parts.clone());
        inner.key_version = INITIAL_KEY_VERSION;
        Ok((parts, returned))
    }

    /// 用密钥槽字段与主密码解锁。
    pub fn unlock(&self, parts: &KeySlotParts, password: &str) -> DomainResult<()> {
        let slot = KeySlot::from_parts(parts)?;
        let key = slot.unlock(password)?;
        let mut inner = self.write_inner();
        inner.state = VaultState::Unlocked;
        inner.key = Some(key);
        inner.slot = Some(parts.clone());
        if inner.key_version <= 0 {
            inner.key_version = INITIAL_KEY_VERSION;
        }
        Ok(())
    }

    /// Restore the same local vault using its authenticated remote key slot.
    pub fn unlock_with_key(&self, parts: &KeySlotParts, key: VaultKey) -> DomainResult<()> {
        KeySlot::from_parts(parts)?.verify_key(&key)?;
        let mut inner = self.write_inner();
        inner.state = VaultState::Unlocked;
        inner.key = Some(key);
        inner.slot = Some(parts.clone());
        inner.key_version = INITIAL_KEY_VERSION;
        Ok(())
    }

    /// 锁定保险库并清零内存中的 VaultKey（幂等）。
    pub fn lock(&self) {
        let mut inner = self.write_inner();
        inner.key = None;
        if inner.state == VaultState::Unlocked {
            inner.state = VaultState::Locked;
        }
    }

    /// 修改主密码：仅重新包裹同一 VaultKey，key_version 不变。
    pub fn change_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> DomainResult<KeySlotParts> {
        let mut inner = self.write_inner();
        let key = match (&inner.key, inner.state) {
            (Some(key), VaultState::Unlocked) => key,
            _ => return Err(error::locked()),
        };
        let parts = inner
            .slot
            .as_ref()
            .ok_or_else(|| error::corrupt("vault key slot is missing"))?
            .clone();
        let old_slot = KeySlot::from_parts(&parts)?;
        let verified = old_slot.unlock(old_password)?;
        if verified.as_bytes() != key.as_bytes() {
            return Err(error::corrupt("key slot does not match unlocked key"));
        }
        let new_slot = KeySlot::create_with_key(key, new_password, parts.kdf)?;
        let new_parts = new_slot.to_parts();
        inner.slot = Some(new_parts.clone());
        Ok(new_parts)
    }

    /// 加密普通记录（使用当前 key_version）。
    pub fn encrypt_record(
        &self,
        record_type: &str,
        record_id: &str,
        plaintext: &[u8],
    ) -> DomainResult<RecordCipher> {
        self.with_key(|key, version| key.encrypt_record(record_type, record_id, version, plaintext))
    }

    /// 解密普通记录。
    pub fn decrypt_record(
        &self,
        record_type: &str,
        record_id: &str,
        cipher: &RecordCipher,
    ) -> DomainResult<Vec<u8>> {
        self.with_key(|key, version| key.decrypt_record(record_type, record_id, version, cipher))
    }

    /// 加密秘密载荷并组装 `secret` 行。
    pub fn encrypt_secret(
        &self,
        secret_id: &SecretId,
        record_type: &str,
        plaintext: &[u8],
    ) -> DomainResult<SecretRecord> {
        let cipher = self.with_key(|key, version| {
            key.encrypt_secret(secret_id.as_str(), record_type, version, plaintext)
        })?;
        let now = now_ms();
        Ok(SecretRecord {
            id: secret_id.clone(),
            record_type: record_type.to_string(),
            ciphertext: cipher.ciphertext,
            nonce: cipher.nonce,
            aad: cipher.aad,
            crypto_suite: cipher.crypto_suite,
            key_version: cipher.key_version,
            created_at: now,
            updated_at: now,
        })
    }

    /// 解密 `secret` 行。
    pub fn decrypt_secret(&self, record: &SecretRecord) -> DomainResult<Vec<u8>> {
        if record.crypto_suite != CRYPTO_SUITE {
            return Err(error::corrupt("unsupported crypto suite"));
        }
        self.with_key(|key, version| {
            if record.key_version != version {
                return Err(error::decrypt_failed());
            }
            key.decrypt_secret(
                record.id.as_str(),
                &record.record_type,
                record.key_version,
                &record.nonce,
                &record.ciphertext,
                &record.aad,
            )
        })
    }

    pub fn with_key<T>(
        &self,
        f: impl FnOnce(&VaultKey, i64) -> DomainResult<T>,
    ) -> DomainResult<T> {
        let inner = self.read_inner();
        match (&inner.key, inner.state) {
            (Some(key), VaultState::Unlocked) => f(key, inner.key_version),
            _ => Err(error::locked()),
        }
    }

    fn read_inner(&self) -> RwLockReadGuard<'_, Inner> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_inner(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::{ErrorCode, SecretStore};

    const OLD_PASSWORD: &str = "correct horse battery";
    const NEW_PASSWORD: &str = "new correct horse battery";

    fn fast_kdf() -> KdfParams {
        KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        }
    }

    fn secret_id() -> SecretId {
        SecretId::new()
    }

    #[test]
    fn init_then_lock_then_unlock() {
        let vault = VaultManager::new();
        assert_eq!(vault.state(), VaultState::Uninitialized);
        let (parts, _key) = vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        assert_eq!(vault.state(), VaultState::Unlocked);
        assert!(vault.is_unlocked());

        vault.lock();
        assert_eq!(vault.state(), VaultState::Locked);
        assert!(!vault.is_unlocked());

        vault.unlock(&parts, OLD_PASSWORD).unwrap();
        assert_eq!(vault.state(), VaultState::Unlocked);
    }

    #[test]
    fn unlock_with_wrong_password_returns_decrypt_failed() {
        let vault = VaultManager::new();
        let (parts, _) = vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        vault.lock();
        let err = vault.unlock(&parts, "totally wrong password").unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
        assert_eq!(vault.state(), VaultState::Locked);
    }

    #[test]
    fn operations_while_locked_return_vault_locked() {
        let vault = VaultManager::new();
        let (parts, _) = vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let id = secret_id();
        let record = vault.encrypt_secret(&id, "credential", b"pw").unwrap();
        vault.lock();

        let err = vault.encrypt_secret(&id, "credential", b"pw").unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultLocked);
        let err = vault.decrypt_secret(&record).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultLocked);
        let err = vault
            .change_password(OLD_PASSWORD, NEW_PASSWORD)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultLocked);

        vault.unlock(&parts, OLD_PASSWORD).unwrap();
        assert_eq!(vault.decrypt_secret(&record).unwrap(), b"pw");
    }

    #[test]
    fn secret_roundtrip_and_tamper() {
        let vault = VaultManager::new();
        vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let id = secret_id();
        let mut record = vault.encrypt_secret(&id, "credential", b"hunter2").unwrap();
        assert_eq!(vault.decrypt_secret(&record).unwrap(), b"hunter2");

        record.ciphertext[0] ^= 0xff;
        let err = vault.decrypt_secret(&record).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn aad_transplant_between_records_fails() {
        let vault = VaultManager::new();
        vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let id_a = secret_id();
        let id_b = secret_id();
        let record_a = vault.encrypt_secret(&id_a, "credential", b"pw-a").unwrap();
        let mut record_b = vault.encrypt_secret(&id_b, "credential", b"pw-b").unwrap();
        record_b.ciphertext = record_a.ciphertext.clone();
        record_b.nonce = record_a.nonce.clone();
        record_b.aad = record_a.aad.clone();
        let err = vault.decrypt_secret(&record_b).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn change_password_keeps_vault_key_and_invalidates_old_password() {
        let vault = VaultManager::new();
        let (old_parts, key) = vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let id = secret_id();
        let old_record = vault
            .encrypt_secret(&id, "credential", b"secret data")
            .unwrap();

        let new_parts = vault.change_password(OLD_PASSWORD, NEW_PASSWORD).unwrap();
        assert_ne!(old_parts.salt, new_parts.salt);
        assert_ne!(old_parts.wrapped_vault_key, new_parts.wrapped_vault_key);
        assert_eq!(vault.key_version(), 1);

        // 旧密码对旧槽与新槽均失效。
        assert_eq!(
            KeySlot::from_parts(&old_parts)
                .unwrap()
                .unlock(OLD_PASSWORD)
                .unwrap()
                .as_bytes(),
            key.as_bytes()
        );
        let err = KeySlot::from_parts(&new_parts)
            .unwrap()
            .unlock(OLD_PASSWORD)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);

        // 新密码可用，且仍是同一个 VaultKey，可解旧密文。
        let fresh = VaultManager::new();
        fresh.unlock(&new_parts, NEW_PASSWORD).unwrap();
        assert_eq!(fresh.decrypt_secret(&old_record).unwrap(), b"secret data");
    }

    #[test]
    fn init_twice_is_rejected() {
        let vault = VaultManager::new();
        vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let err = vault.init(OLD_PASSWORD, fast_kdf()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
    }

    #[test]
    fn empty_password_is_rejected() {
        let vault = VaultManager::new();
        let err = vault.init("", fast_kdf()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
    }

    #[test]
    fn secret_store_trait_delegates() {
        let vault = VaultManager::new();
        vault.init(OLD_PASSWORD, fast_kdf()).unwrap();
        let id = secret_id();
        let record = SecretStore::encrypt_secret(&vault, &id, "credential", b"trait").unwrap();
        assert!(vault.is_unlocked());
        assert_eq!(
            SecretStore::decrypt_secret(&vault, &record).unwrap(),
            b"trait"
        );
    }
}
