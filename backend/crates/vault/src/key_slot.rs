//! 密钥槽：持久化 KEK 包裹的 VaultKey 与密码校验块。

use crate::error;
use crate::kdf::{self, KdfParams, SALT_LEN};
use crate::key_hierarchy::{VaultKey, VAULT_KEY_LEN};
use crate::record_cipher::{self, NONCE_LEN, TAG_LEN};
use openshell_core_domain::DomainResult;
use serde::{Deserialize, Serialize};

/// 密钥槽 AAD。
pub const SLOT_AAD: &[u8] = b"openshell-vault-key-v1";
/// key_check 中加密的固定明文。
pub const KEY_CHECK_PLAINTEXT: &[u8] = b"openshell-key-check-v1";
/// 主密码最小长度。
pub const MIN_PASSWORD_LEN: usize = 10;

/// 直接对应 `vault` 行字段的密钥槽数据（salt / wrapped / key_check 分开）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeySlotParts {
    pub salt: Vec<u8>,
    pub kdf: KdfParams,
    pub wrapped_vault_key: Vec<u8>,
    pub key_check: Vec<u8>,
}

/// 内存中的密钥槽（固定长度字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySlot {
    pub salt: [u8; SALT_LEN],
    pub kdf: KdfParams,
    pub wrapped_vault_key: Vec<u8>,
    pub key_check: Vec<u8>,
}

impl KeySlot {
    /// 用主密码创建新密钥槽，同时生成随机 VaultKey。
    pub fn create(password: &str, kdf: KdfParams) -> DomainResult<(Self, VaultKey)> {
        let vault_key = VaultKey::random();
        let slot = Self::create_with_key(&vault_key, password, kdf)?;
        Ok((slot, vault_key))
    }

    /// 用已有 VaultKey 创建新密钥槽（改主密码时使用，生成新 salt）。
    pub fn create_with_key(
        vault_key: &VaultKey,
        password: &str,
        kdf: KdfParams,
    ) -> DomainResult<Self> {
        validate_password(password)?;
        kdf.validate()?;
        let salt = kdf::random_salt();
        let kek = kdf::derive_kek(password, &salt, &kdf)?;
        let wrapped_vault_key = record_cipher::seal_bytes(&kek, SLOT_AAD, vault_key.as_bytes())?;
        let key_check =
            record_cipher::seal_bytes(vault_key.as_bytes(), SLOT_AAD, KEY_CHECK_PLAINTEXT)?;
        Ok(Self {
            salt,
            kdf,
            wrapped_vault_key,
            key_check,
        })
    }

    /// 用密码解包 VaultKey 并校验 key_check；失败统一返回 VAULT_DECRYPT_FAILED。
    pub fn unlock(&self, password: &str) -> DomainResult<VaultKey> {
        let kek = kdf::derive_kek(password, &self.salt, &self.kdf)
            .map_err(|_| error::decrypt_failed())?;
        let raw = record_cipher::open_bytes(&kek, SLOT_AAD, &self.wrapped_vault_key)
            .map_err(|_| error::decrypt_failed())?;
        let bytes: [u8; VAULT_KEY_LEN] = raw
            .as_slice()
            .try_into()
            .map_err(|_| error::decrypt_failed())?;
        let vault_key = VaultKey::from_bytes(bytes);

        let check = record_cipher::open_bytes(vault_key.as_bytes(), SLOT_AAD, &self.key_check)
            .map_err(|_| error::decrypt_failed())?;
        if check != KEY_CHECK_PLAINTEXT {
            return Err(error::decrypt_failed());
        }
        Ok(vault_key)
    }

    /// 拆分为可直接写入 `vault` 行的字段。
    pub fn to_parts(&self) -> KeySlotParts {
        KeySlotParts {
            salt: self.salt.to_vec(),
            kdf: self.kdf,
            wrapped_vault_key: self.wrapped_vault_key.clone(),
            key_check: self.key_check.clone(),
        }
    }

    /// 从 `vault` 行字段还原并校验结构长度。
    pub fn from_parts(parts: &KeySlotParts) -> DomainResult<Self> {
        if parts.salt.len() != SALT_LEN {
            return Err(error::corrupt("invalid kdf salt length"));
        }
        parts
            .kdf
            .validate()
            .map_err(|_| error::corrupt("invalid kdf parameters"))?;
        if parts.wrapped_vault_key.len() < NONCE_LEN + VAULT_KEY_LEN + TAG_LEN {
            return Err(error::corrupt("invalid wrapped vault key"));
        }
        if parts.key_check.len() < NONCE_LEN + KEY_CHECK_PLAINTEXT.len() + TAG_LEN {
            return Err(error::corrupt("invalid key check"));
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&parts.salt);
        Ok(Self {
            salt,
            kdf: parts.kdf,
            wrapped_vault_key: parts.wrapped_vault_key.clone(),
            key_check: parts.key_check.clone(),
        })
    }
}

/// 校验主密码最小长度（不静默截断）。
pub fn validate_password(password: &str) -> DomainResult<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(error::validation(format!(
            "master password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::ErrorCode;

    const PASSWORD: &str = "correct horse battery";

    fn fast_kdf() -> KdfParams {
        KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn unlock_with_correct_password() {
        let (slot, key) = KeySlot::create(PASSWORD, fast_kdf()).unwrap();
        let unlocked = slot.unlock(PASSWORD).unwrap();
        assert_eq!(unlocked.as_bytes(), key.as_bytes());
    }

    #[test]
    fn unlock_with_wrong_password_fails() {
        let (slot, _) = KeySlot::create(PASSWORD, fast_kdf()).unwrap();
        let err = slot.unlock("wrong horse battery").unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn tampered_key_check_fails() {
        let (slot, _) = KeySlot::create(PASSWORD, fast_kdf()).unwrap();
        let mut parts = slot.to_parts();
        parts.key_check[0] ^= 0x01;
        let parsed = KeySlot::from_parts(&parts).unwrap();
        let err = parsed.unlock(PASSWORD).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn tampered_wrapped_key_fails() {
        let (slot, _) = KeySlot::create(PASSWORD, fast_kdf()).unwrap();
        let mut parts = slot.to_parts();
        let last = parts.wrapped_vault_key.len() - 1;
        parts.wrapped_vault_key[last] ^= 0x80;
        let parsed = KeySlot::from_parts(&parts).unwrap();
        let err = parsed.unlock(PASSWORD).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn parts_do_not_contain_password_or_plain_key() {
        let (slot, key) = KeySlot::create(PASSWORD, fast_kdf()).unwrap();
        let parts = slot.to_parts();
        let json = serde_json::to_vec(&parts).unwrap();

        assert!(!contains(&json, PASSWORD.as_bytes()));
        assert!(!contains(&json, key.as_bytes()));
        assert!(!contains(&json, b"openshell-key-check-v1"));
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn password_length_is_validated() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("0123456789").is_ok());
    }

    #[test]
    fn malformed_parts_are_rejected() {
        let parts = KeySlotParts {
            salt: vec![0u8; 3],
            kdf: fast_kdf(),
            wrapped_vault_key: vec![0u8; 64],
            key_check: vec![0u8; 64],
        };
        let err = KeySlot::from_parts(&parts).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultCorrupt);
    }
}
