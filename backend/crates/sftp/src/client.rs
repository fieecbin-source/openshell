//! SFTP 客户端与文件属性。

use openshell_core_domain::{
    now_ms, DomainError, DomainResult, ErrorCode, FileEntryType, SftpFileEntry,
};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct SftpClient {
    session: Arc<SftpSession>,
}

impl SftpClient {
    pub fn new(session: SftpSession) -> Self {
        Self {
            session: Arc::new(session),
        }
    }

    pub fn session(&self) -> Arc<SftpSession> {
        Arc::clone(&self.session)
    }

    /// 列出目录下的所有条目。
    pub async fn read_dir(&self, path: &str) -> DomainResult<Vec<SftpFileEntry>> {
        let entries =
            self.session.read_dir(path).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("sftp read_dir failed: {e}"))
            })?;

        let mut result = Vec::new();
        for entry in entries {
            let filename = entry.file_name();
            if filename == "." || filename == ".." {
                continue;
            }
            let full_path = if path == "/" {
                format!("/{}", filename)
            } else if path.ends_with('/') {
                format!("{}{}", path, filename)
            } else {
                format!("{}/{}", path, filename)
            };

            let attrs = entry.metadata();
            let file_type = if attrs.is_dir() {
                FileEntryType::Directory
            } else if attrs.is_symlink() {
                FileEntryType::Symlink
            } else if attrs.is_regular() {
                FileEntryType::Regular
            } else {
                FileEntryType::Other
            };

            let permissions = attrs.permissions.unwrap_or(0);
            let size = attrs.size.unwrap_or(0);
            let modified_at = attrs
                .mtime
                .map(|m| (m as i64) * 1000)
                .unwrap_or_else(now_ms);
            let accessed_at = attrs
                .atime
                .map(|a| (a as i64) * 1000)
                .unwrap_or_else(now_ms);

            result.push(SftpFileEntry {
                name: filename,
                path: full_path,
                size,
                file_type,
                permissions,
                modified_at,
                accessed_at,
                uid: attrs.uid,
                gid: attrs.gid,
            });
        }

        // 排序：目录优先，同级按名称升序
        result.sort_by(|a, b| {
            let a_is_dir = matches!(a.file_type, FileEntryType::Directory);
            let b_is_dir = matches!(b.file_type, FileEntryType::Directory);
            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(result)
    }

    /// 查询指定路径属性。
    pub async fn stat(&self, path: &str) -> DomainResult<SftpFileEntry> {
        let attrs =
            self.session.metadata(path).await.map_err(|e| {
                DomainError::new(ErrorCode::NotFound, format!("sftp stat failed: {e}"))
            })?;

        let filename = path.rsplit('/').next().unwrap_or(path).to_string();
        let file_type = if attrs.is_dir() {
            FileEntryType::Directory
        } else if attrs.is_symlink() {
            FileEntryType::Symlink
        } else if attrs.is_regular() {
            FileEntryType::Regular
        } else {
            FileEntryType::Other
        };

        let permissions = attrs.permissions.unwrap_or(0);
        let size = attrs.size.unwrap_or(0);
        let modified_at = attrs
            .mtime
            .map(|m| (m as i64) * 1000)
            .unwrap_or_else(now_ms);
        let accessed_at = attrs
            .atime
            .map(|a| (a as i64) * 1000)
            .unwrap_or_else(now_ms);

        Ok(SftpFileEntry {
            name: filename,
            path: path.to_string(),
            size,
            file_type,
            permissions,
            modified_at,
            accessed_at,
            uid: attrs.uid,
            gid: attrs.gid,
        })
    }

    /// 创建目录。
    pub async fn mkdir(&self, path: &str) -> DomainResult<()> {
        self.session
            .create_dir(path)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp create_dir failed: {e}")))?;
        Ok(())
    }

    /// 删除目录。
    pub async fn remove_dir(&self, path: &str) -> DomainResult<()> {
        self.session
            .remove_dir(path)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp remove_dir failed: {e}")))?;
        Ok(())
    }

    /// 删除文件。
    pub async fn remove_file(&self, path: &str) -> DomainResult<()> {
        self.session.remove_file(path).await.map_err(|e| {
            DomainError::new(ErrorCode::Io, format!("sftp remove_file failed: {e}"))
        })?;
        Ok(())
    }

    /// 重命名或移动。
    pub async fn rename(&self, old_path: &str, new_path: &str) -> DomainResult<()> {
        self.session
            .rename(old_path, new_path)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp rename failed: {e}")))?;
        Ok(())
    }

    /// 修改权限。
    pub async fn set_permissions(&self, path: &str, mode: u32) -> DomainResult<()> {
        let mut meta =
            self.session.metadata(path).await.map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("sftp metadata failed: {e}"))
            })?;
        meta.permissions = Some(mode);
        self.session.set_metadata(path, meta).await.map_err(|e| {
            DomainError::new(ErrorCode::Io, format!("sftp set_metadata failed: {e}"))
        })?;
        Ok(())
    }

    /// 读取文件全部内容（带最大字节限制，适合远程编辑与查看）。
    pub async fn read_file_content(&self, path: &str, max_bytes: usize) -> DomainResult<Vec<u8>> {
        let mut file = self
            .session
            .open(path)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp open failed: {e}")))?;

        let mut buf = Vec::new();
        let mut take = (&mut file).take((max_bytes + 1) as u64);
        take.read_to_end(&mut buf)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp read failed: {e}")))?;

        if buf.len() > max_bytes {
            return Err(DomainError::new(
                ErrorCode::Validation,
                format!(
                    "file size exceeds maximum allowed buffer ({} bytes)",
                    max_bytes
                ),
            ));
        }

        Ok(buf)
    }

    /// 写入文件内容（覆盖或新建）。
    pub async fn write_file_content(&self, path: &str, content: &[u8]) -> DomainResult<()> {
        let mut file = self
            .session
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| {
                DomainError::new(ErrorCode::Io, format!("sftp open_with_flags failed: {e}"))
            })?;

        file.write_all(content)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp write failed: {e}")))?;
        file.flush()
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp flush failed: {e}")))?;

        Ok(())
    }
}
