//! OpenAI 兼容 Chat Completions 适配器。
//!
//! 覆盖 OpenAI / Azure OpenAI / OpenRouter / Ollama / LM Studio / DeepSeek / Moonshot 等
//! 所有实现 `POST {base}/chat/completions` + SSE 的服务。
//! API Key 只出现在 `Authorization` 请求头中，不进入请求体、日志或 `Debug` 输出。

use crate::error::AiError;
use crate::provider::{ensure_success, http_error, send_guarded, SseDecoder};
use crate::types::{CancellationToken, ChatMessage, CompletionRequest, StreamEvent};
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use openshell_core_domain::AiWireKind;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;
use zeroize::Zeroizing;

/// OpenAI 兼容协议适配器。
pub struct OpenAiCompatProvider {
    base_url: String,
    api_key: Zeroizing<String>,
    client: reqwest::Client,
    timeout: Duration,
}

impl fmt::Debug for OpenAiCompatProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiCompatProvider")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl OpenAiCompatProvider {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, AiError> {
        let base_url = crate::provider::validate_base_url(&base_url.into())?;
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
            let mut value = crate::provider::bearer_header(&self.api_key)?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        Ok(headers)
    }
}

#[async_trait]
impl crate::provider::LlmProvider for OpenAiCompatProvider {
    fn wire(&self) -> AiWireKind {
        AiWireKind::OpenAiChat
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, StreamEvent>, AiError> {
        let body = build_chat_body(&request, true);
        let builder = self
            .client
            .post(chat_completions_url(&self.base_url))
            .headers(self.headers()?)
            .json(&body);

        let response = send_guarded(builder, &cancel, self.timeout).await?;
        let response = ensure_success(response).await?;
        let mut bytes = response.bytes_stream();

        let stream = async_stream::stream! {
            let mut decoder = SseDecoder::new();
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
                    if event.is_done() {
                        finished = true;
                        break;
                    }
                    if cancel.is_cancelled() {
                        finished = true;
                        break;
                    }
                    match parse_stream_chunk(&event.data) {
                        Ok(Some(events)) => {
                            for item in events {
                                yield item;
                            }
                        }
                        Ok(None) => {}
                        // 流中夹带的错误无法通过事件通道回传，直接结束。
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

/// 拼接 Chat Completions 端点；兼容带 query 的 Azure 风格 base_url。
pub fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = base.split('?').next().unwrap_or(base);
    if path.ends_with("/chat/completions") {
        base.to_string()
    } else {
        crate::provider::join_url(base, "chat/completions")
    }
}

/// 构造请求体（`stream=true` 时附带 `stream_options.include_usage`）。
///
/// 该函数不接触 API Key：密钥只通过请求头传递。
pub fn build_chat_body(request: &CompletionRequest, stream: bool) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": request
            .messages
            .iter()
            .map(serialize_message)
            .collect::<Vec<Value>>(),
        "stream": stream,
    });

    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if stream {
        // 部分厂商不识别该字段；解析侧对缺失 usage 已做容错。
        body["stream_options"] = json!({ "include_usage": true });
    }
    body
}

fn serialize_message(message: &ChatMessage) -> Value {
    let mut value = json!({
        "role": message.role.as_str(),
        "content": message.content,
    });
    if !message.tool_calls.is_empty() {
        value["tool_calls"] = Value::Array(
            message
                .tool_calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": call.arguments.to_string(),
                        }
                    })
                })
                .collect(),
        );
    }
    if let Some(call_id) = &message.tool_call_id {
        value["tool_call_id"] = json!(call_id);
    }
    value
}

