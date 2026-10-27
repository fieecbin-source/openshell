//! 代理配置。
//!
//! 复用 reqwest 自带的系统代理探测能力（Windows 读取 Internet Settings 注册表、
//! macOS 读取系统网络配置、其他平台读取 `HTTPS_PROXY`/`ALL_PROXY` 环境变量），
//! 因此不需要额外依赖，也不会把代理凭据写到日志里。

use serde::{Deserialize, Serialize};

/// 代理模式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ProxyMode {
    /// 不使用代理（网络不通时由用户自行决定）。
    Off,
    /// 只使用环境变量里的代理。
    Env,
    /// 跟随系统代理（默认）。
    #[default]
    System,
    /// 手动指定代理地址，形如 `http://127.0.0.1:7890` 或 `socks5h://127.0.0.1:1080`。
    Custom { url: String },
}

impl ProxyMode {
    /// 用于展示的简短描述（不含任何凭据）。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Off => "direct",
            Self::Env => "env",
            Self::System => "system",
            Self::Custom { .. } => "custom",
        }
    }

    /// 用户自定义代理地址；仅 `Custom` 有值。
    pub fn custom_url(&self) -> Option<&str> {
        match self {
            Self::Custom { url } if !url.trim().is_empty() => Some(url.trim()),
            _ => None,
        }
    }
}

/// 代理地址的合法性检查：只接受 `http` / `https` / `socks5` / `socks5h` 且必须带 host。
pub fn validate_proxy_url(raw: &str) -> Result<(), String> {
    let trimmed = raw.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err("代理地址必须以 http:// 或 socks5:// 开头".to_string());
    };
    if !matches!(scheme, "http" | "https" | "socks5" | "socks5h") {
        return Err("代理协议只支持 http / https / socks5 / socks5h".to_string());
    }
    if rest.is_empty() || rest.starts_with('/') {
        return Err("代理地址缺少主机名".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_shape_matches_frontend_payload() {
        let off: ProxyMode = serde_json::from_str(r#"{"mode":"off"}"#).expect("parse off");
        assert_eq!(off, ProxyMode::Off);
        let custom: ProxyMode =
            serde_json::from_str(r#"{"mode":"custom","url":"socks5h://127.0.0.1:1080"}"#)
                .expect("parse custom");
        assert_eq!(custom.custom_url(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(ProxyMode::default(), ProxyMode::System);
    }

    #[test]
    fn validates_supported_proxy_schemes() {
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy_url("socks5://127.0.0.1:1080").is_ok());
        assert!(validate_proxy_url("ftp://127.0.0.1:21").is_err());
        assert!(validate_proxy_url("127.0.0.1:7890").is_err());
        assert!(validate_proxy_url("http://").is_err());
    }
}
