//! 系统凭据库后端：`keyring` 封装与内存实现（测试/无凭据环境）。

use keyring::Error as KeyringError;
use parking_lot::Mutex;
use std::collections::HashMap;
use zeroize::Zeroizing;

/// 系统凭据库中固定的服务名。
pub(crate) const KEYRING_SERVICE: &str = "openshell.ai";

/// 凭据后端错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyStoreError {
    /// 凭据不存在。
    NoEntry,
    /// 平台凭据库不可用 / 无存储访问权限。
    Unavailable,
    /// 其他读写失败。
    Failed,
}

impl KeyStoreError {
    fn classify(err: KeyringError) -> Self {
        match err {
            KeyringError::NoEntry => Self::NoEntry,
            KeyringError::PlatformFailure(_) | KeyringError::NoStorageAccess(_) => {
                Self::Unavailable
            }
            _ => Self::Failed,
        }
    }
}

/// 可注入的主凭据通道。
pub(crate) trait KeyStoreBackend: Send + Sync {
    fn set(&self, profile_id: &str, secret: &str) -> Result<(), KeyStoreError>;
    fn get(&self, profile_id: &str) -> Result<Option<Zeroizing<String>>, KeyStoreError>;
    fn delete(&self, profile_id: &str) -> Result<(), KeyStoreError>;
}

/// 生产后端：Windows 凭据管理器 / macOS Keychain / Linux Secret Service。
pub(crate) struct KeyringStore;

impl KeyringStore {
    pub(crate) fn new() -> Self {
        Self
    }

    fn entry(profile_id: &str) -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(KEYRING_SERVICE, profile_id).map_err(KeyStoreError::classify)
    }
}

impl KeyStoreBackend for KeyringStore {
    fn set(&self, profile_id: &str, secret: &str) -> Result<(), KeyStoreError> {
        Self::entry(profile_id)?
            .set_password(secret)
            .map_err(KeyStoreError::classify)
    }

    fn get(&self, profile_id: &str) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        match Self::entry(profile_id)?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(err) => Err(KeyStoreError::classify(err)),
        }
    }

    fn delete(&self, profile_id: &str) -> Result<(), KeyStoreError> {
        match Self::entry(profile_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(KeyStoreError::classify(err)),
        }
    }
}

/// 内存后端：`for_test` 使用，不触碰真实系统凭据库。
pub(crate) struct MemoryStore {
    entries: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl MemoryStore {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl KeyStoreBackend for MemoryStore {
    fn set(&self, profile_id: &str, secret: &str) -> Result<(), KeyStoreError> {
        self.entries
            .lock()
            .insert(profile_id.to_string(), Zeroizing::new(secret.to_string()));
        Ok(())
    }

    fn get(&self, profile_id: &str) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        Ok(self
            .entries
            .lock()
            .get(profile_id)
            .map(|secret| Zeroizing::new(secret.to_string())))
    }

    fn delete(&self, profile_id: &str) -> Result<(), KeyStoreError> {
        self.entries.lock().remove(profile_id);
        Ok(())
    }
}

impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryStore")
            .field("entries", &self.entries.lock().len())
            .finish()
    }
}
