//! 回退通道：保险库主密码派生的密钥加密的本地文件。
//!
//! 每个档案对应 `fallback_dir/<profile_id>.key`，内容为 JSON 信封：
//! `{ version, profile_id, key_len, cipher }`，其中 `cipher` 为
//! [`RecordCipher`]（XChaCha20-Poly1305）。明文 API Key 永不落盘。

use openshell_core_domain::ErrorCode;
use openshell_vault::{RecordCipher, VaultManager};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, Zeroizing};

/// 记录类型（参与 AAD 绑定）。
pub(crate) const RECORD_TYPE: &str = "ai_api_key";
const ENVELOPE_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) enum FileError {
    /// 保险库未解锁。
    Locked,
    /// 文件损坏或解密失败。
    Decrypt,
    /// 写入/删除失败。
    Write,
}

#[derive(Serialize, Deserialize)]
struct KeyEnvelope {
    version: u32,
    profile_id: String,
    /// 明文长度，用于完整性校验。
    key_len: usize,
    cipher: RecordCipher,
}

/// 仅允许 ULID 风格字符，避免路径穿越。
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn path_for(dir: &Path, profile_id: &str) -> Result<PathBuf, FileError> {
    if !is_safe_id(profile_id) {
        return Err(FileError::Write);
    }
    Ok(dir.join(format!("{profile_id}.key")))
}

/// 回退文件是否存在（不校验能否解密）。
pub(crate) fn exists(dir: &Path, profile_id: &str) -> bool {
    path_for(dir, profile_id)
        .map(|path| path.is_file())
        .unwrap_or(false)
}

fn map_vault_error(err: openshell_core_domain::DomainError, fallback: FileError) -> FileError {
    if err.code == ErrorCode::VaultLocked {
        FileError::Locked
    } else {
        fallback
    }
}

/// 加密并原子写入回退文件。
pub(crate) fn write(
    dir: &Path,
    profile_id: &str,
    api_key: &str,
    vault: &VaultManager,
) -> Result<(), FileError> {
    let path = path_for(dir, profile_id)?;
    if !vault.is_unlocked() {
        return Err(FileError::Locked);
    }

    let cipher = vault
        .encrypt_record(RECORD_TYPE, profile_id, api_key.as_bytes())
        .map_err(|err| map_vault_error(err, FileError::Write))?;
    let envelope = KeyEnvelope {
        version: ENVELOPE_VERSION,
        profile_id: profile_id.to_string(),
        key_len: api_key.len(),
        cipher,
    };
    let payload = serde_json::to_vec(&envelope).map_err(|_| FileError::Write)?;

    fs::create_dir_all(dir).map_err(|_| FileError::Write)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }

    // 临时文件 + rename：避免部分写入，并保证重复写入幂等。
    let tmp = dir.join(format!(".{profile_id}.{}.tmp", ulid::Ulid::new()));
    let written = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        Ok(())
    })();

    if written.is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(FileError::Write);
    }
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(FileError::Write);
    }
    Ok(())
}

/// 读取并解密回退文件；文件不存在时返回 `Ok(None)`。
pub(crate) fn read(
    dir: &Path,
    profile_id: &str,
    vault: &VaultManager,
) -> Result<Option<Zeroizing<String>>, FileError> {
    let path = path_for(dir, profile_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(FileError::Decrypt),
    };

    let envelope: KeyEnvelope = serde_json::from_str(&raw).map_err(|_| FileError::Decrypt)?;
    if envelope.version != ENVELOPE_VERSION || envelope.profile_id != profile_id {
        return Err(FileError::Decrypt);
    }
    if !vault.is_unlocked() {
        return Err(FileError::Locked);
    }

    let mut plain = vault
        .decrypt_record(RECORD_TYPE, profile_id, &envelope.cipher)
        .map_err(|err| map_vault_error(err, FileError::Decrypt))?;

    if plain.len() != envelope.key_len {
        plain.zeroize();
        return Err(FileError::Decrypt);
    }
    match String::from_utf8(plain) {
        Ok(text) => Ok(Some(Zeroizing::new(text))),
        Err(err) => {
            let mut bytes = err.into_bytes();
            bytes.zeroize();
            Err(FileError::Decrypt)
        }
    }
}

/// 删除回退文件；不存在视为成功。
pub(crate) fn delete(dir: &Path, profile_id: &str) -> Result<(), FileError> {
    let path = match path_for(dir, profile_id) {
        Ok(path) => path,
        Err(_) => return Ok(()),
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(FileError::Write),
    }
}
