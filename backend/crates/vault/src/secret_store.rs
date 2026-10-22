//! `SecretStore` trait 实现。

use crate::vault::VaultManager;
use openshell_core_domain::{DomainResult, SecretId, SecretRecord, SecretStore};

impl SecretStore for VaultManager {
    fn is_unlocked(&self) -> bool {
        VaultManager::is_unlocked(self)
    }

    fn encrypt_secret(
        &self,
        secret_id: &SecretId,
        record_type: &str,
        plaintext: &[u8],
    ) -> DomainResult<SecretRecord> {
        VaultManager::encrypt_secret(self, secret_id, record_type, plaintext)
    }

    fn decrypt_secret(&self, record: &SecretRecord) -> DomainResult<Vec<u8>> {
        VaultManager::decrypt_secret(self, record)
    }
}
