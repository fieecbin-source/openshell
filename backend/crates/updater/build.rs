//! 把 `keys/*.pub` 里的更新签名公钥编进二进制。
//!
//! 仓库只允许提交公钥（`keys/<key-id>.pub`）与说明文档；私钥必须离线保存。
//! 这里只做「读取 + 生成一个静态数组」，不做任何网络或密钥生成操作。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let keys_dir = manifest_dir.join("keys");
    println!("cargo:rerun-if-changed={}", keys_dir.display());

    let mut entries: Vec<String> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&keys_dir) {
        let mut paths: Vec<PathBuf> = read_dir
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "pub"))
            .collect();
        paths.sort();
        for path in paths {
            if let Some(entry) = parse_key_file(&path) {
                entries.push(entry);
            } else {
                println!(
                    "cargo:warning=ignoring malformed update signing key {}",
                    path.display()
                );
            }
        }
    }

    let generated = format!(
        "pub static EMBEDDED_KEYS: &[(&str, &str, &str)] = &[{}];\n",
        entries.join(", ")
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("embedded_keys.rs");
    fs::write(out, generated).expect("write embedded keys");
}

/// 解析 `key_id=... / status=... / public_key=...` 形式的公钥文件。
fn parse_key_file(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let mut key_id = None::<String>;
    let mut status = "active".to_string();
    let mut public_key = None::<String>;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, value) = line.split_once('=')?;
        let value = value.trim();
        match name.trim() {
            "key_id" => key_id = Some(value.to_string()),
            "status" => status = value.to_string(),
            "public_key" => public_key = Some(value.to_string()),
            _ => {}
        }
    }

    let key_id = key_id?;
    let public_key = public_key?;
    if key_id.is_empty()
        || !key_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || public_key.is_empty()
    {
        return None;
    }
    Some(format!("({:?}, {:?}, {:?})", key_id, status, public_key))
}
