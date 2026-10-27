//! Release 说明的 Markdown → 安全 HTML。
//!
//! 安全模型是「白名单 + 双保险」：
//! 1. `pulldown-cmark` 只负责解析 Markdown，不做任何 HTML 透传决策；
//! 2. `ammonia` 按白名单重建 DOM，未知标签、事件属性、危险协议一律丢弃；
//! 3. 所有链接强制 `rel="noopener noreferrer"`，前端再拦截点击交给系统浏览器。
//!
//! 白名单刻意很小：标题、段落、列表、粗体/斜体、行内代码与代码块、链接、引用、分隔线。
//! 不支持 `style`/`class`/表格/图片，避免任何样式注入与远程资源加载。

use pulldown_cmark::{html, Options, Parser};
use std::collections::{HashMap, HashSet};

/// 允许的标签（其余一律删除，只保留其文本内容）。
const ALLOWED_TAGS: &[&str] = &[
    "h1",
    "h2",
    "h3",
    "h4",
    "p",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "a",
    "br",
    "hr",
];

/// 允许的属性：链接只保留 href / title。
const ALLOWED_LINK_ATTRS: &[&str] = &["href", "title"];

/// 链接只允许这两种协议（拒绝 `javascript:`、`data:`、`file:` 等）。
const ALLOWED_URL_SCHEMES: &[&str] = &["http", "https"];

/// 原始 Markdown 的最大长度（字符数），超出部分截断并在末尾给出提示。
pub const MAX_NOTES_CHARS: usize = 64 * 1024;

/// 把 Release 说明渲染成可直接插入 DOM 的 HTML。
///
/// 入参：任意 Markdown 文本（可为空、可为畸形语法、可能含恶意 HTML）。
/// 返回：白名单内的 HTML 片段；永不包含脚本、事件属性或危险协议链接。
pub fn render(markdown: &str) -> String {
    let (markdown, truncated) = truncate(markdown);
    let parser = Parser::new_ext(&markdown, Options::empty());
    let mut raw_html = String::new();
    html::push_html(&mut raw_html, parser);

    let mut sanitized = sanitizer().clean(&raw_html).to_string();
    if truncated {
        sanitized.push_str("<blockquote><p>…更新说明过长，已截断。</p></blockquote>");
    }
    sanitized
}

/// 只截断不渲染（导出/测试用）。
pub fn truncate(markdown: &str) -> (String, bool) {
    // 取第 MAX+1 个字符的字节位置作为截断点（按字符而不是字节，避免切坏 UTF-8）
    match markdown.char_indices().nth(MAX_NOTES_CHARS) {
        Some((index, _)) => (markdown[..index].to_string(), true),
        None => (markdown.to_string(), false),
    }
}

fn sanitizer() -> ammonia::Builder<'static> {
    let tags: HashSet<&'static str> = ALLOWED_TAGS.iter().copied().collect();
    let mut tag_attributes: HashMap<&'static str, HashSet<&'static str>> = HashMap::new();
    tag_attributes.insert("a", ALLOWED_LINK_ATTRS.iter().copied().collect());
    let url_schemes: HashSet<&'static str> = ALLOWED_URL_SCHEMES.iter().copied().collect();

    let mut builder = ammonia::Builder::default();
    builder
        .tags(tags)
        .tag_attributes(tag_attributes)
        .url_schemes(url_schemes)
        .link_rel(Some("noopener noreferrer"))
        .strip_comments(true)
        // 不保留任何 generic attribute（style/class/id/on* 全部丢弃）
        .generic_attributes(HashSet::new())
        .clean_content_tags(
            ["script", "style", "iframe", "object", "embed", "form"]
                .into_iter()
                .collect(),
        );
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_basic_markdown() {
        let html = render("## 更新亮点\n\n- 支持自动更新\n- 修复 **崩溃** 问题\n");
        assert!(html.contains("<h2>更新亮点</h2>"));
        assert!(html.contains("<li>支持自动更新</li>"));
        assert!(html.contains("<strong>崩溃</strong>"));
    }

    #[test]
    fn strips_script_tags() {
        let html = render("hello\n\n<script>alert('xss')</script>\n\nworld");
        assert!(!html.to_ascii_lowercase().contains("<script"));
        assert!(!html.to_ascii_lowercase().contains("alert("));
        assert!(html.contains("hello"));
        assert!(html.contains("world"));
    }

    /// 显式断言：图片标签**不在**白名单内。
    ///
    /// 放行 `img` 会让恶意说明通过 `src` 发起跨域请求（像素追踪、内网探测），
    /// 更新说明只需要文字与链接，因此这条必须长期钉死。
    #[test]
    fn img_is_not_allowed() {
        assert!(!ALLOWED_TAGS.contains(&"img"));
        let html = render("![tracking](https://evil.test/pixel.png)");
        assert!(!html.to_ascii_lowercase().contains("<img"), "{html}");
        assert!(!html.contains("pixel.png"), "{html}");
    }

    #[test]
    fn strips_inline_event_handlers() {
        let html = render("text <img src=x onerror=alert(1)> and <b onclick=\"evil()\">bold</b>");
        assert!(!html.to_ascii_lowercase().contains("onerror"));
        assert!(!html.to_ascii_lowercase().contains("onclick"));
        assert!(!html.to_ascii_lowercase().contains("<img"));
        assert!(html.contains("bold"));
    }

    #[test]
    fn rejects_javascript_and_data_links() {
        let html =
            render("[点我](javascript:alert(1)) 和 [数据](data:text/html;base64,PHNjcmlwdD4=)");
        assert!(!html.to_ascii_lowercase().contains("javascript:"));
        assert!(!html.to_ascii_lowercase().contains("data:text/html"));
    }

    #[test]
    fn keeps_https_links_with_safe_rel() {
        let html = render("详见 [Release](https://github.com/a/b/releases)");
        assert!(html.contains("href=\"https://github.com/a/b/releases\""));
        assert!(html.contains("rel=\"noopener noreferrer\""));
    }

    #[test]
    fn strips_iframe_and_style() {
        let html = render(
            "<iframe src=\"https://evil.test\"></iframe><style>body{display:none}</style>正文",
        );
        let lower = html.to_ascii_lowercase();
        assert!(!lower.contains("<iframe"));
        assert!(!lower.contains("<style"));
        assert!(!lower.contains("display:none"));
        assert!(html.contains("正文"));
    }

    #[test]
    fn survives_malformed_markdown() {
        let html =
            render("[未闭合链接(https://a.test **粗体 `代码 表格 | 管道\n\n```\n未闭合代码块");
        // 不 panic 即可，且不允许输出危险内容
        assert!(!html.to_ascii_lowercase().contains("<script"));
    }

    #[test]
    fn truncates_oversized_notes() {
        let long = "a".repeat(MAX_NOTES_CHARS + 100);
        let (truncated, was_truncated) = truncate(&long);
        assert!(was_truncated);
        assert_eq!(truncated.chars().count(), MAX_NOTES_CHARS);
        assert!(render(&long).contains("已截断"));
    }

    #[test]
    fn empty_notes_render_empty() {
        assert_eq!(render(""), "");
    }
}
