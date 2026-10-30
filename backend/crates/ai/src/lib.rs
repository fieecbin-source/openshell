//! `openshell-ai`：本地优先的 AI 终端助手后端。
//!
//! 模块划分：
//! - [`provider`]：LLM 协议适配器（OpenAI 兼容 / Anthropic / Gemini）与 SSE 解析。
//! - [`catalog`]：厂商目录快照与 Logo 资源。
//! - [`secrets`]：API Key 存储（系统凭据库优先，保险库加密文件回退）。
//! - [`service`]：配置编排、联通测试与可注入的 Provider 工厂契约。
//! - [`types`] / [`error`]：跨模块运行时契约与错误归一。
//!
//! 安全约束：任何模块都不得把 API Key 写入日志、`Debug` 输出或返回给前端。

pub mod catalog;
pub mod error;
pub mod provider;
pub mod secrets;
pub mod service;
pub mod types;

pub use error::{AiError, AiErrorCode};
pub use types::{
    CancellationToken, ChatMessage, CompletionRequest, CompletionResponse, Role, StreamAccumulator,
    StreamEvent, ToolCall, ToolSpec,
};
