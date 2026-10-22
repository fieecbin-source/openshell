//! VaultKey（32 字节根密钥）与按记录派生的子密钥。

use crate::error;
use crate::record_cipher::{self, RecordCipher, CRYPTO_SUITE};
use hkdf::Hkdf;
use openshell_core_domain::DomainResult;
use sha2::Sha256;
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

/// VaultKey 长度（字节）。
pub const VAULT_KEY_LEN: usize = 32;
const RECORD_INFO: &[u8] = b"openshell/v1/record";

/// 解锁期驻留内存的 VaultKey；Drop 时清零。
pub struct VaultKey([u8; VAULT_KEY_LEN]);

impl VaultKey {
    /// 生成随机 VaultKey。
    pub fn random() -> Self {
        use rand::RngCore;
        let mut bytes = [0u8; VAULT_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// 由原始字节构造（仅供密钥槽解包使用）。
    pub(crate) fn from_bytes(bytes: [u8; VAULT_KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// 只读访问原始字节。
    pub(crate) fn as_bytes(&self) -> &[u8; VAULT_KEY_LEN] {
        &self.0
    }

    /// HKDF-SHA256 派生记录密钥；`salt_ctx` 为记录 ID（秘密为 `secret:<id>`）。
    fn derive_record_key(&self, salt_ctx: &str) -> DomainResult<Zeroizing<[u8; VAULT_KEY_LEN]>> {
        let hkdf = Hkdf::<Sha256>::new(Some(salt_ctx.as_bytes()), &self.0);
        let mut okm = Zeroizing::new([0u8; VAULT_KEY_LEN]);
        hkdf.expand(RECORD_INFO, &mut *okm)
            .map_err(|_| error::internal("hkdf expansion failed"))?;
        Ok(okm)
    }

    /// 加密普通记录；AAD 绑定 `record_type:record_id:key_version`。
    pub fn encrypt_record(
        &self,
        record_type: &str,
        record_id: &str,
        key_version: i64,
        plaintext: &[u8],
    ) -> DomainResult<RecordCipher> {
        let key = self.derive_record_key(record_id)?;
        record_cipher::seal_record(&key, record_type, record_id, key_version, plaintext)
    }

    /// 解密普通记录。
    pub fn decrypt_record(
        &self,
        record_type: &str,
        record_id: &str,
        key_version: i64,
        cipher: &RecordCipher,
    ) -> DomainResult<Vec<u8>> {
        if cipher.crypto_suite != CRYPTO_SUITE {
            return Err(error::corrupt("unsupported crypto suite"));
        }
        if cipher.key_version != key_version {
            return Err(error::decrypt_failed());
        }
        let key = self.derive_record_key(record_id)?;
        record_cipher::open_record(
            &key,
            record_type,
            record_id,
            key_version,
            &cipher.nonce,
            &cipher.ciphertext,
            &cipher.aad,
        )
    }

    /// 加密秘密载荷；记录密钥 salt 为 `secret:<secret_id>`。
    pub fn encrypt_secret(
        &self,
        secret_id: &str,
        record_type: &str,
        key_version: i64,
        plaintext: &[u8],
    ) -> DomainResult<RecordCipher> {
        let key = self.derive_record_key(&format!("secret:{secret_id}"))?;
        record_cipher::seal_record(&key, record_type, secret_id, key_version, plaintext)
    }

    /// 解密秘密载荷。
    pub fn decrypt_secret(
        &self,
        secret_id: &str,
        record_type: &str,
        key_version: i64,
        nonce: &[u8],
        ciphertext: &[u8],
        aad: &[u8],
    ) -> DomainResult<Vec<u8>> {
        let key = self.derive_record_key(&format!("secret:{secret_id}"))?;
        record_cipher::open_record(
            &key,
            record_type,
            secret_id,
            key_version,
            nonce,
            ciphertext,
            aad,
        )
    }
}

impl Clone for VaultKey {
    fn clone(&self) -> Self {
        Self(self.0)
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VaultKey([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::ErrorCode;

    const RECORD_TYPE: &str = "session";
    const RECORD_ID: &str = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

    fn key() -> VaultKey {
        VaultKey::from_bytes([42u8; VAULT_KEY_LEN])
    }

    #[test]
    fn same_plaintext_gets_unique_nonce_and_ciphertext() {
        let key = key();
        let a = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"payload")
            .unwrap();
        let b = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"payload")
            .unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
        assert_eq!(a.aad, b.aad);
    }

    #[test]
    fn roundtrip_record() {
        let key = key();
        let cipher = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"hello vault")
            .unwrap();
        let plain = key
            .decrypt_record(RECORD_TYPE, RECORD_ID, 1, &cipher)
            .unwrap();
        assert_eq!(plain, b"hello vault");
    }

    #[test]
    fn ciphertext_tamper_fails() {
        let key = key();
        let mut cipher = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"hello vault")
            .unwrap();
        cipher.ciphertext[0] ^= 0x01;
        assert!(key
            .decrypt_record(RECORD_TYPE, RECORD_ID, 1, &cipher)
            .is_err());
    }

    #[test]
    fn aad_binding_blocks_cross_record_replay() {
        let key = key();
        let cipher = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"session A")
            .unwrap();
        let err = key
            .decrypt_record(RECORD_TYPE, "01HZZZZZZZZZZZZZZZZZZZZZZY", 1, &cipher)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);

        let err = key
            .decrypt_record("credential", RECORD_ID, 1, &cipher)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn key_version_mismatch_fails() {
        let key = key();
        let cipher = key
            .encrypt_record(RECORD_TYPE, RECORD_ID, 1, b"data")
            .unwrap();
        let err = key
            .decrypt_record(RECORD_TYPE, RECORD_ID, 2, &cipher)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn secret_and_record_domains_are_separated() {
        let key = key();
        let secret = key.encrypt_secret(RECORD_ID, "secret", 1, b"pw").unwrap();
        // 相同 ID 但按普通记录派生应无法解密。
        assert!(key
            .decrypt_record(RECORD_TYPE, RECORD_ID, 1, &secret)
            .is_err());
    }
}
