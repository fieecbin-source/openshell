//! 安装前的前置检查（纯函数 + 文件读取，不依赖 Tauri）。
//!
//! 安装是唯一会改动用户机器上可执行文件的操作，所以进入安装流程前必须再确认：
//! 1. 安装包还在磁盘上（可能被用户删掉、被清理工具扫走）；
//! 2. 清单签名有效（Ed25519，先验签）；
//! 3. 签名清单里的 sha256 合法且文件内容一致（后校验哈希）。
//!
//! 任一环节失败都拒绝安装，不存在跳过验签的分支。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::UpdateAsset;
use crate::verify::{Sha256Verifier, SignatureVerifier, Verifier};
use std::path::Path;

/// 安装包 sha256 的合法形态：64 个 ASCII 十六进制字符。
pub const SHA256_HEX_LEN: usize = 64;

/// 校验清单里的 sha256 是否可用；返回小写归一化后的值。
pub fn normalize_sha256(value: Option<&str>) -> Result<String, UpdaterError> {
    let raw = value.unwrap_or("").trim();
    if raw.len() != SHA256_HEX_LEN || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UpdaterError::new(
            UpdaterErrorKind::ChecksumMissing,
            "release metadata does not provide a valid sha256 for this installer; download it manually",
        )
        .with_retryable(false)
        .with_details(serde_json::json!({
            "expected_len": SHA256_HEX_LEN,
            "actual_len": raw.len(),
        })));
    }
    Ok(raw.to_ascii_lowercase())
}

/// 安装前的完整检查（生产入口）：路径存在 → 清单验签 → sha256 合法 → 内容匹配。
///
/// 调用方（IPC 层）必须在拿到 `Ok` 之后**立即**拉起安装器，中间不要再插入
/// 任何可能让用户操作文件的等待（详见 `docs/UPDATE.md` 的 TOCTOU 说明）。
pub fn validate_installer(asset_path: &Path, asset: &UpdateAsset) -> Result<String, UpdaterError> {
    validate_installer_with(asset_path, asset, &SignatureVerifier::builtin())
}

/// 与 [`validate_installer`] 相同，但允许显式注入信任列表（测试/运维诊断用）。
pub fn validate_installer_with(
    asset_path: &Path,
    asset: &UpdateAsset,
    signatures: &SignatureVerifier,
) -> Result<String, UpdaterError> {
    if !asset_path.is_file() {
        return Err(
            UpdaterError::io(format!("installer not found at {}", asset_path.display()))
                .with_retryable(false),
        );
    }

    let manifest = asset.manifest.as_deref().ok_or_else(signature_missing)?;
    let signature = asset.signature.as_deref().ok_or_else(signature_missing)?;
    let verified = signatures.verify_manifest(manifest, signature)?;
    let expected = normalize_sha256(verified.sha256_for(&asset.name).as_deref())?;

    // IPC 传入的 sha256 也不能覆盖已签名清单：不一致说明调用链被篡改。
    if let Some(dto_hash) = asset.sha256.as_deref() {
        let dto_hash = normalize_sha256(Some(dto_hash))?;
        if dto_hash != expected {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Signature,
                "installer metadata hash does not match the signed release manifest",
            )
            .with_retryable(false)
            .with_details(serde_json::json!({
                "reason": "manifest_hash_mismatch",
                "asset": asset.name.clone(),
            })));
        }
    }

    Sha256Verifier
        .verify(asset_path, Some(expected.as_str()))
        .map_err(|err| {
            // 下载阶段的「哈希不符」可以就地重试；安装阶段不行 ——
            // 文件已经在磁盘上变了，重试安装没有意义，必须重新下载。
            if err.kind == UpdaterErrorKind::ChecksumMismatch {
                UpdaterError::new(
                    UpdaterErrorKind::ChecksumMismatch,
                    "installer no longer matches the published sha256; please download the update again",
                )
                .with_retryable(false)
                .with_details(err.details.unwrap_or(serde_json::Value::Null))
            } else {
                err
            }
        })?;
    Ok(expected)
}

