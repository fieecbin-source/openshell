//! Anthropic Messages 适配器。
//!
//! - `POST {base}/messages`，鉴权使用 `x-api-key` 头，版本固定 `2023-06-01`。
//! - `system` 消息提取到顶层 `system`；`max_tokens` 为必填（缺省 1024）。
//! - 工具调用映射：`tool_use` ↔ `ToolCall`，`tool_result` ↔ `ChatMessage::tool`。

use crate::error::AiError;
use crate::provider::{ensure_success, http_error, send_guarded, SseDecoder};
use crate::types::{CancellationToken, CompletionRequest, Role, StreamEvent};
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use openshell_core_domain::AiWireKind;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;
use zeroize::Zeroizing;

/// Anthropic 默认 `max_tokens`（Messages API 要求必填）。
pub const DEFAULT_MAX_TOKENS: u32 = 1024;
/// 固定的 Anthropic API 版本头。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic Messages 协议适配器。
pub struct AnthropicProvider {
    base_url: String,
    api_key: Zeroizing<String>,
    client: reqwest::Client,
    timeout: Duration,
}

impl fmt::Debug for AnthropicProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicProvider")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl AnthropicProvider {
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
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        if !self.api_key.is_empty() {
            let mut value = HeaderValue::from_str(&self.api_key)
                .map_err(|_| crate::provider::invalid_api_key())?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_static("x-api-key"), value);
        }
        Ok(headers)
    }
}

#[async_trait]
impl crate::provider::LlmProvider for AnthropicProvider {
    fn wire(&self) -> AiWireKind {
        AiWireKind::AnthropicMessages
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, StreamEvent>, AiError> {
        let body = build_messages_body(&request);
        let builder = self
            .client
            .post(messages_url(&self.base_url))
            .headers(self.headers()?)
            .json(&body);

        let response = send_guarded(builder, &cancel, self.timeout).await?;
        let response = ensure_success(response).await?;
        let mut bytes = response.bytes_stream();

        let stream = async_stream::stream! {
            let mut decoder = SseDecoder::new();
            let mut state = AnthropicStreamState::default();
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

/// 拼接 Messages 端点。
pub fn messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = base.split('?').next().unwrap_or(base);
    if path.ends_with("/messages") {
        base.to_string()
    } else {
        crate::provider::join_url(base, "messages")
    }
}

/// 构造 Messages 请求体；API Key 不进入请求体。
pub fn build_messages_body(request: &CompletionRequest) -> Value {
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == Role::System)
        .map(|message| message.content.as_str())
        .filter(|content| !content.is_empty())
        .collect::<Vec<&str>>()
        .join("\n\n");

    let mut messages: Vec<Value> = Vec::new();
    for message in &request.messages {
        let (role, blocks) = match message.role {
            Role::System => continue,
            Role::User => (
                "user",
                vec![json!({"type": "text", "text": message.content})],
            ),
            Role::Assistant => {
                let mut blocks = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(json!({"type": "text", "text": message.content}));
                }
                for call in &message.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({"type": "text", "text": ""}));
                }
                ("assistant", blocks)
            }
            Role::Tool => (
                "user",
                vec![json!({
                    "type": "tool_result",
                    "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                    "content": message.content,
                })],
            ),
        };
        push_content(&mut messages, role, blocks);
    }

    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
        "messages": messages,
    });

    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
}

/// 合并相邻同角色消息，避免出现「连续 user」导致 Messages API 拒绝。
fn push_content(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(array) = last.get_mut("content").and_then(Value::as_array_mut) {
                array.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({ "role": role, "content": blocks }));
}

/// 流式解析状态：`message_start` 的输入 token 需要带到 `message_delta` 的用量里。
#[derive(Debug, Default)]
pub struct AnthropicStreamState {
    input_tokens: u64,
}

impl AnthropicStreamState {
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

        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut events = Vec::new();

