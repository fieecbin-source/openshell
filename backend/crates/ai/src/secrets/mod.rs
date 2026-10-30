//! API Key 存储：系统凭据库优先，保险库主密码加密的本地文件回退。
//!
//! 安全约束：
//! - API Key 不写入 SQLite、日志、`Debug` 输出或前端响应；
//! - 内存中统一使用 [`Zeroizing`]；写入回退文件时为 JSON 信封 + AEAD 密文；
//! - 仅当系统凭据库不可用（平台不支持 / 无存储访问）时才使用回退通道。

mod file_store;
mod keyring_store;

use crate::error::{AiError, AiErrorCode};
use file_store::FileError;
use keyring_store::{KeyStoreBackend, KeyStoreError, KeyringStore, MemoryStore};
use openshell_vault::VaultManager;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use zeroize::Zeroizing;

const BACKEND_KEYRING: u8 = 0;
const BACKEND_VAULT_FILE: u8 = 1;
const BACKEND_UNAVAILABLE: u8 = 2;

/// 凭据后端类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBackend {
    /// 系统凭据库（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
    Keyring,
    /// 保险库主密码加密的本地文件。
    VaultFile,
    /// 两者均不可用。
    Unavailable,
}

impl KeyBackend {
    /// 与前端契约一致的线值。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Keyring => "keyring",
            Self::VaultFile => "vault_file",
            Self::Unavailable => "unavailable",
        }
    }

    /// 面向用户的中文说明。
    pub fn message(&self) -> &'static str {
        match self {
            Self::Keyring => "API Key 保存在系统凭据库中，由操作系统加密保护。",
            Self::VaultFile => {
                "系统凭据库不可用，API Key 已加密保存在本地保险库文件中，使用前需先解锁保险库。"
            }
            Self::Unavailable => "系统凭据库不可用且保险库未初始化，暂时无法安全保存 API Key。",
        }
    }
}

/// API Key 存储。
pub struct ApiKeyStore {
    primary: Arc<dyn KeyStoreBackend>,
    fallback_dir: PathBuf,
    vault: Option<Arc<VaultManager>>,
    backend: AtomicU8,
}

impl ApiKeyStore {
    /// 生产环境：keyring 为主，`fallback_dir` 为回退加密文件目录。
    pub fn new(fallback_dir: PathBuf, vault: Option<Arc<VaultManager>>) -> Self {
        Self::with_primary(Arc::new(KeyringStore::new()), fallback_dir, vault)
    }

    /// 测试 / 无 OS 凭据环境：内存后端，不触碰系统凭据库。
    pub fn for_test(fallback_dir: PathBuf) -> Self {
        Self::with_primary(Arc::new(MemoryStore::new()), fallback_dir, None)
    }

    fn with_primary(
        primary: Arc<dyn KeyStoreBackend>,
        fallback_dir: PathBuf,
        vault: Option<Arc<VaultManager>>,
    ) -> Self {
        Self {
            primary,
            fallback_dir,
            vault,
            backend: AtomicU8::new(BACKEND_KEYRING),
        }
    }

    /// 写入 API Key；空字符串等价于删除。
    pub fn set_api_key(&self, profile_id: &str, api_key: &str) -> Result<(), AiError> {
        if api_key.is_empty() {
            return self.delete_api_key(profile_id);
        }
        match self.primary.set(profile_id, api_key) {
            Ok(()) => {
                self.set_backend(KeyBackend::Keyring);
                Ok(())
            }
            Err(KeyStoreError::Unavailable) => self.write_fallback(profile_id, api_key),
            Err(KeyStoreError::NoEntry) | Err(KeyStoreError::Failed) => Err(AiError::new(
                AiErrorCode::KeyWriteFailed,
                "API Key 写入系统凭据库失败，请稍后重试",
            )),
        }
    }

    /// 读取 API Key。调用方应在使用后让返回值自然析构（自动清零）。
    pub fn get_api_key(&self, profile_id: &str) -> Result<Zeroizing<String>, AiError> {
        match self.primary.get(profile_id) {
            Ok(Some(secret)) => {
                self.set_backend(KeyBackend::Keyring);
                Ok(secret)
            }
            Ok(None) | Err(KeyStoreError::NoEntry) => self.read_fallback(profile_id, false),
            Err(KeyStoreError::Unavailable) => self.read_fallback(profile_id, true),
            Err(KeyStoreError::Failed) => Err(AiError::new(
                AiErrorCode::KeyDecryptFailed,
                "无法从系统凭据库读取 API Key，请重新填写",
            )),
        }
    }

    /// 删除 API Key（凭据库与回退文件均尝试清理）。
    pub fn delete_api_key(&self, profile_id: &str) -> Result<(), AiError> {
        let primary = self.primary.delete(profile_id);
        let fallback = file_store::delete(&self.fallback_dir, profile_id);

        if matches!(fallback, Err(FileError::Write)) {
            return Err(AiError::new(
                AiErrorCode::KeyWriteFailed,
                "删除 API Key 失败，请稍后重试",
            ));
        }
        match primary {
            Ok(()) | Err(KeyStoreError::NoEntry) | Err(KeyStoreError::Unavailable) => Ok(()),
            Err(KeyStoreError::Failed) => Err(AiError::new(
                AiErrorCode::KeyWriteFailed,
                "删除 API Key 失败，请稍后重试",
            )),
        }
    }

