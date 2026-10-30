//! HTTP 状态码 / 传输层异常归一为 `AiError`。
//!
//! 全部 `message` 都是可直接展示给用户的中文短句。
//! 原始响应体不会全文回显，最多截断 160 字符并掩码疑似密钥片段。

use crate::error::{AiError, AiErrorCode};
use std::sync::OnceLock;

pub const AUTH_MESSAGE: &str = "API Key 无效或没有访问权限，请检查密钥";
pub const RATE_LIMIT_MESSAGE: &str = "请求过于频繁，已触发厂商限流，请稍后重试";
pub const MODEL_NOT_FOUND_MESSAGE: &str = "模型不存在或当前账号无权访问该模型";
pub const SERVER_MESSAGE: &str = "模型服务暂时不可用（HTTP 5xx），请稍后重试";
pub const TIMEOUT_MESSAGE: &str = "连接模型服务超时，请检查网络或调大超时时间";
pub const NETWORK_MESSAGE: &str = "无法连接模型服务，请检查网络或接口地址";
pub const CERTIFICATE_MESSAGE: &str = "TLS 证书校验失败，请检查代理或自定义证书";
pub const CONTEXT_TOO_LONG_MESSAGE: &str = "上下文超出模型限制，请清理历史或更换更大上下文的模型";
pub const CANCELLED_MESSAGE: &str = "已取消本次模型请求";
pub const BAD_REQUEST_MESSAGE: &str = "请求参数不符合模型服务要求，请检查模型与参数设置";
pub const STREAM_ERROR_MESSAGE: &str = "模型服务返回错误，请稍后重试";

/// 用户取消。
pub fn cancelled() -> AiError {
    AiError::new(AiErrorCode::Cancelled, CANCELLED_MESSAGE)
}

/// 请求超时。
pub fn timeout() -> AiError {
    AiError::new(AiErrorCode::Timeout, TIMEOUT_MESSAGE)
}

/// 根据 HTTP 状态码与响应体归类错误。
pub fn classify_status(status: u16, body: &str) -> AiError {
    let lower = body.to_lowercase();

    // 上下文超长经常以 400 返回，且文案优先级高于 BadRequest。
    if looks_like_context_too_long(&lower) {
        return AiError::new(AiErrorCode::ContextTooLong, CONTEXT_TOO_LONG_MESSAGE)
            .with_status(status);
    }
    if status == 404 || looks_like_model_missing(&lower) {
        return AiError::new(AiErrorCode::ModelNotFound, MODEL_NOT_FOUND_MESSAGE)
            .with_status(status);
    }

    match status {
        401 | 403 => AiError::new(AiErrorCode::Auth, AUTH_MESSAGE).with_status(status),
        429 => AiError::new(AiErrorCode::RateLimit, RATE_LIMIT_MESSAGE).with_status(status),
        400..=499 => {
            let snippet = extract_error_message(body)
                .map(|message| sanitize_snippet(&message, 160))
                .filter(|message| !message.is_empty());
            let message = match snippet {
                Some(detail) => format!("请求参数不符合模型服务要求：{detail}"),
                None => BAD_REQUEST_MESSAGE.to_string(),
            };
            AiError::new(AiErrorCode::BadRequest, message).with_status(status)
        }
        _ => AiError::new(AiErrorCode::Server, SERVER_MESSAGE).with_status(status),
    }
}

/// 流式响应中夹带的错误事件（`{"error": ...}`）归一。
pub fn classify_stream_error(body: &str) -> AiError {
    let lower = body.to_lowercase();
    if looks_like_context_too_long(&lower) {
        AiError::new(AiErrorCode::ContextTooLong, CONTEXT_TOO_LONG_MESSAGE)
    } else if looks_like_model_missing(&lower) {
        AiError::new(AiErrorCode::ModelNotFound, MODEL_NOT_FOUND_MESSAGE)
    } else {
        AiError::new(AiErrorCode::Server, STREAM_ERROR_MESSAGE)
    }
}

/// 从错误响应体中提取厂商给出的错误描述（可能为空）。
pub fn extract_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let candidates = [
        value.pointer("/error/message"),
        value.pointer("/error/errors/0/message"),
        value.pointer("/message"),
        value.get("error"),
    ];
    candidates
        .iter()
        .flatten()
        .find_map(|candidate| candidate.as_str())
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty())
}

