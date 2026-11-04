//! 安装包与发布清单校验。
//!
//! 信任链是**两段式、fail-closed**：
//!
//! 1. 用内置公钥验证 `update-meta.json` 的 Ed25519 签名（先验签）；
//! 2. 再用**已验签清单**里的 sha256 校验安装包（后校验哈希）。
//!
//! 任一段失败都拒绝下载/安装，不存在「跳过签名」的降级路径。
//!
//! 仓库只保存公钥（`keys/*.pub`），构建时由 `build.rs` 编进二进制；
//! 私钥离线保存，签名由 `scripts/updater-sign.mjs` 在发布机上完成。
//! 轮换/吊销流程见 `docs/RELEASING.md`。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::meta::{parse_update_meta, ReleaseMetaFile};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tracing::warn;

/// 被签名清单的文件名。
pub const MANIFEST_FILE_NAME: &str = "update-meta.json";
/// 分离签名文件名。
pub const SIGNATURE_FILE_NAME: &str = "update-meta.json.sig";
/// 签名文件格式版本。
pub const SIGNATURE_FORMAT_VERSION: u32 = 1;
/// Ed25519 签名的固定长度。
const ED25519_SIGNATURE_LEN: usize = 64;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_keys.rs"));
}

/// 公钥在信任列表中的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    /// 当前密钥：接受签名。
    Active,
    /// 下一把密钥：提前内置，接受签名（但不作为清单声明的 key_id）。
    Next,
    /// 已吊销：即使签名有效也拒绝。
    Revoked,
}

impl KeyStatus {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "active" | "current" => Some(Self::Active),
            "next" => Some(Self::Next),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }

    fn is_trusted(self) -> bool {
        matches!(self, Self::Active | Self::Next)
    }
}

/// 一把内置公钥。
#[derive(Debug, Clone)]
pub struct TrustedKey {
    pub key_id: String,
    pub status: KeyStatus,
    pub key: VerifyingKey,
}

/// 验签通过后的清单。
#[derive(Debug, Clone)]
pub struct VerifiedManifest {
    /// 清单声明的签名密钥 id（`update-meta.json` 的 `key_id` 字段）。
    pub key_id: String,
    pub meta: ReleaseMetaFile,
    /// 参与验签的原始字节（原样保留，便于复核与日志）。
    pub raw_manifest: String,
    pub raw_signature: String,
}

impl VerifiedManifest {
    /// 已签名清单里声明的资产哈希（唯一可信的哈希来源）。
    pub fn sha256_for(&self, asset_name: &str) -> Option<String> {
        self.meta.sha256_map().get(asset_name).cloned()
    }
}

/// 签名校验器：持有一组内置公钥。
#[derive(Debug, Clone)]
pub struct SignatureVerifier {
    keys: Vec<TrustedKey>,
}

impl Default for SignatureVerifier {
    fn default() -> Self {
        Self::builtin()
    }
}

impl SignatureVerifier {
    /// 使用编译期内置公钥。没有任何公钥时**不降级**，验签一律失败。
    pub fn builtin() -> Self {
        Self {
            keys: embedded::EMBEDDED_KEYS
                .iter()
                .filter_map(|(key_id, status, public_key)| {
                    let status = KeyStatus::parse(status).or_else(|| {
                        warn!(
                            key_id,
                            "unknown update signing key status; treating as revoked"
                        );
                        Some(KeyStatus::Revoked)
                    })?;
                    match decode_public_key(public_key) {
                        Ok(key) => Some(TrustedKey {
                            key_id: (*key_id).to_string(),
                            status,
                            key,
                        }),
                        Err(err) => {
                            warn!(key_id, error = %err, "invalid embedded update signing key");
                            None
                        }
                    }
                })
                .collect(),
        }
    }

    /// 测试或运维诊断用的显式信任列表。
    pub fn with_keys(keys: Vec<TrustedKey>) -> Self {
        Self { keys }
    }

