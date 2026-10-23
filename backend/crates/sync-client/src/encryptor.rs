use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use openshell_vault::{RecordCipher, VaultKey};
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoSyncError {
    #[error("Serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Base64 decode failed: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("Checksum mismatch: expected {expected}, calculated {calculated}")]
    ChecksumMismatch {
        expected: String,
        calculated: String,
    },
    #[error("Vault error: {0}")]
    Vault(String),
}

/// 将实体记录加密为远程同步信封：(ciphertext_b64, checksum)
pub fn encrypt_entity_record<T: Serialize>(
    vault_key: &VaultKey,
    record_type: &str,
    record_id: &str,
    key_version: i64,
    data: &T,
) -> Result<(String, String), CryptoSyncError> {
    let plaintext = serde_json::to_vec(data)?;

    let record_cipher = vault_key
        .encrypt_record(record_type, record_id, key_version, &plaintext)
        .map_err(|e| CryptoSyncError::Vault(e.to_string()))?;

    // 线协议密文：序列化 RecordCipher
    let envelope_bytes = serde_json::to_vec(&record_cipher)?;
    let ciphertext_b64 = BASE64.encode(&envelope_bytes);

    let mut hasher = Sha256::new();
    hasher.update(ciphertext_b64.as_bytes());
    let checksum = hex_encode(hasher.finalize());

    Ok((ciphertext_b64, checksum))
}

/// 解密远程同步信封
pub fn decrypt_entity_record<T: DeserializeOwned>(
    vault_key: &VaultKey,
    record_type: &str,
    record_id: &str,
    key_version: i64,
    ciphertext_b64: &str,
    expected_checksum: &str,
) -> Result<T, CryptoSyncError> {
    // 校验 Checksum
    let mut hasher = Sha256::new();
    hasher.update(ciphertext_b64.as_bytes());
    let calculated = hex_encode(hasher.finalize());

    if !expected_checksum.is_empty() && calculated != expected_checksum {
        return Err(CryptoSyncError::ChecksumMismatch {
            expected: expected_checksum.to_string(),
            calculated,
        });
    }

    let envelope_bytes = BASE64.decode(ciphertext_b64)?;
    let record_cipher: RecordCipher = serde_json::from_slice(&envelope_bytes)?;

    let decrypted = vault_key
        .decrypt_record(record_type, record_id, key_version, &record_cipher)
        .map_err(|e| CryptoSyncError::Vault(e.to_string()))?;

    let entity: T = serde_json::from_slice(&decrypted)?;
    Ok(entity)
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    let mut s = String::with_capacity(bytes.as_ref().len() * 2);
    for b in bytes.as_ref() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct MockSessionData {
        name: String,
        host: String,
        port: u16,
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = VaultKey::random();
        let session = MockSessionData {
            name: "prod-server-01".into(),
            host: "10.0.0.1".into(),
            port: 22,
        };

        let (cipher_b64, checksum) = encrypt_entity_record(&key, "session", "rec_01", 1, &session)
            .expect("encryption should succeed");

        assert!(!cipher_b64.is_empty());
        assert_eq!(checksum.len(), 64);

        let decrypted: MockSessionData =
            decrypt_entity_record(&key, "session", "rec_01", 1, &cipher_b64, &checksum)
                .expect("decryption should succeed");

        assert_eq!(decrypted, session);
    }

    #[test]
    fn test_tampered_checksum_rejected() {
        let key = VaultKey::random();
        let session = MockSessionData {
            name: "bastion".into(),
            host: "1.2.3.4".into(),
            port: 2222,
        };

        let (cipher_b64, _checksum) =
            encrypt_entity_record(&key, "session", "rec_02", 1, &session).unwrap();

        let bad_checksum = "0000000000000000000000000000000000000000000000000000000000000000";
        let res: Result<MockSessionData, _> =
            decrypt_entity_record(&key, "session", "rec_02", 1, &cipher_b64, bad_checksum);

        assert!(matches!(res, Err(CryptoSyncError::ChecksumMismatch { .. })));
    }

    #[test]
    fn test_aad_transplant_rejected() {
        let key = VaultKey::random();
        let session = MockSessionData {
            name: "db-node".into(),
            host: "10.0.0.2".into(),
            port: 3306,
        };

        let (cipher_b64, checksum) =
            encrypt_entity_record(&key, "session", "rec_03", 1, &session).unwrap();

        // 1. Transplant to different record_id
        let res_id: Result<MockSessionData, _> =
            decrypt_entity_record(&key, "session", "rec_other", 1, &cipher_b64, &checksum);
        assert!(res_id.is_err());

        // 2. Transplant to different record_type
        let res_type: Result<MockSessionData, _> =
            decrypt_entity_record(&key, "credential", "rec_03", 1, &cipher_b64, &checksum);
        assert!(res_type.is_err());

        // 3. Mismatched key_version
        let res_ver: Result<MockSessionData, _> =
            decrypt_entity_record(&key, "session", "rec_03", 2, &cipher_b64, &checksum);
        assert!(res_ver.is_err());
    }
}
