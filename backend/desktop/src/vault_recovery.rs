use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use zeroize::Zeroizing;

fn password_text(buffer: &[u16]) -> DomainResult<Zeroizing<String>> {
    let length = buffer
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(buffer.len());
    let text = String::from_utf16(&buffer[..length])
        .map_err(|_| DomainError::validation("主密码格式无效"))?;
    if text.is_empty() {
        return Err(DomainError::validation("请输入主密码"));
    }
    Ok(Zeroizing::new(text))
}

#[cfg(windows)]
pub fn prompt() -> DomainResult<Zeroizing<String>> {
    use std::ffi::c_void;
    #[repr(C)]
    struct CredUiInfo {
        size: u32,
        owner: *mut c_void,
        message: *const u16,
        caption: *const u16,
        banner: *mut c_void,
    }
    #[link(name = "credui")]
    extern "system" {
        fn CredUIPromptForCredentialsW(
            info: *const CredUiInfo,
            target: *const u16,
            reserved: *mut c_void,
            error: u32,
            user: *mut u16,
            user_size: u32,
            password: *mut u16,
            password_size: u32,
            save: *mut i32,
            flags: u32,
        ) -> u32;
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let message = wide("输入保险库主密码以升级数据；尚未初始化时，此密码将用于创建保险库。");
    let caption = wide("OpenShell 数据恢复");
    let target = wide("OpenShell Vault Recovery");
    let info = CredUiInfo {
        size: std::mem::size_of::<CredUiInfo>() as u32,
        owner: std::ptr::null_mut(),
        message: message.as_ptr(),
        caption: caption.as_ptr(),
        banner: std::ptr::null_mut(),
    };
    let mut user = Zeroizing::new(vec![0u16; 514]);
    let label = wide("OpenShell");
    user[..label.len()].copy_from_slice(&label);
    let mut password = Zeroizing::new(vec![0u16; 514]);
    let mut save = 0;
    // Generic credentials with DO_NOT_PERSIST never touch Credential Manager.
    let result = unsafe {
        CredUIPromptForCredentialsW(
            &info,
            target.as_ptr(),
            std::ptr::null_mut(),
            0,
            user.as_mut_ptr(),
            user.len() as u32,
            password.as_mut_ptr(),
            password.len() as u32,
            &mut save,
            0x40000 | 0x80 | 0x2 | 0x8 | 0x100000,
        )
    };
    if result == 1223 {
        return Err(DomainError::new(ErrorCode::VaultLocked, "已取消数据恢复"));
    }
    if result != 0 {
        return Err(DomainError::new(ErrorCode::Io, "无法打开主密码输入窗口"));
    }
    password_text(&password)
}

#[cfg(not(windows))]
pub fn prompt() -> DomainResult<Zeroizing<String>> {
    Err(DomainError::new(
        ErrorCode::Unsupported,
        "请使用凭据恢复入口解锁旧数据库后再升级",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_decode_preserves_unicode_and_rejects_empty_or_invalid_utf16() {
        assert_eq!(
            password_text(&"密码😀\0unused".encode_utf16().collect::<Vec<_>>())
                .unwrap()
                .as_str(),
            "密码😀"
        );
        assert!(password_text(&[0]).is_err());
        assert!(password_text(&[0xd800, 0]).is_err());
    }
}