    /// 是否至少配置了一把公钥（不表示签名一定正确）。
    pub fn is_enabled(&self) -> bool {
        !self.keys.is_empty()
    }

    /// 当前信任的 key_id 与状态（用于诊断，不泄露密钥材料）。
    pub fn trusted_key_ids(&self) -> Vec<(&str, KeyStatus)> {
        self.keys
            .iter()
            .map(|key| (key.key_id.as_str(), key.status))
            .collect()
    }

    /// 验证清单签名；只有验签通过才返回清单内容。
    ///
    /// 顺序固定：解析清单 → 检查 `key_id` → 解析签名文件 → 逐条验签。
    /// 任一环节失败都返回 [`UpdaterErrorKind::Signature`] / [`UpdaterErrorKind::SignatureMissing`]。
    pub fn verify_manifest(
        &self,
        manifest: &str,
        signature_file: &str,
    ) -> Result<VerifiedManifest, UpdaterError> {
        if manifest.trim().is_empty() {
            return Err(missing_signature_error(
                "release manifest is missing; automatic installation is disabled",
                "missing_manifest",
            ));
        }
        if signature_file.trim().is_empty() {
            return Err(missing_signature_error(
                "release manifest has no signature; automatic installation is disabled",
                "missing_signature",
            ));
        }
        let meta = parse_update_meta(manifest.as_bytes()).map_err(|err| {
            signature_error(
                "release manifest is not valid json; refusing to continue",
                "manifest_invalid",
                None,
                err.message,
            )
        })?;
        let Some(manifest_key_id) = meta
            .key_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err(signature_error(
                "release manifest does not declare a signing key id",
                "missing_key_id",
                None,
                String::new(),
            ));
        };

        let parsed: SignatureFile = serde_json::from_str(signature_file).map_err(|err| {
            signature_error(
                "release signature file is not valid json",
                "signature_malformed",
                Some(manifest_key_id),
                err.to_string(),
            )
        })?;
        if parsed.version != SIGNATURE_FORMAT_VERSION {
            return Err(signature_error(
                "release signature file uses an unsupported format version",
                "signature_version",
                Some(manifest_key_id),
                String::new(),
            ));
        }
        if parsed.signatures.is_empty() {
            return Err(UpdaterError::new(
                UpdaterErrorKind::SignatureMissing,
                "release manifest has no signature; automatic installation is disabled",
            )
            .with_details(serde_json::json!({
                "reason": "missing_signature",
                "key_id": manifest_key_id,
            })));
        }
        if self.keys.is_empty() {
            return Err(signature_error(
                "this build has no trusted update signing key; automatic installation is disabled",
                "no_trusted_keys",
                Some(manifest_key_id),
                String::new(),
            ));
        }
        if !parsed
            .signatures
            .iter()
            .any(|entry| entry.key_id.trim() == manifest_key_id)
        {
            return Err(signature_error(
                "release signature does not cover the key id declared by the manifest",
                "key_id_mismatch",
                Some(manifest_key_id),
                String::new(),
            ));
        }

        let mut saw_unknown = false;
        let mut saw_revoked = false;
        for entry in &parsed.signatures {
            if !entry.alg.eq_ignore_ascii_case("ed25519") {
                continue;
            }
            let key_id = entry.key_id.trim();
            let Some(trusted) = self.keys.iter().find(|key| key.key_id == key_id) else {
                saw_unknown = true;
                continue;
            };
            if !trusted.status.is_trusted() {
                saw_revoked = true;
                continue;
            }
            let Some(signature) = decode_signature(&entry.signature) else {
                continue;
            };
            if trusted
                .key
                .verify_strict(manifest.as_bytes(), &signature)
                .is_ok()
            {
                return Ok(VerifiedManifest {
                    key_id: manifest_key_id.to_string(),
                    meta,
                    raw_manifest: manifest.to_string(),
                    raw_signature: signature_file.to_string(),
                });
            }
        }

