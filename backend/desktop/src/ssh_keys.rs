use crate::error::IpcError;
use openshell_core_domain::{DomainError, DomainResult};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_KEY_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct SelectedPrivateKey {
    file_name: String,
    pem: String,
}

fn read_selected_key(path: &Path) -> DomainResult<SelectedPrivateKey> {
    // 选择文件只读取文本，私钥格式和密码统一在保存时验证。
    let invalid_file =
        || DomainError::validation("无法读取私钥文件，请选择小于 1 MiB 的私钥文本文件。");
    let metadata = path.metadata().map_err(|_| invalid_file())?;
    if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES {
        return Err(invalid_file());
    }
    let mut pem = String::new();
    std::fs::File::open(path)
        .map_err(|_| invalid_file())?
        .take(MAX_KEY_BYTES + 1)
        .read_to_string(&mut pem)
        .map_err(|_| invalid_file())?;
    if pem.len() as u64 > MAX_KEY_BYTES {
        return Err(invalid_file());
    }
    Ok(SelectedPrivateKey {
        file_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        pem,
    })
}

#[tauri::command]
pub async fn ssh_key_pick_file(
    app: tauri::AppHandle,
) -> Result<Option<SelectedPrivateKey>, IpcError> {
    let directory = app
        .path()
        .home_dir()
        .map_err(|_| DomainError::internal("无法定位当前用户的 .ssh 目录。"))?
        .join(".ssh");
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("选择 SSH 私钥文件")
            .set_directory(directory)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| DomainError::validation("请选择本地私钥文件。"))?;
        read_selected_key(&path).map(Some)
    })
    .await
    .map_err(|_| DomainError::internal("打开私钥文件选择器失败，请重试。"))?
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_selected_file_and_returns_its_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("id_ed25519");
        std::fs::write(&path, "selected key text").unwrap();
        let selected = read_selected_key(&path).unwrap();
        assert_eq!(selected.file_name, "id_ed25519");
        assert_eq!(selected.pem, "selected key text");
    }

    #[test]
    fn rejects_missing_directories_binary_and_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_selected_key(directory.path()).is_err());
        assert!(read_selected_key(&directory.path().join("missing")).is_err());
        let path = directory.path().join("key");
        std::fs::write(&path, [0xff]).unwrap();
        assert!(read_selected_key(&path).is_err());
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_KEY_BYTES + 1).unwrap();
        assert!(read_selected_key(&path).is_err());
    }
}