    /// 是否已存在该档案的 API Key（不返回密钥内容）。
    pub fn has_api_key(&self, profile_id: &str) -> bool {
        match self.primary.get(profile_id) {
            Ok(Some(_)) => true,
            Ok(None) | Err(KeyStoreError::NoEntry) | Err(KeyStoreError::Unavailable) => {
                file_store::exists(&self.fallback_dir, profile_id)
            }
            Err(KeyStoreError::Failed) => false,
        }
    }

    /// 当前生效的凭据后端。
    pub fn backend(&self) -> KeyBackend {
        match self.backend.load(Ordering::Relaxed) {
            BACKEND_VAULT_FILE => KeyBackend::VaultFile,
            BACKEND_UNAVAILABLE => KeyBackend::Unavailable,
            _ => KeyBackend::Keyring,
        }
    }

    /// 当前后端的用户提示文案。
    pub fn backend_message(&self) -> String {
        self.backend().message().to_string()
    }

    fn set_backend(&self, backend: KeyBackend) {
        let value = match backend {
            KeyBackend::Keyring => BACKEND_KEYRING,
            KeyBackend::VaultFile => BACKEND_VAULT_FILE,
            KeyBackend::Unavailable => BACKEND_UNAVAILABLE,
        };
        self.backend.store(value, Ordering::Relaxed);
    }

    fn write_fallback(&self, profile_id: &str, api_key: &str) -> Result<(), AiError> {
        let Some(vault) = self.vault.as_ref() else {
            self.set_backend(KeyBackend::Unavailable);
            return Err(AiError::new(
                AiErrorCode::KeyringUnavailable,
                "系统凭据库不可用，无法安全保存 API Key",
            ));
        };

        self.set_backend(KeyBackend::VaultFile);
        file_store::write(&self.fallback_dir, profile_id, api_key, vault).map_err(|err| match err {
            FileError::Locked => AiError::new(
                AiErrorCode::VaultLocked,
                "系统凭据库不可用，且保险库未解锁，无法安全保存 API Key",
            ),
            FileError::Decrypt | FileError::Write => AiError::new(
                AiErrorCode::KeyWriteFailed,
                "API Key 写入加密文件失败，请稍后重试",
            ),
        })
    }

    fn read_fallback(
        &self,
        profile_id: &str,
        keyring_unavailable: bool,
    ) -> Result<Zeroizing<String>, AiError> {
        let Some(vault) = self.vault.as_ref() else {
            return Err(AiError::new(
                AiErrorCode::KeyringUnavailable,
                "系统凭据库不可用，无法读取 API Key",
            ));
        };

        match file_store::read(&self.fallback_dir, profile_id, vault) {
            Ok(Some(secret)) => {
                self.set_backend(KeyBackend::VaultFile);
                Ok(secret)
            }
            Ok(None) => {
                if keyring_unavailable {
                    Err(AiError::new(
                        AiErrorCode::KeyringUnavailable,
                        "系统凭据库不可用，无法读取 API Key",
                    ))
                } else {
                    Err(AiError::new(
                        AiErrorCode::KeyDecryptFailed,
                        "API Key 不存在，请重新填写",
                    ))
                }
            }
            Err(FileError::Locked) => {
                self.set_backend(KeyBackend::VaultFile);
                Err(AiError::new(
                    AiErrorCode::VaultLocked,
                    "保险库已锁定，请先解锁后再使用 AI 模型配置",
                ))
            }
            Err(FileError::Decrypt) | Err(FileError::Write) => Err(AiError::new(
                AiErrorCode::KeyDecryptFailed,
                "API Key 解密失败，请重新填写",
            )),
        }
    }
}

