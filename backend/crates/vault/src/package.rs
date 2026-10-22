//! `.osvault` 导出包骨架：魔数 + 明文 JSON 头 + AEAD 载荷。
//!
//! M2 仅提供可测试的最小封装；M4 再对齐 ZIP/JSON 载荷与完整校验。

use crate::error;
use crate::kdf::{self, KdfParams, SALT_LEN};
use crate::key_slot::validate_password;
use crate::record_cipher::{self, NONCE_LEN};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use openshell_core_domain::DomainResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 包魔数。
pub const PACKAGE_MAGIC: &[u8] = b"OSVAULT1\n";
/// 包版本。
pub const PACKAGE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct PackageHeader {
    format: String,
    version: u32,
    kdf: String,
    mem_kib: u32,
    time: u32,
    parallelism: u32,
    salt_b64: String,
    nonce_b64: String,
    payload_sha256: String,
}

/// 封装明文载荷为 `.osvault` 字节流。使用独立 salt 与独立密码（B-05）。
pub fn seal_package(password: &str, plaintext: &[u8], params: KdfParams) -> DomainResult<Vec<u8>> {
    validate_password(password)?;
    params.validate()?;
    let salt = kdf::random_salt();
    let kek = kdf::derive_kek(password, &salt, &params)?;
    let nonce = record_cipher::random_nonce();
    let digest = Sha256::digest(plaintext);

    let header = PackageHeader {
        format: "osvault".to_string(),
        version: PACKAGE_VERSION,
        kdf: "argon2id".to_string(),
        mem_kib: params.mem_kib,
        time: params.time,
        parallelism: params.parallelism,
        salt_b64: STANDARD.encode(salt),
        nonce_b64: STANDARD.encode(nonce),
        payload_sha256: STANDARD.encode(digest),
    };
    let header_json = serde_json::to_vec(&header)
        .map_err(|_| error::internal("package header serialization failed"))?;
    let ciphertext = record_cipher::seal_with_nonce(&kek, &nonce, &header_json, plaintext)?;

    let header_len = u32::try_from(header_json.len())
        .map_err(|_| error::validation("package header is too large"))?;
    let mut out =
        Vec::with_capacity(PACKAGE_MAGIC.len() + 4 + header_json.len() + ciphertext.len());
    out.extend_from_slice(PACKAGE_MAGIC);
    out.extend_from_slice(&header_len.to_be_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// 打开 `.osvault` 字节流；错误密码或篡改统一返回 VAULT_DECRYPT_FAILED。
pub fn open_package(password: &str, package: &[u8]) -> DomainResult<Vec<u8>> {
    if !package.starts_with(PACKAGE_MAGIC) {
        return Err(error::corrupt("invalid package magic"));
    }
    let rest = &package[PACKAGE_MAGIC.len()..];
    if rest.len() < 4 {
        return Err(error::corrupt("truncated package header"));
    }
    let header_len = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
    let body = &rest[4..];
    if body.len() < header_len {
        return Err(error::corrupt("truncated package header"));
    }
    let (header_json, ciphertext) = body.split_at(header_len);
    let header: PackageHeader = serde_json::from_slice(header_json)
        .map_err(|_| error::corrupt("invalid package header"))?;
    if header.format != "osvault" || header.version != PACKAGE_VERSION || header.kdf != "argon2id" {
        return Err(error::corrupt("unsupported package format"));
    }

    let params = KdfParams {
        mem_kib: header.mem_kib,
        time: header.time,
        parallelism: header.parallelism,
    };
    params
        .validate()
        .map_err(|_| error::corrupt("invalid package kdf parameters"))?;
    let salt = STANDARD
        .decode(&header.salt_b64)
        .map_err(|_| error::corrupt("invalid package salt"))?;
    let salt: [u8; SALT_LEN] = salt
        .try_into()
        .map_err(|_| error::corrupt("invalid package salt"))?;
    let nonce = STANDARD
        .decode(&header.nonce_b64)
        .map_err(|_| error::corrupt("invalid package nonce"))?;
    let nonce: [u8; NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| error::corrupt("invalid package nonce"))?;

    let kek = kdf::derive_kek(password, &salt, &params).map_err(|_| error::decrypt_failed())?;
    let plaintext = record_cipher::open_parts(&kek, &nonce, ciphertext, header_json)
        .map_err(|_| error::decrypt_failed())?;

    let digest = Sha256::digest(&plaintext);
    let expected = STANDARD
        .decode(&header.payload_sha256)
        .map_err(|_| error::decrypt_failed())?;
    if digest.as_slice() != expected.as_slice() {
        return Err(error::decrypt_failed());
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::ErrorCode;

    const PASSWORD: &str = "package password 42";

    fn fast_kdf() -> KdfParams {
        KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn package_roundtrip() {
        let payload = br#"{"sessions":[]}"#;
        let bytes = seal_package(PASSWORD, payload, fast_kdf()).unwrap();
        assert!(bytes.starts_with(PACKAGE_MAGIC));
        assert_eq!(open_package(PASSWORD, &bytes).unwrap(), payload);
    }

    #[test]
    fn wrong_password_fails() {
        let bytes = seal_package(PASSWORD, b"payload", fast_kdf()).unwrap();
        let err = open_package("wrong package password", &bytes).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn tampered_payload_fails() {
        let mut bytes = seal_package(PASSWORD, b"payload", fast_kdf()).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let err = open_package(PASSWORD, &bytes).unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultDecryptFailed);
    }

    #[test]
    fn bad_magic_is_corrupt() {
        let err = open_package(PASSWORD, b"NOT-A-PACKAGE").unwrap_err();
        assert_eq!(err.code, ErrorCode::VaultCorrupt);
    }
}
