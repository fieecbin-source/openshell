//! 安装前的前置检查（纯函数 + 文件读取，不依赖 Tauri）。
//!
//! 安装是唯一会改动用户机器上可执行文件的操作，所以进入安装流程前必须再确认一次：
//! 1. 安装包还在磁盘上（可能被用户删掉、被清理工具扫走）；
//! 2. 清单里的 sha256 合法（否则「校验」形同虚设）；
//! 3. 文件内容仍与清单一致（下载完成到点击安装之间可能被替换/截断）。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::model::UpdateAsset;
use crate::verify::{Sha256Verifier, Verifier};
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

/// 安装前的完整检查：路径存在 → sha256 合法 → 内容匹配。
///
/// 调用方（IPC 层）必须在拿到 `Ok` 之后**立即**拉起安装器，中间不要再插入
/// 任何可能让用户操作文件的等待（详见 `docs/UPDATE.md` 的 TOCTOU 说明）。
pub fn validate_installer(asset_path: &Path, asset: &UpdateAsset) -> Result<String, UpdaterError> {
    if !asset_path.is_file() {
        return Err(
            UpdaterError::io(format!("installer not found at {}", asset_path.display()))
                .with_retryable(false),
        );
    }
    let expected = normalize_sha256(asset.sha256.as_deref())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn asset(sha256: Option<String>) -> UpdateAsset {
        UpdateAsset {
            name: "OpenShell-1.1.0-windows-x86_64.exe".to_string(),
            url: "https://github.com/a/b/releases/download/v1.1.0/x.exe".to_string(),
            size: 5,
            sha256,
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
        let validated = validate_installer(&path, &asset(Some(digest))).expect("valid");
        assert_eq!(validated.len(), SHA256_HEX_LEN);
    }

    #[test]
    fn rejects_missing_installer_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nope.exe");
        let err = validate_installer(&missing, &asset(Some("0".repeat(64)))).expect_err("missing");
        assert_eq!(err.kind, UpdaterErrorKind::Io);
        assert!(!err.retryable);
    }

    #[test]
    fn rejects_absent_sha256() {
        let (_dir, path) = write_temp(b"hello");
        let err = validate_installer(&path, &asset(None)).expect_err("no hash");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMissing);
        assert!(!err.retryable);
    }

    #[test]
    fn rejects_sha256_with_wrong_length() {
        let (_dir, path) = write_temp(b"hello");
        // 63 位：少一个字符
        let short = "a".repeat(SHA256_HEX_LEN - 1);
        let err = validate_installer(&path, &asset(Some(short))).expect_err("short hash");
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
        let err = validate_installer(&path, &asset(Some("0".repeat(64)))).expect_err("mismatch");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
        assert!(!err.retryable);
    }

    #[test]
    fn detects_truncated_file_after_download() {
        let (_dir, path) = write_temp(b"hello");
        let digest = sha256_of(&path);
        // 模拟下载完成后文件被截断
        std::fs::write(&path, b"hell").expect("truncate");
        let err = validate_installer(&path, &asset(Some(digest))).expect_err("truncated");
        assert_eq!(err.kind, UpdaterErrorKind::ChecksumMismatch);
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
