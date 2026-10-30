//! Google Gemini `generateContent` 适配器。
//!
//! - 端点：`POST {base}/models/{model}:streamGenerateContent?alt=sse&key=...`
//! - base 默认 `https://generativelanguage.googleapis.com/v1beta`；
//!   若传入的 base 缺少版本段则自动补 `/v1beta`。
//! - `contents` 使用 `user` / `model` 角色；system 消息走 `systemInstruction`。

use crate::error::AiError;
use crate::provider::{ensure_success, http_error, send_guarded, SseDecoder};
use crate::types::{CancellationToken, CompletionRequest, Role, StreamEvent};
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use openshell_core_domain::AiWireKind;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;
use zeroize::Zeroizing;

/// Gemini 官方默认 base。
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Gemini generateContent 协议适配器。
pub struct GeminiProvider {
    base_url: String,
    api_key: Zeroizing<String>,
    client: reqwest::Client,
    timeout: Duration,
}

impl fmt::Debug for GeminiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GeminiProvider")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl GeminiProvider {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, AiError> {
        let base_url = crate::provider::validate_base_url(&normalize_base(&base_url.into()))?;
        let api_key = Zeroizing::new(api_key.into());
        if !api_key.is_empty() {
            crate::provider::validate_api_key(&api_key)?;
        }
        let client = crate::provider::default_client(timeout)?;
        Ok(Self {
            base_url,
            api_key,
            client,
            timeout,
        })
    }

    fn headers(&self) -> Result<HeaderMap, AiError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        if !self.api_key.is_empty() {
            let mut value = HeaderValue::from_str(&self.api_key)
                .map_err(|_| crate::provider::invalid_api_key())?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_static("x-goog-api-key"), value);
        }
        Ok(headers)
    }
}

#[async_trait]
impl crate::provider::LlmProvider for GeminiProvider {
    fn wire(&self) -> AiWireKind {
        AiWireKind::GeminiGenerateContent
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, StreamEvent>, AiError> {
        let body = build_generate_body(&request);
        let builder = self
            .client
            .post(stream_url(&self.base_url, &request.model, &self.api_key))
            .headers(self.headers()?)
            .json(&body);

        let response = send_guarded(builder, &cancel, self.timeout).await?;
        let response = ensure_success(response).await?;
        let mut bytes = response.bytes_stream();

        let stream = async_stream::stream! {
            let mut decoder = SseDecoder::new();
            let mut state = GeminiStreamState::default();
            let mut finished = false;

            while !finished {
                if cancel.is_cancelled() {
                    break;
                }
                let Some(item) = bytes.next().await else {
                    break;
                };
                let chunk = match item {
                    Ok(chunk) => chunk,
                    Err(_) => break,
                };

                for event in decoder.push(chunk.as_ref()) {
                    if cancel.is_cancelled() {
                        finished = true;
                        break;
                    }
                    match state.parse(&event.data) {
                        Ok(Some(events)) => {
                            for item in events {
                                yield item;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {
                            finished = true;
                            break;
                        }
                    }
                }
            }
        };

        Ok(Box::pin(stream))
    }
}

/// 规范化 base：空值取官方默认；缺少版本段时补 `/v1beta`。
pub fn normalize_base(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return DEFAULT_BASE_URL.to_string();
    }
    let last = base.rsplit('/').next().unwrap_or("");
    if is_version_segment(last) {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
}

fn is_version_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    if chars.next() != Some('v') {
        return false;
    }
    let rest = chars.as_str();
    !rest.is_empty()
        && rest
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 构造流式端点；`key` 仅出现在 query（以及请求头）中，绝不进入请求体。
pub fn stream_url(base_url: &str, model: &str, api_key: &str) -> String {
    let base = normalize_base(base_url);
    let model = model.trim().trim_start_matches("models/");
    let mut url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");
    if !api_key.is_empty() {
        url.push_str("&key=");
        url.push_str(&percent_encode(api_key));
    }
    url
}

fn percent_encode(value: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 构造 generateContent 请求体；API Key 不进入请求体。
pub fn build_generate_body(request: &CompletionRequest) -> Value {
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == Role::System)
        .map(|message| message.content.as_str())
        .filter(|content| !content.is_empty())
        .collect::<Vec<&str>>()
        .join("\n\n");

    let tool_names: HashMap<&str, &str> = request
        .messages
        .iter()
        .flat_map(|message| message.tool_calls.iter())
        .map(|call| (call.id.as_str(), call.name.as_str()))
        .collect();

    let mut contents: Vec<Value> = Vec::new();
    for message in &request.messages {
        let (role, parts) = match message.role {
            Role::System => continue,
            Role::User => ("user", vec![json!({ "text": message.content })]),
            Role::Assistant => {
                let mut parts = Vec::new();
                if !message.content.is_empty() {
                    parts.push(json!({ "text": message.content }));
                }
                for call in &message.tool_calls {
                    parts.push(json!({
                        "functionCall": {
                            "name": call.name,
                            "args": call.arguments,
                        }
                    }));
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": "" }));
                }
                ("model", parts)
            }
            Role::Tool => {
                let name = message
                    .tool_call_id
                    .as_deref()
                    .and_then(|id| tool_names.get(id).copied())
                    .unwrap_or("tool");
                (
                    "user",
                    vec![json!({
                        "functionResponse": {
                            "name": name,
                            "response": { "result": message.content },
                        }
                    })],
                )
            }
        };
        push_parts(&mut contents, role, parts);
    }

    let mut body = json!({ "contents": contents });

    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(vec![json!({
            "functionDeclarations": request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    })
                })
                .collect::<Vec<Value>>(),
        })]);
    }

    let mut generation = serde_json::Map::new();
    if let Some(temperature) = request.temperature {
        generation.insert("temperature".into(), json!(temperature));
    }
    if let Some(max_tokens) = request.max_tokens {
        generation.insert("maxOutputTokens".into(), json!(max_tokens));
    }
    if !generation.is_empty() {
        body["generationConfig"] = Value::Object(generation);
    }

    body
}

