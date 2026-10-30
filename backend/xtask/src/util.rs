//! xtask 公共工具：工作目录定位与 SVG 安全校验。

use std::path::{Path, PathBuf};

/// OpenShell 自绘的赛博朋克风格 AI 核心图标（所有 Logo 缺失时的最终回退）。
pub const BUILTIN_LOGO: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none">
  <defs>
    <radialGradient id="os-core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ecfeff"/>
      <stop offset="45%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </radialGradient>
    <filter id="os-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <circle cx="32" cy="32" r="19" stroke="#22d3ee" stroke-width="1.5" opacity="0.45"/>
  <circle cx="32" cy="32" r="12" fill="url(#os-core)" filter="url(#os-glow)"/>
  <path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="#67e8f9" stroke-width="2" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="3.5" fill="#ffffff"/>
</svg>
"##;

pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 基本安全性校验：拒绝脚本、外部跳转与内联事件处理器。
pub fn is_safe_svg(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return false;
    }
    const BLOCKED: &[&str] = &[
        "<script",
        "javascript:",
        "<foreignobject",
        "<!entity",
        "<iframe",
        "<object",
        "<embed",
    ];
    if BLOCKED.iter().any(|needle| lower.contains(needle)) {
        return false;
    }
    !contains_inline_event(&lower)
}

fn contains_inline_event(lower: &str) -> bool {
    for (index, _) in lower.match_indices("on") {
        let preceded_by_space = lower[..index]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
        if !preceded_by_space {
            continue;
        }
        let rest = &lower[index + 2..];
        let name_len = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
        if name_len > 0 && rest.as_bytes().get(name_len) == Some(&b'=') {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_logo_is_clean_svg() {
        assert!(BUILTIN_LOGO.trim_start().starts_with("<svg"));
        assert!(is_safe_svg(BUILTIN_LOGO));
    }

    #[test]
    fn rejects_script_and_inline_events() {
        assert!(is_safe_svg(
            r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>"#
        ));
        assert!(!is_safe_svg("<svg><script>alert(1)</script></svg>"));
        assert!(!is_safe_svg("<svg><path onclick=\"x\"/></svg>"));
        assert!(!is_safe_svg("<svg><a href=\"javascript:alert(1)\"/></svg>"));
        assert!(!is_safe_svg("<svg onload=\"x\"></svg>"));
        assert!(!is_safe_svg("not an svg"));
    }
}
