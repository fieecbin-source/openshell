//! 主密码 → KEK 的 Argon2id 派生。

use crate::error;
use argon2::{Algorithm, Argon2, Params, Version};
use openshell_core_domain::DomainResult;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// 盐长度（字节）。
pub const SALT_LEN: usize = 16;
/// KEK 长度（字节）。
pub const KEK_LEN: usize = 32;

/// Argon2id 参数，对应 `vault` 表的 `kdf_mem_kib` / `kdf_time` / `kdf_parallelism`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub mem_kib: u32,
    pub time: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            mem_kib: 65536,
            time: 3,
            parallelism: 1,
        }
    }
}

/// 默认参数：64 MiB / 3 轮 / 1 并行。
pub const DEFAULT_KDF: KdfParams = KdfParams {
    mem_kib: 65536,
    time: 3,
    parallelism: 1,
};

impl KdfParams {
    /// 校验参数落在 Argon2 允许的范围内。
    pub fn validate(&self) -> DomainResult<()> {
        if self.mem_kib < 8 || self.time == 0 || self.parallelism == 0 {
            return Err(error::validation("invalid kdf parameters"));
        }
        Ok(())
    }
}

/// 生成 16 字节随机盐。
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    salt
}

/// 用 Argon2id 从主密码派生 32 字节 KEK。
pub fn derive_kek(
    password: &str,
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> DomainResult<Zeroizing<[u8; KEK_LEN]>> {
    params.validate()?;
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(
            params.mem_kib,
            params.time,
            params.parallelism,
            Some(KEK_LEN),
        )
        .map_err(|_| error::validation("invalid kdf parameters"))?,
    );
    let mut kek = Zeroizing::new([0u8; KEK_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *kek)
        .map_err(|_| error::internal("argon2 derivation failed"))?;
    Ok(kek)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_kek_is_deterministic() {
        let salt = [7u8; SALT_LEN];
        let params = KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        };
        let a = derive_kek("correct horse battery", &salt, &params).unwrap();
        let b = derive_kek("correct horse battery", &salt, &params).unwrap();
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn derive_kek_changes_with_salt() {
        let params = KdfParams {
            mem_kib: 1024,
            time: 1,
            parallelism: 1,
        };
        let a = derive_kek("correct horse battery", &[1u8; SALT_LEN], &params).unwrap();
        let b = derive_kek("correct horse battery", &[2u8; SALT_LEN], &params).unwrap();
        assert_ne!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn invalid_params_are_rejected() {
        let params = KdfParams {
            mem_kib: 0,
            time: 3,
            parallelism: 1,
        };
        assert!(params.validate().is_err());
    }
}
