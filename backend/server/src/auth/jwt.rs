use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // account_id
    pub did: String, // device_id
    pub sid: String, // session/family_id
    pub ver: u64,    // token_epoch
    pub iat: u64,
    pub exp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JwtHeader {
    alg: String,
    typ: String,
}

pub fn create_access_token(
    account_id: &str,
    device_id: &str,
    session_id: &str,
    token_epoch: u64,
    secret: &str,
    ttl_seconds: u64,
) -> Result<(String, String), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let exp = now + ttl_seconds;

    let header = JwtHeader {
        alg: "HS256".to_string(),
        typ: "JWT".to_string(),
    };

    let claims = Claims {
        sub: account_id.to_string(),
        did: device_id.to_string(),
        sid: session_id.to_string(),
        ver: token_epoch,
        iat: now,
        exp,
    };

    let header_b64 =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|e| e.to_string())?);
    let claims_b64 =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
    let message = format!("{header_b64}.{claims_b64}");

    let signature = hmac_sha256(secret.as_bytes(), message.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature);

    let token = format!("{message}.{sig_b64}");
    let exp_iso = time::OffsetDateTime::from_unix_timestamp(exp as i64)
        .unwrap_or(time::OffsetDateTime::now_utc())
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    Ok((token, exp_iso))
}

pub fn verify_access_token(token: &str, secret: &str) -> Result<Claims, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid token format".to_string());
    }

    let message = format!("{}.{}", parts[0], parts[1]);
    let expected_sig = hmac_sha256(secret.as_bytes(), message.as_bytes());
    let provided_sig = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "Invalid token signature encoding".to_string())?;

    if expected_sig.len() != provided_sig.len() {
        return Err("Signature mismatch".to_string());
    }

    // Constant-time comparison
    let mut diff = 0u8;
    for (a, b) in expected_sig.iter().zip(provided_sig.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err("Signature verification failed".to_string());
    }

    let claims_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Invalid token payload encoding".to_string())?;
    let claims: Claims =
        serde_json::from_slice(&claims_bytes).map_err(|e| format!("Invalid token claims: {e}"))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    if now > claims.exp {
        return Err("Token expired".to_string());
    }

    Ok(claims)
}

pub fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let block_size = 64;
    let mut k = if key.len() > block_size {
        let mut hasher = Sha256::new();
        hasher.update(key);
        hasher.finalize().to_vec()
    } else {
        key.to_vec()
    };
    k.resize(block_size, 0);

    let mut ipad = vec![0x36u8; block_size];
    let mut opad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner_hasher = Sha256::new();
    inner_hasher.update(&ipad);
    inner_hasher.update(data);
    let inner_hash = inner_hasher.finalize();

    let mut outer_hasher = Sha256::new();
    outer_hasher.update(&opad);
    outer_hasher.update(inner_hash);
    outer_hasher.finalize().to_vec()
}

pub mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut s = String::with_capacity(bytes.as_ref().len() * 2);
        for b in bytes.as_ref() {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        s
    }
}
