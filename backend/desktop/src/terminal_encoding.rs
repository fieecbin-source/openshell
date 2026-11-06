pub fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, &'static str> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Ok(text.as_bytes().to_vec()),
        "iso-8859-1" => text
            .chars()
            .map(|ch| u8::try_from(u32::from(ch)).map_err(|_| "输入无法用指定编码无损表示"))
            .collect(),
        "gbk" => encode_codepage(text, 936),
        "gb18030" => encode_codepage(text, 54936),
        "big5" => encode_codepage(text, 950),
        "shift_jis" | "shift-jis" => encode_codepage(text, 932),
        _ => Err("不支持的终端编码"),
    }
}

#[cfg(not(windows))]
fn encode_codepage(_: &str, _: u32) -> Result<Vec<u8>, &'static str> {
    Err("当前平台尚不支持该终端编码")
}

#[cfg(windows)]
fn encode_codepage(text: &str, codepage: u32) -> Result<Vec<u8>, &'static str> {
    #[link(name = "kernel32")]
    extern "system" {
        fn WideCharToMultiByte(
            codepage: u32,
            flags: u32,
            input: *const u16,
            input_len: i32,
            output: *mut u8,
            output_len: i32,
            default_char: *const u8,
            used_default: *mut i32,
        ) -> i32;
        fn MultiByteToWideChar(
            codepage: u32,
            flags: u32,
            input: *const u8,
            input_len: i32,
            output: *mut u16,
            output_len: i32,
        ) -> i32;
    }
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let input: Vec<u16> = text.encode_utf16().collect();
    let input_len = i32::try_from(input.len()).map_err(|_| "待编码文本过长")?;
    // A round trip rejects both replacement characters and Windows best-fit mappings.
    let bytes_len = unsafe {
        WideCharToMultiByte(
            codepage,
            0,
            input.as_ptr(),
            input_len,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if bytes_len <= 0 {
        return Err("终端编码转换失败");
    }
    let mut bytes = vec![0; bytes_len as usize];
    let written = unsafe {
        WideCharToMultiByte(
            codepage,
            0,
            input.as_ptr(),
            input_len,
            bytes.as_mut_ptr(),
            bytes_len,
            std::ptr::null(),
            std::ptr::null_mut(),
        )
    };
    if written != bytes_len {
        return Err("终端编码转换失败");
    }
    let mut decoded = vec![0; input.len()];
    let decoded_len = unsafe {
        MultiByteToWideChar(
            codepage,
            0,
            bytes.as_ptr(),
            bytes_len,
            decoded.as_mut_ptr(),
            input_len,
        )
    };
    if decoded_len != input_len || decoded != input {
        return Err("输入无法用指定编码无损表示");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn utf8_preserves_text_and_control_sequences() {
        assert_eq!(
            encode("中文\x1b[A\0", "UTF-8").unwrap(),
            "中文\x1b[A\0".as_bytes()
        );
    }

    #[test]
    fn latin1_is_exact_and_unrepresentable_text_fails() {
        assert_eq!(encode("é\u{80}", "iso-8859-1").unwrap(), [0xe9, 0x80]);
        assert!(encode("中文", "iso-8859-1").is_err());
        assert!(encode("hello", "unknown").is_err());
        assert!(encode("", "unknown").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_codepages_preserve_chinese_and_reject_loss() {
        assert_eq!(encode("中文", "gb18030").unwrap(), [0xd6, 0xd0, 0xce, 0xc4]);
        assert_eq!(encode("中文", "gbk").unwrap(), [0xd6, 0xd0, 0xce, 0xc4]);
        assert!(encode("中文😀", "gb18030").is_ok());
        assert!(encode("😀", "gbk").is_err());
        assert!(encode("😀", "big5").is_err());
        assert!(encode("😀", "shift_jis").is_err());
        assert!(encode("", "gb18030").unwrap().is_empty());
    }
}