/// 解析单个 `data:` 负载。
///
/// - 返回 `Ok(None)` 表示 `[DONE]`、空负载或无法识别的 JSON（容错）。
/// - 返回 `Err` 表示流中夹带了错误事件，调用方应终止流。
pub fn parse_stream_chunk(data: &str) -> Result<Option<Vec<StreamEvent>>, AiError> {
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

    if let Some(usage) = parse_usage(&value) {
        events.push(usage);
    }

    if let Some(choice) = value.pointer("/choices/0") {
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = non_empty_str(delta.get("content")) {
                events.push(StreamEvent::TextDelta(text.to_string()));
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
                .filter(|segment| !segment.is_empty())
            {
                events.push(StreamEvent::ReasoningDelta(reasoning.to_string()));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for (position, call) in calls.iter().enumerate() {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                        .unwrap_or(position);
                    let id = non_empty_str(call.get("id")).map(str::to_string);
                    let function = call.get("function");
                    let name = function
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string);
                    let arguments = function
                        .and_then(|function| function.get("arguments"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if id.is_none() && name.is_none() && arguments.is_empty() {
                        continue;
                    }
                    events.push(StreamEvent::ToolCallDelta {
                        index,
                        id,
                        name,
                        arguments_delta: arguments.to_string(),
                    });
                }
            }
        }
        if let Some(reason) = non_empty_str(choice.get("finish_reason")) {
            events.push(StreamEvent::Finish(reason.to_string()));
        }
    }

    if events.is_empty() {
        Ok(None)
    } else {
        Ok(Some(events))
    }
}

fn parse_usage(value: &Value) -> Option<StreamEvent> {
    let usage = value.get("usage")?.as_object()?;
    let input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64);
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64);
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(StreamEvent::Usage {
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
    })
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::LlmProvider;
    use crate::types::{Role, StreamAccumulator, ToolCall, ToolSpec};

    fn sample_request() -> CompletionRequest {
        let mut request = CompletionRequest::new(
            "deepseek-chat",
            vec![
                ChatMessage::system("你是终端助手"),
                ChatMessage::user("列出当前目录"),
            ],
        );
        request.temperature = Some(0.3);
        request.max_tokens = Some(256);
        request.tools = vec![ToolSpec {
            name: "exec".into(),
            description: "执行命令".into(),
            parameters: json!({"type": "object", "properties": {"cmd": {"type": "string"}}}),
        }];
        request
    }

    #[test]
    fn joins_chat_completions_url() {
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:11434/v1/"),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url(
                "https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01"
            ),
            "https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01"
        );
    }

    #[test]
    fn builds_stream_body_with_tools_and_options() {
        let body = build_chat_body(&sample_request(), true);
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!((body["temperature"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        assert_eq!(body["max_tokens"], 256);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "列出当前目录");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "exec");
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");
        // 密钥绝不进入请求体。
        assert!(!body.to_string().contains("sk-"));
    }

    #[test]
    fn serializes_tool_calls_and_tool_results() {
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls = vec![ToolCall {
            id: "call_1".into(),
            name: "exec".into(),
            arguments: json!({"cmd": "ls"}),
        }];
        let request = CompletionRequest::new(
            "gpt-4o",
            vec![
                ChatMessage::user("hi"),
                assistant,
                ChatMessage::tool("call_1", "file.txt"),
            ],
        );
        let body = build_chat_body(&request, false);
        assert_eq!(body["messages"][1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(body["messages"][1]["tool_calls"][0]["type"], "function");
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["arguments"],
            "{\"cmd\":\"ls\"}"
        );
        assert_eq!(body["messages"][2]["role"], "tool");
        assert_eq!(body["messages"][2]["tool_call_id"], "call_1");
        assert!(body.get("stream_options").is_none());
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn parses_content_reasoning_and_finish() {
        let payload = r#"{"choices":[{"delta":{"content":"hello","reasoning_content":"think"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#;
        let events = parse_stream_chunk(payload).unwrap().unwrap();
        assert_eq!(
            events[0],
            StreamEvent::Usage {
                input_tokens: 12,
                output_tokens: 3
            }
        );
        assert_eq!(events[1], StreamEvent::TextDelta("hello".into()));
        assert_eq!(events[2], StreamEvent::ReasoningDelta("think".into()));
        assert_eq!(events[3], StreamEvent::Finish("stop".into()));
    }

    #[test]
    fn parses_fragmented_tool_call_deltas() {
        let first = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":"{\"cmd\":"}}]}}]}"#;
        let second = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}"#;
        let mut accumulator = StreamAccumulator::new();
        for payload in [first, second] {
            for event in parse_stream_chunk(payload).unwrap().unwrap() {
                accumulator.push(event);
            }
        }
        let response = accumulator.finish();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call_1");
        assert_eq!(response.tool_calls[0].name, "exec");
        assert_eq!(response.tool_calls[0].arguments["cmd"], "ls");
    }

    #[test]
    fn usage_only_chunk_is_parsed_without_choices() {
        let payload = r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}"#;
        let events = parse_stream_chunk(payload).unwrap().unwrap();
        assert_eq!(
            events,
            vec![StreamEvent::Usage {
                input_tokens: 7,
                output_tokens: 9
            }]
        );
    }

    #[test]
    fn ignores_done_empty_and_malformed_chunks() {
        assert!(parse_stream_chunk("[DONE]").unwrap().is_none());
        assert!(parse_stream_chunk("   ").unwrap().is_none());
        assert!(parse_stream_chunk("{not json").unwrap().is_none());
        assert!(parse_stream_chunk(r#"{"choices":[{"delta":{}}]}"#)
            .unwrap()
            .is_none());
    }

    #[test]
    fn stream_error_is_classified() {
        let payload = r#"{"error":{"message":"This model's maximum context length is 8192"}}"#;
        let error = parse_stream_chunk(payload).unwrap_err();
        assert_eq!(error.code, crate::error::AiErrorCode::ContextTooLong);
    }

    #[test]
    fn provider_wire_and_debug_never_leak_key() {
        let provider = OpenAiCompatProvider::new(
            "https://api.deepseek.com/v1",
            "sk-super-secret-value",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(provider.wire(), AiWireKind::OpenAiChat);
        let debug = format!("{provider:?}");
        assert!(!debug.contains("sk-super-secret-value"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn rejects_empty_base_url() {
        let error = OpenAiCompatProvider::new("   ", "sk-x", Duration::from_secs(5)).unwrap_err();
        assert_eq!(error.code, crate::error::AiErrorCode::Config);
    }

    #[test]
    fn message_roles_match_contract() {
        assert_eq!(Role::Tool.as_str(), "tool");
    }
}
