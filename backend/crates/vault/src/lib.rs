//! OpenShell 保险库：Argon2id 密钥派生 + XChaCha20-Poly1305 记录加密。
//!
//! 密钥层级：
//! 主密码 → Argon2id → KEK → 包裹随机 VaultKey → HKDF-SHA256 派生记录密钥
//! → XChaCha20-Poly1305 加密记录/秘密载荷。
//! 明文主密码、KEK、VaultKey 与记录密钥均不落盘。

mod error;

pub mod autolock;
pub mod kdf;
pub mod key_hierarchy;
pub mod key_slot;
pub mod package;
pub mod record_cipher;
mod secret_store;
pub mod vault;

pub use autolock::AutoLockPolicy;
pub use kdf::{derive_kek, random_salt, KdfParams, DEFAULT_KDF};
pub use key_hierarchy::VaultKey;
pub use key_slot::{validate_password, KeySlot, KeySlotParts, MIN_PASSWORD_LEN};
pub use package::{open_package, seal_package, PACKAGE_MAGIC};
pub use record_cipher::{RecordCipher, CRYPTO_SUITE};
pub use vault::VaultManager;