fn signature_missing() -> UpdaterError {
    UpdaterError::new(
        UpdaterErrorKind::SignatureMissing,
        "release manifest is not signed; automatic installation is disabled, please download the update manually",
    )
    .with_retryable(false)
    .with_details(serde_json::json!({ "reason": "missing_signature" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    const ASSET_NAME: &str = "OpenShell-1.1.0-windows-x86_64.exe";
    const TEST_KEY_ID: &str = "test-key";

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn verifier() -> SignatureVerifier {
        SignatureVerifier::with_keys(vec![crate::verify::TrustedKey {
            key_id: TEST_KEY_ID.to_string(),
            status: crate::verify::KeyStatus::Active,
            key: signing_key().verifying_key(),
        }])
    }

    fn signature_for(manifest: &str) -> String {
        let signature = signing_key().sign(manifest.as_bytes());
        serde_json::json!({
            "version": 1,
            "signatures": [{
                "key_id": TEST_KEY_ID,
                "alg": "ed25519",
                "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            }],
        })
        .to_string()
    }

    fn manifest_with(entries: &[(&str, Option<&str>)]) -> String {
        let assets: Vec<serde_json::Value> = entries
            .iter()
            .map(|(name, sha)| {
                let mut asset = serde_json::json!({ "name": name });
                if let Some(sha) = sha {
                    asset["sha256"] = serde_json::Value::String(sha.to_string());
                }
                asset
            })
            .collect();
        serde_json::json!({
            "key_id": TEST_KEY_ID,
            "assets": assets,
        })
        .to_string()
    }

    fn signed_asset(sha256: Option<&str>) -> UpdateAsset {
        let manifest = manifest_with(&[(ASSET_NAME, sha256)]);
        let signature = signature_for(&manifest);
        UpdateAsset {
            name: ASSET_NAME.to_string(),
            url: "https://github.com/a/b/releases/download/v1.1.0/x.exe".to_string(),
            size: 5,
            sha256: sha256.map(str::to_string),
            manifest: Some(manifest),
            signature: Some(signature),
        }
    }

    fn write_temp(content: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("installer.exe");
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(content).expect("write");
        (dir, path)
    }

    fn sha256_of(path: &Path) -> String {
        use sha2::{Digest, Sha256};
        let bytes = std::fs::read(path).expect("read");
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn accepts_valid_sha256_and_matching_content() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        let validated = validate_installer_with(&path, &signed_asset(Some(&digest)), &verifier())
            .expect("valid");
        assert_eq!(validated.len(), SHA256_HEX_LEN);
    }

    #[test]
    fn rejects_missing_installer_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nope.exe");
        let asset = signed_asset(Some(&"0".repeat(64)));
        let err = validate_installer_with(&missing, &asset, &verifier()).expect_err("missing");
        assert_eq!(err.kind, UpdaterErrorKind::Io);
        assert!(!err.retryable);
    }

    #[test]
    fn rejects_absent_sha256() {
        let (_dir, path) = write_temp(b"hello");
        let asset = signed_asset(None);
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("no hash");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMissing);
        assert!(!err.retryable);
    }

    #[test]
    fn rejects_sha256_with_wrong_length() {
        let (_dir, path) = write_temp(b"hello");
        let short = "a".repeat(SHA256_HEX_LEN - 1);
        let asset = signed_asset(Some(&short));
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("short hash");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMissing);
    }

    #[test]
    fn rejects_non_hex_sha256() {
        let mut bad = "z".repeat(SHA256_HEX_LEN - 1);
        bad.push('0');
        let err = normalize_sha256(Some(&bad)).expect_err("non hex");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMissing);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["actual_len"].as_u64()),
            Some(SHA256_HEX_LEN as u64)
        );
    }

    #[test]
    fn rejects_content_that_does_not_match_sha256() {
        let (_dir, path) = write_temp(b"hello");
        let asset = signed_asset(Some(&"0".repeat(64)));
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("mismatch");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
        assert!(!err.retryable);
    }

    #[test]
    fn detects_truncated_file_after_download() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        std::fs::write(&path, b"hell").expect("truncate");
        let asset = signed_asset(Some(&digest));
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("truncated");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
    }

    #[test]
    fn rejects_unsigned_asset() {
        let (_dir, path) = write_temp(b"hello");
        let mut asset = signed_asset(Some(&sha256_of(&path)));
        asset.signature = None;
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("unsigned");
        assert_eq!(err.kind, UpdaterErrorKind::SignatureMissing);
        assert!(!err.retryable);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("missing_signature")
        );
    }

    #[test]
    fn rejects_tampered_manifest() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        let mut asset = signed_asset(Some(&digest));
        // 签名覆盖的是另一个清单（哈希不同），当前清单被篡改。
        let other = manifest_with(&[(ASSET_NAME, Some(&"1".repeat(64)))]);
        asset.manifest = Some(manifest_with(&[(ASSET_NAME, Some(&digest))]));
        asset.signature = Some(signature_for(&other));
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("tampered");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("invalid_signature")
        );
    }

    #[test]
    fn rejects_wrong_and_revoked_keys() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        let asset = signed_asset(Some(&digest));

        let wrong = SignatureVerifier::with_keys(vec![crate::verify::TrustedKey {
            key_id: TEST_KEY_ID.to_string(),
            status: crate::verify::KeyStatus::Active,
            key: SigningKey::from_bytes(&[9u8; 32]).verifying_key(),
        }]);
        let err = validate_installer_with(&path, &asset, &wrong).expect_err("wrong key");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);

        let revoked = SignatureVerifier::with_keys(vec![crate::verify::TrustedKey {
            key_id: TEST_KEY_ID.to_string(),
            status: crate::verify::KeyStatus::Revoked,
            key: signing_key().verifying_key(),
        }]);
        let err = validate_installer_with(&path, &asset, &revoked).expect_err("revoked key");
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("revoked_key")
        );
    }

    #[test]
    fn rejects_dto_hash_that_differs_from_signed_manifest() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        let mut asset = signed_asset(Some(&digest));
        asset.sha256 = Some("2".repeat(64));
        let err = validate_installer_with(&path, &asset, &verifier()).expect_err("metadata tamper");
        assert_eq!(err.kind, UpdaterErrorKind::Signature);
        assert_eq!(
            err.details.as_ref().and_then(|d| d["reason"].as_str()),
            Some("manifest_hash_mismatch")
        );
    }

    #[test]
    fn normalizes_uppercase_sha256() {
        let upper = "A".repeat(SHA256_HEX_LEN);
        assert_eq!(
            normalize_sha256(Some(&upper)).expect("upper"),
            "a".repeat(SHA256_HEX_LEN)
        );
    }
}