        let (reason, message) = if saw_revoked {
            (
                "revoked_key",
                "release was signed with a revoked update key; automatic installation is disabled",
            )
        } else if saw_unknown {
            (
                "unknown_key",
                "release was signed with an untrusted update key; automatic installation is disabled",
            )
        } else {
            (
                "invalid_signature",
                "release manifest signature does not match its content; automatic installation is disabled",
            )
        };
        Err(signature_error(
            message,
            reason,
            Some(manifest_key_id),
            String::new(),
        ))
    }
}

/// sha256 校验器。
pub struct Sha256Verifier;

impl Verifier for Sha256Verifier {
    fn name(&self) -> &'static str {
        "sha256"
    }

    fn is_enabled(&self) -> bool {
        true
    }

    fn verify(&self, path: &Path, expected_sha256: Option<&str>) -> Result<(), UpdaterError> {
        let Some(expected) = expected_sha256.and_then(normalize_hex) else {
            return Err(UpdaterError::new(
                UpdaterErrorKind::ChecksumMismatch,
                "release does not provide a sha256 checksum for this asset",
            ));
        };
        let actual = sha256_file(path)?;
        if constant_time_eq(expected.as_bytes(), actual.as_bytes()) {
            Ok(())
        } else {
            Err(UpdaterError::new(
                UpdaterErrorKind::ChecksumMismatch,
                "downloaded file does not match the published sha256",
            )
            .with_details(serde_json::json!({
                "expected": expected,
                "actual": actual,
            }))
            .with_retryable(true))
        }
    }
}

/// 校验器：文件级校验的抽象（目前只有 sha256）。
pub trait Verifier: Send + Sync {
    /// 校验器名称（写日志用）。
    fn name(&self) -> &'static str;

    /// 是否已启用。
    fn is_enabled(&self) -> bool;

    /// 校验文件；失败必须返回 `ChecksumMismatch` 或 `UpdateSignature`。
    fn verify(&self, path: &Path, expected_sha256: Option<&str>) -> Result<(), UpdaterError>;
}

/// 计算文件 sha256（流式，内存占用固定 64 KiB）。
pub fn sha256_file(path: &Path) -> Result<String, UpdaterError> {
    let mut file = File::open(path)?;
    sha256_reader(&mut file)
}

/// 计算已打开文件从当前游标开始的 sha256（下载完成后可复用同一句柄）。
pub fn sha256_reader(reader: &mut impl Read) -> Result<String, UpdaterError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 计算文件前 `limit` 字节的 sha256（日志里只展示短哈希时使用）。
pub fn sha256_prefix(path: &Path, limit: u64) -> Result<String, UpdaterError> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 8192];
    let mut remaining = limit;
    while remaining > 0 {
        let want = (buffer.len() as u64).min(remaining) as usize;
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Deserialize)]
struct SignatureFile {
    version: u32,
    #[serde(default)]
    signatures: Vec<SignatureEntry>,
}

#[derive(Debug, Deserialize)]
struct SignatureEntry {
    key_id: String,
    #[serde(default = "default_algorithm")]
    alg: String,
    signature: String,
}

fn default_algorithm() -> String {
    "ed25519".to_string()
}

fn decode_public_key(raw: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_base64(raw)?;
    let array: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "public key must decode to 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&array).map_err(|err| err.to_string())
}

fn decode_signature(raw: &str) -> Option<Signature> {
    let bytes = decode_base64(raw).ok()?;
    let array: [u8; ED25519_SIGNATURE_LEN] = bytes.as_slice().try_into().ok()?;
    Some(Signature::from_bytes(&array))
}

fn decode_base64(raw: &str) -> Result<Vec<u8>, String> {
    let raw = raw.trim().trim_end_matches('=');
    URL_SAFE_NO_PAD
        .decode(raw)
        .or_else(|_| STANDARD.decode(raw))
        .map_err(|err| format!("base64 decode failed: {err}"))
}