/// 相邻同角色内容合并（Gemini 要求同一轮的多段 parts 合并到一个 content）。
fn push_parts(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(array) = last.get_mut("parts").and_then(Value::as_array_mut) {
                array.extend(parts);
                return;
            }
        }
    }
    contents.push(json!({ "role": role, "parts": parts }));
}

/// Gemini 流式解析状态：`functionCall` 没有 index/id，需要本地递增。
#[derive(Debug, Default)]
pub struct GeminiStreamState {
    next_tool_index: usize,
}

impl GeminiStreamState {
    /// 解析单个 SSE `data:` 负载。
    pub fn parse(&mut self, data: &str) -> Result<Option<Vec<StreamEvent>>, AiError> {
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return Ok(None);
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if value.get("error").is_some_and(|error| !error.is_null()) {
            return Err(http_error::classify_stream_error(&value.to_string()));
        }

        let mut events = Vec::new();

        if let Some(usage) = value.get("usageMetadata") {
            let input_tokens = usage
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output_tokens = usage
                .get("candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            events.push(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            });
        }

        if let Some(candidate) = value.pointer("/candidates/0") {
            if let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        let thought = part
                            .get("thought")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if thought {
                            events.push(StreamEvent::ReasoningDelta(text.to_string()));
                        } else {
                            events.push(StreamEvent::TextDelta(text.to_string()));
                        }
                    }
                    if let Some(call) = part.get("functionCall") {
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                        if !name.is_empty() {
                            let arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                            let index = self.next_tool_index;
                            self.next_tool_index += 1;
                            events.push(StreamEvent::ToolCallDelta {
                                index,
                                id: None,
                                name: Some(name.to_string()),
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
            }
            if let Some(reason) = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .filter(|reason| *reason != "FINISH_REASON_UNSPECIFIED")
            {
                events.push(StreamEvent::Finish(map_finish_reason(reason)));
            }
        }

        if events.is_empty() {
            Ok(None)
        } else {
            Ok(Some(events))
        }
    }
}

fn map_finish_reason(reason: &str) -> String {
    match reason {
        "STOP" => "stop".to_string(),
        "MAX_TOKENS" => "length".to_string(),
        "SAFETY" => "safety".to_string(),
        "RECITATION" => "recitation".to_string(),
        other => other.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::LlmProvider;
    use crate::types::{ChatMessage, StreamAccumulator, ToolCall, ToolSpec};

    fn sample_request() -> CompletionRequest {
        let mut request = CompletionRequest::new(
            "gemini-2.5-flash",
            vec![
                ChatMessage::system("你是终端助手"),
                ChatMessage::user("查看端口占用"),
            ],
        );
        request.temperature = Some(0.4);
        request.max_tokens = Some(512);
        request.tools = vec![ToolSpec {
            name: "exec".into(),
            description: "执行命令".into(),
            parameters: json!({"type": "object", "properties": {"cmd": {"type": "string"}}}),
        }];
        request
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(normalize_base(""), DEFAULT_BASE_URL);
        assert_eq!(
            normalize_base("https://generativelanguage.googleapis.com"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            normalize_base("https://generativelanguage.googleapis.com/v1beta/"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            normalize_base("https://proxy.example.com/gemini"),
            "https://proxy.example.com/gemini/v1beta"
        );
        assert_eq!(
            normalize_base("https://proxy.example.com/v1"),
            "https://proxy.example.com/v1"
        );
    }

    #[test]
    fn builds_stream_url_with_key_and_model_prefix() {
        let url = stream_url("", "models/gemini-2.5-flash", "AIza-test_key");
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=AIza-test_key"
        );
        let url = stream_url("https://proxy.example.com/v1beta", "gemini-2.5-pro", "a/b");
        assert!(url.ends_with("?alt=sse&key=a%2Fb"));
    }

    #[test]
    fn builds_body_with_system_tools_and_generation_config() {
        let body = build_generate_body(&sample_request());
        assert_eq!(body["contents"].as_array().unwrap().len(), 1);
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "查看端口占用");
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            "你是终端助手"
        );
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "exec");
        assert!((body["generationConfig"]["temperature"].as_f64().unwrap() - 0.4).abs() < 1e-6);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 512);
        assert!(!body.to_string().contains("AIza"));
    }

    #[test]
    fn maps_assistant_tool_calls_and_responses_to_model_name() {
        let mut assistant = ChatMessage::assistant("马上执行");
        assistant.tool_calls = vec![ToolCall {
            id: "call_1".into(),
            name: "exec".into(),
            arguments: json!({"cmd": "ss -lnt"}),
        }];
        let request = CompletionRequest::new(
            "gemini-2.5-flash",
            vec![
                ChatMessage::user("查看端口"),
                assistant,
                ChatMessage::tool("call_1", "80/tcp"),
            ],
        );
        let body = build_generate_body(&request);
        assert_eq!(body["contents"][1]["role"], "model");
        assert_eq!(body["contents"][1]["parts"][0]["text"], "马上执行");
        assert_eq!(
            body["contents"][1]["parts"][1]["functionCall"]["name"],
            "exec"
        );
        assert_eq!(body["contents"][2]["role"], "user",);
        assert_eq!(
            body["contents"][2]["parts"][0]["functionResponse"]["name"],
            "exec"
        );
        assert_eq!(
            body["contents"][2]["parts"][0]["functionResponse"]["response"]["result"],
            "80/tcp"
        );
    }

    #[test]
    fn parses_text_function_call_finish_and_usage() {
        let mut state = GeminiStreamState::default();
        let payload = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"你好"},{"functionCall":{"name":"exec","args":{"cmd":"ls"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":5}}"#;
        let events = state.parse(payload).unwrap().unwrap();
        assert_eq!(
            events[0],
            StreamEvent::Usage {
                input_tokens: 11,
                output_tokens: 5
            }
        );
        assert_eq!(events[1], StreamEvent::TextDelta("你好".into()));
        match &events[2] {
            StreamEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                assert_eq!(*index, 0);
                assert!(id.is_none());
                assert_eq!(name.as_deref(), Some("exec"));
                assert_eq!(arguments_delta, "{\"cmd\":\"ls\"}");
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert_eq!(events[3], StreamEvent::Finish("stop".into()));
    }

    #[test]
    fn thought_parts_become_reasoning_and_indices_increment() {
        let mut state = GeminiStreamState::default();
        let first = state
            .parse(r#"{"candidates":[{"content":{"parts":[{"text":"推理","thought":true},{"functionCall":{"name":"a","args":{}}}]}}]}"#)
            .unwrap()
            .unwrap();
        assert_eq!(first[0], StreamEvent::ReasoningDelta("推理".into()));
        let second = state
            .parse(r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"b","args":{}}}]}}]}"#)
            .unwrap()
            .unwrap();
        match &second[0] {
            StreamEvent::ToolCallDelta { index, .. } => assert_eq!(*index, 1),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn accumulates_stream_into_completion() {
        let mut state = GeminiStreamState::default();
        let mut accumulator = StreamAccumulator::new();
        let payloads = [
            r#"{"candidates":[{"content":{"parts":[{"text":"part1"}]}}]}"#,
            r#"{"candidates":[{"content":{"parts":[{"text":"part2"},{"functionCall":{"name":"exec","args":{"cmd":"pwd"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}"#,
        ];
        for payload in payloads {
            for event in state.parse(payload).unwrap().unwrap() {
                accumulator.push(event);
            }
        }
        let response = accumulator.finish();
        assert_eq!(response.text, "part1part2");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.input_tokens, 3);
        assert_eq!(response.output_tokens, 4);
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "exec");
        assert_eq!(response.tool_calls[0].arguments["cmd"], "pwd");
    }

    #[test]
    fn provider_debug_never_leaks_key_and_rejects_bad_base() {
        let provider = GeminiProvider::new("", "AIza-secret", Duration::from_secs(5)).unwrap();
        assert_eq!(provider.wire(), AiWireKind::GeminiGenerateContent);
        let debug = format!("{provider:?}");
        assert!(!debug.contains("AIza-secret"));
        assert!(debug.contains("<redacted>"));

        let error =
            GeminiProvider::new("ftp://example.com", "k", Duration::from_secs(5)).unwrap_err();
        assert_eq!(error.code, crate::error::AiErrorCode::Config);
    }

    #[test]
    fn stream_error_is_classified() {
        let mut state = GeminiStreamState::default();
        let error = state
            .parse(r#"{"error":{"code":400,"message":"API key not valid"}}"#)
            .unwrap_err();
        assert_eq!(error.code, crate::error::AiErrorCode::Server);
    }
}
