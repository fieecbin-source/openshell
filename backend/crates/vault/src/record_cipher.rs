//! 记录级 AEAD 封装：所有 XChaCha20-Poly1305 调用集中在此，禁止业务代码直接使用。

use crate::error;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use openshell_core_domain::DomainResult;
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// 当前密文套件标识。
pub const CRYPTO_SUITE: &str = "xchacha20poly1305";
/// XChaCha20-Poly1305 nonce 长度。
pub const NONCE_LEN: usize = 24;
/// Poly1305 认证标签长度。
pub const TAG_LEN: usize = 16;

/// 记录密文信封（对应 `secret` 表字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordCipher {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub aad: Vec<u8>,
    pub crypto_suite: String,
    pub key_version: i64,
}

/// 记录 AAD：绑定类型、ID 与密钥版本，防止跨记录/跨版本搬运。
pub fn record_aad(record_type: &str, record_id: &str, key_version: i64) -> Vec<u8> {
    format!("{record_type}:{record_id}:{key_version}").into_bytes()
}

/// 生成 24 字节随机 nonce。
pub(crate) fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    nonce
}

/// 加密并返回 `nonce ‖ ciphertext ‖ tag`，用于密钥槽等紧凑信封。
pub(crate) fn seal_bytes(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> DomainResult<Vec<u8>> {
    let nonce = random_nonce();
    let mut envelope = Vec::with_capacity(NONCE_LEN + plaintext.len() + TAG_LEN);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&seal_with_nonce(key, &nonce, aad, plaintext)?);
    Ok(envelope)
}

/// 解密 `nonce ‖ ciphertext ‖ tag` 信封。
pub(crate) fn open_bytes(key: &[u8; 32], aad: &[u8], envelope: &[u8]) -> DomainResult<Vec<u8>> {
    if envelope.len() < NONCE_LEN + TAG_LEN {
        return Err(error::decrypt_failed());
    }
    let (nonce, ciphertext) = envelope.split_at(NONCE_LEN);
    open_parts(key, nonce, ciphertext, aad)
}

/// 使用指定 nonce 加密，返回 `ciphertext ‖ tag`。
pub(crate) fn seal_with_nonce(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> DomainResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| error::internal("aead encryption failed"))
}

/// 使用独立 nonce 与密文解密。
pub(crate) fn open_parts(
    key: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> DomainResult<Vec<u8>> {
    if nonce.len() != NONCE_LEN || ciphertext.len() < TAG_LEN {
        return Err(error::decrypt_failed());
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| error::decrypt_failed())
}

/// 加密一条记录，生成新 nonce 并绑定记录 AAD。
pub(crate) fn seal_record(
    key: &[u8; 32],
    record_type: &str,
    record_id: &str,
    key_version: i64,
    plaintext: &[u8],
) -> DomainResult<RecordCipher> {
    let nonce = random_nonce();
    let aad = record_aad(record_type, record_id, key_version);
    let ciphertext = seal_with_nonce(key, &nonce, &aad, plaintext)?;
    Ok(RecordCipher {
        ciphertext,
        nonce: nonce.to_vec(),
        aad,
        crypto_suite: CRYPTO_SUITE.to_string(),
        key_version,
    })
}

/// 解密一条记录；AAD/套件/版本不匹配一律视为解密失败。
pub(crate) fn open_record(
    key: &[u8; 32],
    record_type: &str,
    record_id: &str,
    key_version: i64,
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> DomainResult<Vec<u8>> {
    let expected = record_aad(record_type, record_id, key_version);
    if aad != expected.as_slice() {
        return Err(error::decrypt_failed());
    }
    open_parts(key, nonce, ciphertext, &expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aad_is_bound_to_type_id_and_version() {
        assert_eq!(record_aad("secret", "01ABC", 1), b"secret:01ABC:1");
        assert_ne!(
            record_aad("secret", "01ABC", 1),
            record_aad("secret", "01ABD", 1)
        );
        assert_ne!(
            record_aad("secret", "01ABC", 1),
            record_aad("credential", "01ABC", 1)
        );
        assert_ne!(
            record_aad("secret", "01ABC", 1),
            record_aad("secret", "01ABC", 2)
        );
    }

    #[test]
    fn short_envelope_is_rejected() {
        assert!(open_bytes(&[0u8; 32], b"aad", &[0u8; NONCE_LEN]).is_err());
    }
}