        match event_type {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.input_tokens = usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let output_tokens = usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    events.push(StreamEvent::Usage {
                        input_tokens: self.input_tokens,
                        output_tokens,
                    });
                }
            }
            "content_block_start" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(block) = value.get("content_block") {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(text) = non_empty(block.get("text")) {
                                events.push(StreamEvent::TextDelta(text.to_string()));
                            }
                        }
                        "thinking" => {
                            if let Some(text) = non_empty(block.get("thinking")) {
                                events.push(StreamEvent::ReasoningDelta(text.to_string()));
                            }
                        }
                        "tool_use" => {
                            events.push(StreamEvent::ToolCallDelta {
                                index,
                                id: non_empty(block.get("id")).map(str::to_string),
                                name: non_empty(block.get("name")).map(str::to_string),
                                arguments_delta: String::new(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(delta) = value.get("delta") {
                    match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text_delta" => {
                            if let Some(text) = non_empty(delta.get("text")) {
                                events.push(StreamEvent::TextDelta(text.to_string()));
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = non_empty(delta.get("thinking")) {
                                events.push(StreamEvent::ReasoningDelta(text.to_string()));
                            }
                        }
                        "input_json_delta" => {
                            let partial = delta
                                .get("partial_json")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            events.push(StreamEvent::ToolCallDelta {
                                index,
                                id: None,
                                name: None,
                                arguments_delta: partial.to_string(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage") {
                    if let Some(input) = usage.get("input_tokens").and_then(Value::as_u64) {
                        self.input_tokens = input;
                    }
                    if let Some(output) = usage.get("output_tokens").and_then(Value::as_u64) {
                        events.push(StreamEvent::Usage {
                            input_tokens: self.input_tokens,
                            output_tokens: output,
                        });
                    }
                }
                if let Some(reason) = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                {
                    events.push(StreamEvent::Finish(map_stop_reason(reason)));
                }
            }
            "error" => return Err(http_error::classify_stream_error(&value.to_string())),
            // `message_stop` / `ping` 无需转发。
            _ => {}
        }

        if events.is_empty() {
            Ok(None)
        } else {
            Ok(Some(events))
        }
    }
}

fn map_stop_reason(reason: &str) -> String {
    match reason {
        "end_turn" | "stop_sequence" | "pause_turn" => "stop".to_string(),
        "max_tokens" => "length".to_string(),
        "tool_use" => "tool_calls".to_string(),
        other => other.to_string(),
    }
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::LlmProvider;
    use crate::types::{ChatMessage, StreamAccumulator, ToolCall, ToolSpec};

    fn sample_request() -> CompletionRequest {
        let mut request = CompletionRequest::new(
            "claude-sonnet-4-5",
            vec![
                ChatMessage::system("你是终端助手"),
                ChatMessage::system("回答保持简短"),
                ChatMessage::user("查看磁盘占用"),
            ],
        );
        request.tools = vec![ToolSpec {
            name: "exec".into(),
            description: "执行命令".into(),
            parameters: json!({"type": "object", "properties": {"cmd": {"type": "string"}}}),
        }];
        request
    }

    #[test]
    fn joins_messages_url() {
        assert_eq!(
            messages_url("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            messages_url("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            messages_url("https://proxy.example.com/anthropic/"),
            "https://proxy.example.com/anthropic/messages"
        );
    }

    #[test]
    fn lifts_system_and_defaults_max_tokens() {
        let body = build_messages_body(&sample_request());
        assert_eq!(body["system"], "你是终端助手\n\n回答保持简短");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
        assert_eq!(body["tools"][0]["name"], "exec");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert!(!body.to_string().contains("sk-"));
    }

    #[test]
    fn maps_tool_use_and_tool_result() {
        let mut assistant = ChatMessage::assistant("我来执行");
        assistant.tool_calls = vec![ToolCall {
            id: "toolu_1".into(),
            name: "exec".into(),
            arguments: json!({"cmd": "df -h"}),
        }];
        let request = CompletionRequest::new(
            "claude-sonnet-4-5",
            vec![
                ChatMessage::user("查看磁盘占用"),
                assistant,
                ChatMessage::tool("toolu_1", "12% used"),
            ],
        );
        let mut request = request;
        request.temperature = Some(0.2);
        let body = build_messages_body(&request);

        assert_eq!(body["messages"][1]["role"], "assistant");
        assert_eq!(body["messages"][1]["content"][0]["text"], "我来执行");
        assert_eq!(body["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(body["messages"][1]["content"][1]["id"], "toolu_1");
        assert_eq!(body["messages"][1]["content"][1]["input"]["cmd"], "df -h");
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "toolu_1");
        assert!((body["temperature"].as_f64().unwrap() - 0.2).abs() < 1e-6);
    }

    #[test]
    fn merges_consecutive_user_messages() {
        let request = CompletionRequest::new(
            "claude-sonnet-4-5",
            vec![
                ChatMessage::user("one"),
                ChatMessage::tool("toolu_9", "result"),
            ],
        );
        let body = build_messages_body(&request);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parses_message_start_text_and_finish() {
        let mut state = AnthropicStreamState::default();
        let start = state
            .parse(r#"{"type":"message_start","message":{"usage":{"input_tokens":21,"output_tokens":1}}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(
            start,
            vec![StreamEvent::Usage {
                input_tokens: 21,
                output_tokens: 1
            }]
        );

        let delta = state
            .parse(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(delta, vec![StreamEvent::TextDelta("你好".into())]);

        let thinking = state
            .parse(r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考"}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(thinking, vec![StreamEvent::ReasoningDelta("思考".into())]);

        let finish = state
            .parse(r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(
            finish,
            vec![
                StreamEvent::Usage {
                    input_tokens: 21,
                    output_tokens: 42
                },
                StreamEvent::Finish("stop".into()),
            ]
        );

        assert!(state.parse(r#"{"type":"message_stop"}"#).unwrap().is_none());
        assert!(state.parse("").unwrap().is_none());
    }

    #[test]
    fn accumulates_tool_use_fragments() {
        let mut state = AnthropicStreamState::default();
        let mut accumulator = StreamAccumulator::new();
        let payloads = [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec","input":{}}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"cmd\":"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls\"}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}"#,
        ];
        for payload in payloads {
            if let Some(events) = state.parse(payload).unwrap() {
                for event in events {
                    accumulator.push(event);
                }
            }
        }
        let response = accumulator.finish();
        assert_eq!(response.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(response.input_tokens, 9);
        assert_eq!(response.output_tokens, 8);
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "toolu_1");
        assert_eq!(response.tool_calls[0].arguments["cmd"], "ls");
    }

    #[test]
    fn error_event_is_classified() {
        let mut state = AnthropicStreamState::default();
        let payload = r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}"#;
        let error = state.parse(payload).unwrap_err();
        assert_eq!(error.code, crate::error::AiErrorCode::ContextTooLong);
    }

    #[test]
    fn provider_debug_never_leaks_key() {
        let provider = AnthropicProvider::new(
            "https://api.anthropic.com/v1",
            "sk-ant-secret",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(provider.wire(), AiWireKind::AnthropicMessages);
        let debug = format!("{provider:?}");
        assert!(!debug.contains("sk-ant-secret"));
        assert!(debug.contains("<redacted>"));
    }
}
