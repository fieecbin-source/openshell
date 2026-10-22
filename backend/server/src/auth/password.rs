use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use rand::rngs::OsRng;

pub fn hash_password(password: &str) -> Result<String, String> {
    if password.len() < 10 || password.len() > 128 {
        return Err("Password length must be between 10 and 128 characters".to_string());
    }

    let salt = SaltString::generate(&mut OsRng);
    let params =
        Params::new(65536, 3, 1, Some(32)).map_err(|e| format!("Argon2 params error: {e}"))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("Password hash error: {e}"))?
        .to_string();

    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed_hash = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}
