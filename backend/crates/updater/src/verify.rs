//! 安装包校验。
//!
//! 当前只启用 sha256（`Sha256Verifier`），但流程依赖 [`Verifier`] 抽象：
//! 以后接入 minisign / cosign / 平台代码签名时，只要注册新的实现并串进校验链，
//! 下载与安装流程无需任何改动。
//!
//! 注意（已写入 docs/UPDATE.md）：sha256 清单与安装包托管在同一仓库，
//! 能防传输损坏与镜像投毒，但**防不住仓库/账号被入侵**，这是本方案的已知上限。

use crate::error::{UpdaterError, UpdaterErrorKind};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 校验器。
pub trait Verifier: Send + Sync {
    /// 校验器名称（写日志用）。
    fn name(&self) -> &'static str;

    /// 是否已启用。未启用的校验器会被安装流程跳过（例如签名校验）。
    fn is_enabled(&self) -> bool;

    /// 校验文件；失败必须返回 `ChecksumMismatch` 或 `UpdateSignature`。
    fn verify(&self, path: &Path, expected_sha256: Option<&str>) -> Result<(), UpdaterError>;
}

/// sha256 校验器（唯一启用的实现）。
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

/// 签名校验器占位（**未启用**）。
///
/// 预留位：接入签名后 `is_enabled()` 返回 true，并在 `verify` 中验签。
/// 目前既不读取密钥也不访问网络。
pub struct SignatureVerifier;

impl Verifier for SignatureVerifier {
    fn name(&self) -> &'static str {
        "signature"
    }

    fn is_enabled(&self) -> bool {
        false
    }

    fn verify(&self, _path: &Path, _expected_sha256: Option<&str>) -> Result<(), UpdaterError> {
        Err(UpdaterError::new(
            UpdaterErrorKind::NotConfigured,
            "signature verification is not enabled in this build",
        ))
    }
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

    fn write_temp(content: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("payload.bin");
        std::fs::write(&path, content).expect("write");
        (dir, path)
    }

    #[test]
    fn computes_known_sha256() {
        // echo -n "abc" | sha256sum
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
    fn signature_verifier_is_disabled() {
        assert!(!SignatureVerifier.is_enabled());
        assert!(SignatureVerifier.verify(Path::new("nope"), None).is_err());
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
