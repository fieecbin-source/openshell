//! AI 模块运行时契约：消息、工具调用、流式增量与取消令牌。
//!
//! 本文件是 Batch 0 的冻结契约，协议适配器 / 服务层 / 命令层共用。
//! 修改本文件需同步更新 `frontend/src/types/ai.ts`。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 轻量取消令牌：绑定 `Ctrl+C` 与超时，可跨任务克隆。
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    flag: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 等待取消或超时；返回 `true` 表示已取消。
    pub async fn cancelled_after(&self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if self.is_cancelled() {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let step = (deadline - now).min(Duration::from_millis(25));
            tokio::time::sleep(step).await;
        }
    }
}

/// 会话角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// 模型请求的工具调用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// 单条对话消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(call_id.into()),
            tool_calls: Vec::new(),
        }
    }
}

/// 暴露给模型的工具声明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema 对象。
    pub parameters: Value,
}

/// 一次补全请求。
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

impl CompletionRequest {
    pub fn new(model: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
        }
    }
}

/// 流式增量。适配器负责把三家协议的差异抹平到这里。
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// 正文增量。
    TextDelta(String),
    /// 推理/思考增量（若厂商提供）。
    ReasoningDelta(String),
    /// 工具调用增量；`arguments_delta` 为 JSON 片段，需要按 `index` 累积。
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    /// Token 用量（可选）。
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    /// 结束原因（`stop` / `length` / `tool_calls` 等）。
    Finish(String),
}

/// 一次性补全结果（测试连接与非流式调用使用）。
#[derive(Debug, Clone, Default)]
pub struct CompletionResponse {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// 由流式事件累积为完整结果。
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    response: CompletionResponse,
    tool_buffers: Vec<ToolCallBuffer>,
}

#[derive(Debug, Default)]
struct ToolCallBuffer {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::TextDelta(delta) => self.response.text.push_str(&delta),
            StreamEvent::ReasoningDelta(delta) => self.response.reasoning.push_str(&delta),
            StreamEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                if self.tool_buffers.len() <= index {
                    self.tool_buffers
                        .resize_with(index + 1, ToolCallBuffer::default);
                }
                let slot = &mut self.tool_buffers[index];
                if let Some(id) = id {
                    slot.id = Some(id);
                }
                if let Some(name) = name {
                    slot.name = Some(name);
                }
                slot.arguments.push_str(&arguments_delta);
            }
            StreamEvent::Usage {
                input_tokens,
                output_tokens,
            } => {
                self.response.input_tokens = input_tokens;
                self.response.output_tokens = output_tokens;
            }
            StreamEvent::Finish(reason) => self.response.finish_reason = Some(reason),
        }
    }

    pub fn finish(mut self) -> CompletionResponse {
        for (index, buffer) in self.tool_buffers.into_iter().enumerate() {
            let arguments = if buffer.arguments.trim().is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&buffer.arguments).unwrap_or_else(
                    |_| serde_json::json!({ "_raw": buffer.arguments, "_parse_error": true }),
                )
            };
            self.response.tool_calls.push(ToolCall {
                id: buffer.id.unwrap_or_else(|| format!("call_{index}")),
                name: buffer.name.unwrap_or_default(),
                arguments,
            });
        }
        self.response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_accumulator_merges_tool_call_fragments() {
        let mut acc = StreamAccumulator::new();
        acc.push(StreamEvent::TextDelta("hello ".into()));
        acc.push(StreamEvent::TextDelta("world".into()));
        acc.push(StreamEvent::ToolCallDelta {
            index: 0,
            id: Some("call_1".into()),
            name: Some("exec".into()),
            arguments_delta: "{\"cmd\":".into(),
        });
        acc.push(StreamEvent::ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments_delta: "\"ls\"}".into(),
        });
        acc.push(StreamEvent::Finish("tool_calls".into()));
        let response = acc.finish();
        assert_eq!(response.text, "hello world");
        assert_eq!(response.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call_1");
        assert_eq!(response.tool_calls[0].name, "exec");
        assert_eq!(response.tool_calls[0].arguments["cmd"], "ls");
    }

    #[tokio::test]
    async fn cancellation_token_observes_cancel() {
        let token = CancellationToken::new();
        let clone = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            clone.cancel();
        });
        assert!(token.cancelled_after(Duration::from_millis(500)).await);
        assert!(token.is_cancelled());
    }
}