impl fmt::Debug for ApiKeyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiKeyStore")
            .field("backend", &self.backend())
            .field("fallback_dir", &self.fallback_dir)
            .field(
                "vault_unlocked",
                &self.vault.as_ref().map(|v| v.is_unlocked()),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_vault::KdfParams;

    fn fast_kdf() -> KdfParams {
        KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        }
    }

    fn profile_id() -> String {
        ulid::Ulid::new().to_string()
    }

    fn unlocked_vault() -> Arc<VaultManager> {
        let vault = Arc::new(VaultManager::new());
        vault
            .init("correct horse battery", fast_kdf())
            .expect("init vault");
        vault
    }

    /// 模拟平台凭据库不可用。
    struct UnavailableStore;

    impl KeyStoreBackend for UnavailableStore {
        fn set(&self, _profile_id: &str, _secret: &str) -> Result<(), KeyStoreError> {
            Err(KeyStoreError::Unavailable)
        }

        fn get(&self, _profile_id: &str) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
            Err(KeyStoreError::Unavailable)
        }

        fn delete(&self, _profile_id: &str) -> Result<(), KeyStoreError> {
            Err(KeyStoreError::Unavailable)
        }
    }

    fn unavailable_store(fallback_dir: PathBuf, vault: Option<Arc<VaultManager>>) -> ApiKeyStore {
        ApiKeyStore::with_primary(Arc::new(UnavailableStore), fallback_dir, vault)
    }

    #[test]
    fn secrets_memory_backend_roundtrip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ApiKeyStore::for_test(dir.path().to_path_buf());
        let id = profile_id();

        assert_eq!(store.backend(), KeyBackend::Keyring);
        assert!(!store.has_api_key(&id));

        store.set_api_key(&id, "sk-test-123").expect("set");
        assert!(store.has_api_key(&id));
        assert_eq!(store.get_api_key(&id).expect("get").as_str(), "sk-test-123");

        store.set_api_key(&id, "sk-test-456").expect("overwrite");
        assert_eq!(store.get_api_key(&id).expect("get").as_str(), "sk-test-456");

        store.delete_api_key(&id).expect("delete");
        assert!(!store.has_api_key(&id));
        assert!(store.get_api_key(&id).is_err());

        // 内存后端不落任何文件。
        assert!(!dir.path().join(format!("{id}.key")).exists());
    }

    #[test]
    fn secrets_empty_string_deletes_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ApiKeyStore::for_test(dir.path().to_path_buf());
        let id = profile_id();

        store.set_api_key(&id, "sk-to-delete").expect("set");
        assert!(store.has_api_key(&id));

        store.set_api_key(&id, "").expect("empty deletes");
        assert!(!store.has_api_key(&id));
        assert!(store.get_api_key(&id).is_err());
    }

    #[test]
    fn secrets_debug_never_prints_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = ApiKeyStore::for_test(dir.path().to_path_buf());
        store
            .set_api_key(&profile_id(), "sk-super-secret")
            .expect("set");
        let debug = format!("{store:?}");
        assert!(!debug.contains("sk-super-secret"));
    }

    #[test]
    fn secrets_keyring_unavailable_without_vault() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = unavailable_store(dir.path().to_path_buf(), None);
        let err = store
            .set_api_key(&profile_id(), "sk-fallback")
            .expect_err("keyring unavailable");
        assert_eq!(err.code, AiErrorCode::KeyringUnavailable);
        assert_eq!(err.message, "系统凭据库不可用，无法安全保存 API Key");
        assert_eq!(store.backend(), KeyBackend::Unavailable);
        assert!(store.backend_message().contains("保险库未初始化"));
    }

    #[test]
    fn secrets_keyring_unavailable_with_locked_vault() {
        let dir = tempfile::tempdir().expect("temp dir");
        let vault = unlocked_vault();
        vault.lock();
        let store = unavailable_store(dir.path().to_path_buf(), Some(vault));
        let err = store
            .set_api_key(&profile_id(), "sk-fallback")
            .expect_err("vault locked");
        assert_eq!(err.code, AiErrorCode::VaultLocked);
        assert_eq!(
            err.message,
            "系统凭据库不可用，且保险库未解锁，无法安全保存 API Key"
        );
        assert_eq!(store.backend(), KeyBackend::VaultFile);
    }

    #[test]
    fn secrets_fallback_file_encrypted_roundtrip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let vault = unlocked_vault();
        let store = unavailable_store(dir.path().to_path_buf(), Some(vault.clone()));
        let id = profile_id();
        let api_key = "sk-super-secret-key-material";

        store.set_api_key(&id, api_key).expect("set fallback");
        assert_eq!(store.backend(), KeyBackend::VaultFile);
        assert!(store.has_api_key(&id));

        let path = dir.path().join(format!("{id}.key"));
        let raw = std::fs::read_to_string(&path).expect("read fallback file");
        assert!(!raw.contains(api_key), "回退文件不得包含明文 API Key");
        assert!(raw.contains("xchacha20poly1305"));
        assert!(raw.contains("\"cipher\""));

        let read = store.get_api_key(&id).expect("get fallback");
        assert_eq!(read.as_str(), api_key);

        // 保险库锁定后读取返回 VaultLocked。
        vault.lock();
        let err = store.get_api_key(&id).expect_err("vault locked");
        assert_eq!(err.code, AiErrorCode::VaultLocked);
        assert_eq!(err.message, "保险库已锁定，请先解锁后再使用 AI 模型配置");

        // 删除同时清理回退文件。
        store.delete_api_key(&id).expect("delete");
        assert!(!path.exists());
        assert!(!store.has_api_key(&id));
    }

    #[test]
    fn secrets_backend_strings_match_contract() {
        assert_eq!(KeyBackend::Keyring.as_str(), "keyring");
        assert_eq!(KeyBackend::VaultFile.as_str(), "vault_file");
        assert_eq!(KeyBackend::Unavailable.as_str(), "unavailable");
        for backend in [
            KeyBackend::Keyring,
            KeyBackend::VaultFile,
            KeyBackend::Unavailable,
        ] {
            assert!(!backend.message().is_empty());
        }
    }
}