fn signature_error(
    message: &str,
    reason: &str,
    key_id: Option<&str>,
    upstream: String,
) -> UpdaterError {
    let mut details = serde_json::json!({ "reason": reason });
    if let Some(key_id) = key_id {
        details["key_id"] = serde_json::Value::String(key_id.to_string());
    }
    if !upstream.is_empty() {
        details["upstream"] = serde_json::Value::String(upstream);
    }
    UpdaterError::new(UpdaterErrorKind::Signature, message)
        .with_retryable(false)
        .with_details(details)
}

fn missing_signature_error(message: &str, reason: &str) -> UpdaterError {
    UpdaterError::new(UpdaterErrorKind::SignatureMissing, message)
        .with_retryable(false)
        .with_details(serde_json::json!({ "reason": reason }))
}

fn normalize_hex(raw: &str) -> Option<String> {
    let cleaned = raw.trim().to_ascii_lowercase();
    if cleaned.len() == 64 && cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(cleaned)
    } else {
        None
    }
}

/// 恒时比较，避免（理论上）通过耗时侧信道推断哈希。
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const HASH_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn key_id() -> &'static str {
        "openshell-updater-test"
    }

    fn trusted_active(seed: u8) -> TrustedKey {
        TrustedKey {
            key_id: key_id().to_string(),
            status: KeyStatus::Active,
            key: signing_key(seed).verifying_key(),
        }
    }

    fn manifest(key_id: &str) -> String {
        format!(
            r#"{{"key_id":"{key_id}","mandatory":false,"assets":[{{"name":"OpenShell.exe","sha256":"{HASH_A}"}}]}}"#
        )
    }

    fn signature_file(entries: &[(&str, u8, &str)]) -> String {
        let signatures: Vec<serde_json::Value> = entries
            .iter()
            .map(|(entry_key_id, seed, manifest_text)| {
                let signature = signing_key(*seed).sign(manifest_text.as_bytes());
                serde_json::json!({
                    "key_id": entry_key_id,
                    "alg": "ed25519",
                    "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
                })
            })
            .collect();
        serde_json::json!({
            "version": SIGNATURE_FORMAT_VERSION,
            "signatures": signatures,
        })
        .to_string()
    }

    fn verifier(keys: Vec<TrustedKey>) -> SignatureVerifier {
        SignatureVerifier::with_keys(keys)
    }

    #[test]
    fn accepts_valid_signature() {
        let manifest = manifest(key_id());
        let sig = signature_file(&[(key_id(), 7, &manifest)]);
        let verified = verifier(vec![trusted_active(7)])
            .verify_manifest(&manifest, &sig)
            .expect("valid signature");
        assert_eq!(verified.key_id, key_id());
        assert_eq!(
            verified.sha256_for("OpenShell.exe").as_deref(),
            Some(HASH_A)
        );
    }

    #[test]
    fn rejects_tampered_manifest() {
        let manifest = manifest(key_id());
        let sig = signature_file(&[(key_id(), 7, &manifest)]);
        let tampered = manifest.replace(HASH_A, &"0".repeat(64));
        let err = verifier(vec![trusted_active(7)])
            .verify_manifest(&tampered, &sig)
            .expect_err("tampered manifest");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);
        assert!(!err.retryable);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("invalid_signature")
        );
    }

    #[test]
    fn rejects_signature_from_wrong_key() {
        let manifest = manifest(key_id());
        let sig = signature_file(&[(key_id(), 9, &manifest)]);
        let err = verifier(vec![trusted_active(7)])
            .verify_manifest(&manifest, &sig)
            .expect_err("wrong key");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("invalid_signature")
        );
    }

    #[test]
    fn rejects_unknown_key() {
        let manifest = manifest("unknown-key");
        let sig = signature_file(&[("unknown-key", 9, &manifest)]);
        let err = verifier(vec![trusted_active(7)])
            .verify_manifest(&manifest, &sig)
            .expect_err("unknown key");
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("unknown_key")
        );
    }

    #[test]
    fn rejects_missing_signature() {
        let manifest = manifest(key_id());
        let empty = serde_json::json!({
            "version": SIGNATURE_FORMAT_VERSION,
            "signatures": [],
        })
        .to_string();
        let err = verifier(vec![trusted_active(7)])
            .verify_manifest(&manifest, &empty)
            .expect_err("missing signature");
        assert_eq!(err.kind, UpdaterErrorKind::SignatureMissing);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("missing_signature")
        );
    }

    #[test]
    fn rejects_revoked_key_even_with_valid_signature() {
        let manifest = manifest(key_id());
        let sig = signature_file(&[(key_id(), 7, &manifest)]);
        let mut revoked = trusted_active(7);
        revoked.status = KeyStatus::Revoked;
        let err = verifier(vec![revoked])
            .verify_manifest(&manifest, &sig)
            .expect_err("revoked");
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("revoked_key")
        );
    }

    #[test]
    fn accepts_next_key_and_dual_signature_during_rotation() {
        let manifest = manifest("openshell-updater-next");
        let sig = signature_file(&[
            ("openshell-updater-next", 8, &manifest),
            (key_id(), 7, &manifest),
        ]);
        let mut old = trusted_active(7);
        old.status = KeyStatus::Revoked;
        let next = TrustedKey {
            key_id: "openshell-updater-next".to_string(),
            status: KeyStatus::Next,
            key: signing_key(8).verifying_key(),
        };
        // 旧 key 已吊销，但新 key 的签名仍然有效：轮换期间不会把老客户端锁死。
        verifier(vec![old, next])
            .verify_manifest(&manifest, &sig)
            .expect("next key signature");
    }

    #[test]
    fn rejects_manifest_without_key_id() {
        let manifest = format!(r#"{{"assets":[{{"name":"OpenShell.exe","sha256":"{HASH_A}"}}]}}"#);
        let sig = signature_file(&[(key_id(), 7, &manifest)]);
        let err = verifier(vec![trusted_active(7)])
            .verify_manifest(&manifest, &sig)
            .expect_err("no key id");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("missing_key_id")
        );
    }

    #[test]
    fn builtin_without_keys_fails_closed() {
        // 仓库尚未加入生产公钥时必须拒绝，而不是跳过验签。
        let manifest = manifest(key_id());
        let sig = signature_file(&[(key_id(), 7, &manifest)]);
        if SignatureVerifier::builtin().is_enabled() {
            // 已配置生产公钥的环境无法断言具体错误，但仍必须拒绝测试签名。
            assert!(SignatureVerifier::builtin()
                .verify_manifest(&manifest, &sig)
                .is_err());
        } else {
            let err = SignatureVerifier::builtin()
                .verify_manifest(&manifest, &sig)
                .expect_err("no trusted keys");
            assert_eq!(
                err.details.as_ref().and_then(|d| d["reason"].as_str()),
                Some("no_trusted_keys")
            );
        }
    }

    fn write_temp(content: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("payload.bin");
        std::fs::write(&path, content).expect("write");
        (dir, path)
    }

    #[test]
    fn computes_known_sha256() {
        let (_dir, path) = write_temp(b"abc");
        assert_eq!(
            sha256_file(&path).expect("hash"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verifies_matching_hash() {
        let (_dir, path) = write_temp(b"abc");
        Sha256Verifier
            .verify(
                &path,
                Some("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"),
            )
            .expect("should match");
    }

    #[test]
    fn rejects_mismatched_hash() {
        let (_dir, path) = write_temp(b"abc");
        let err = Sha256Verifier
            .verify(&path, Some(&"0".repeat(64)))
            .expect_err("mismatch");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
        assert!(err.retryable);
    }

    #[test]
    fn rejects_missing_or_invalid_hash() {
        let (_dir, path) = write_temp(b"abc");
        assert!(Sha256Verifier.verify(&path, None).is_err());
        assert!(Sha256Verifier.verify(&path, Some("abc")).is_err());
    }

    #[test]
    fn prefix_hash_only_reads_head() {
        let (_dir, path) = write_temp(b"abc");
        assert_eq!(
            sha256_prefix(&path, 3).expect("prefix"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