/// 响应体是否在提示模型不存在 / 无权访问。
pub fn looks_like_model_missing(lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "model not found",
        "model_not_found",
        "no such model",
        "unknown model",
        "invalid model",
        "model does not exist",
        "model_not_supported",
        "model is not supported",
        "does not exist",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// 响应体是否在提示上下文超长。
pub fn looks_like_context_too_long(lower: &str) -> bool {
    const MARKERS: &[&str] = &[
        "context_length_exceeded",
        "maximum context",
        "context length",
        "context window",
        "too many tokens",
        "prompt is too long",
        "input is too long",
        "exceed the maximum",
        "exceeds the maximum",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// 归类 `reqwest` 传输层错误：超时 / 证书 / DNS / 连接失败。
pub fn classify_reqwest(err: &reqwest::Error) -> AiError {
    if err.is_timeout() {
        return timeout();
    }
    let mut detail = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        detail.push_str(" | ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    classify_transport_detail(&detail)
}

/// 根据传输层错误文本归类（单独暴露以便单测，不依赖真实网络）。
pub fn classify_transport_detail(detail: &str) -> AiError {
    let lower = detail.to_lowercase();
    if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("unknownissuer")
    {
        return AiError::new(AiErrorCode::Certificate, CERTIFICATE_MESSAGE);
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return timeout();
    }
    AiError::network(NETWORK_MESSAGE)
}

/// 截断并掩码后的响应片段，可安全拼进用户文案。
pub fn sanitize_snippet(text: &str, max_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let masked = mask_secrets(&collapsed);
    if masked.chars().count() <= max_chars {
        return masked;
    }
    let truncated: String = masked.chars().take(max_chars).collect();
    format!("{truncated}…")
}

fn mask_secrets(text: &str) -> String {
    secret_pattern().replace_all(text, "<已隐藏>").into_owned()
}

fn secret_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(sk-[a-z0-9_\-]{4,}|aiza[0-9a-z_\-]{8,}|bearer\s+[a-z0-9._\-]{8,}|(?:x-api-key|api[_-]?key)\s*[:=]\s*\S+)",
        )
        .expect("密钥掩码正则合法")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(error: &AiError) -> AiErrorCode {
        error.code
    }

    #[test]
    fn maps_auth_statuses() {
        assert_eq!(code_of(&classify_status(401, "")), AiErrorCode::Auth);
        assert_eq!(
            code_of(&classify_status(403, "forbidden")),
            AiErrorCode::Auth
        );
        assert_eq!(
            classify_status(401, "").message,
            "API Key 无效或没有访问权限，请检查密钥"
        );
    }

    #[test]
    fn maps_rate_limit() {
        let error = classify_status(429, "slow down");
        assert_eq!(error.code, AiErrorCode::RateLimit);
        assert!(error.retryable);
    }

    #[test]
    fn maps_model_not_found_by_status_and_body() {
        assert_eq!(
            code_of(&classify_status(404, "")),
            AiErrorCode::ModelNotFound
        );
        let body = r#"{"error":{"message":"The model `gpt-9` does not exist"}}"#;
        assert_eq!(
            code_of(&classify_status(400, body)),
            AiErrorCode::ModelNotFound
        );
        let body = r#"{"error":{"message":"model not found"}}"#;
        assert_eq!(
            code_of(&classify_status(400, body)),
            AiErrorCode::ModelNotFound
        );
    }

    #[test]
    fn maps_server_errors() {
        let error = classify_status(503, "upstream down");
        assert_eq!(error.code, AiErrorCode::Server);
        assert_eq!(error.status, Some(503));
        assert!(error.retryable);
    }

    #[test]
    fn maps_context_too_long() {
        let body = r#"{"error":{"message":"This model's maximum context length is 4096 tokens","code":"context_length_exceeded"}}"#;
        assert_eq!(
            code_of(&classify_status(400, body)),
            AiErrorCode::ContextTooLong
        );
        assert_eq!(
            classify_status(400, body).message,
            "上下文超出模型限制，请清理历史或更换更大上下文的模型"
        );
        let anthropic = r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}"#;
        assert_eq!(
            code_of(&classify_status(400, anthropic)),
            AiErrorCode::ContextTooLong
        );
    }

    #[test]
    fn bad_request_is_truncated_and_masked() {
        let body = format!(
            r#"{{"error":{{"message":"bad key sk-abcdef1234567890 {}"}}}}"#,
            "x".repeat(400)
        );
        let error = classify_status(400, &body);
        assert_eq!(error.code, AiErrorCode::BadRequest);
        assert!(!error.message.contains("sk-abcdef1234567890"));
        assert!(error.message.chars().count() < 220);
    }

    #[test]
    fn transport_detail_maps_certificate_timeout_and_network() {
        assert_eq!(
            code_of(&classify_transport_detail(
                "error sending request: invalid peer certificate: UnknownIssuer"
            )),
            AiErrorCode::Certificate
        );
        assert_eq!(
            code_of(&classify_transport_detail("operation timed out")),
            AiErrorCode::Timeout
        );
        assert_eq!(
            code_of(&classify_transport_detail(
                "dns error: failed to lookup address"
            )),
            AiErrorCode::Network
        );
        assert_eq!(
            code_of(&classify_transport_detail("connection reset by peer")),
            AiErrorCode::Network
        );
        assert_eq!(timeout().code, AiErrorCode::Timeout);
        assert_eq!(cancelled().code, AiErrorCode::Cancelled);
    }

    #[test]
    fn extracts_nested_error_message() {
        let body = r#"{"error":{"message":"invalid api key"}}"#;
        assert_eq!(
            extract_error_message(body).as_deref(),
            Some("invalid api key")
        );
        let gemini =
            r#"{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(
            extract_error_message(gemini).as_deref(),
            Some("API key not valid")
        );
        assert_eq!(extract_error_message("not json"), None);
    }
}
