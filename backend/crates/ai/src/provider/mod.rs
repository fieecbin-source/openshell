//! LLM 协议适配器（Batch 1 Agent A 实现）。
//!
//! 三家线格式共用同一份运行时契约：
//! - [`LlmProvider::stream`] 把厂商 SSE 事件抹平为 [`crate::types::StreamEvent`]；
//! - [`LlmProvider::complete`] 默认实现通过 [`crate::types::StreamAccumulator`] 收敛为完整结果，
//!   联通测试与工具调用场景可直接复用；
//! - [`create_provider`] 是服务层唯一入口。
//!
//! 安全约束：
//! - API Key 使用 `Zeroizing<String>` 保存，所有 Provider 手写 `Debug` 并掩码；
//! - Key 只出现在请求头（Gemini 额外出现在 query，这是其协议要求），绝不进入请求体或错误文案；
//! - 仅使用 reqwest + rustls，不提供关闭证书校验的开关。

pub mod anthropic;
pub mod gemini;
pub mod http_error;
pub mod openai_compat;
pub mod sse;

use crate::error::AiError;
use crate::types::{
    CancellationToken, CompletionRequest, CompletionResponse, StreamAccumulator, StreamEvent,
};
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use openshell_core_domain::AiWireKind;
use reqwest::header::HeaderValue;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use openai_compat::OpenAiCompatProvider;
pub use sse::{SseDecoder, SseEvent};

/// 默认超时（调用方未给定时使用）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// 统一 LLM 协议适配器契约。
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// 当前适配器使用的线格式。
    fn wire(&self) -> AiWireKind;

    /// 发起流式补全。
    ///
    /// 请求建立阶段（连接 / 首包）的错误以 `Err` 返回；
    /// 流建立后的中断通过结束流表达（事件通道不承载错误）。
    async fn stream(
        &self,
        request: CompletionRequest,
        cancel: CancellationToken,
    ) -> Result<BoxStream<'static, StreamEvent>, AiError>;

    /// 一次性补全：收集流并累积为完整响应。
    async fn complete(
        &self,
        request: CompletionRequest,
        cancel: CancellationToken,
    ) -> Result<CompletionResponse, AiError> {
        let mut stream = self.stream(request, cancel.clone()).await?;
        let mut accumulator = StreamAccumulator::new();
        while let Some(event) = stream.next().await {
            if cancel.is_cancelled() {
                return Err(http_error::cancelled());
            }
            accumulator.push(event);
        }
        if cancel.is_cancelled() {
            return Err(http_error::cancelled());
        }
        Ok(accumulator.finish())
    }
}

/// 按线格式创建适配器。服务层只依赖本函数。
///
/// `base_url` 为空时：Gemini 使用官方默认端点；OpenAI / Anthropic 返回 `Config` 错误。
pub fn create_provider(
    wire: AiWireKind,
    base_url: &str,
    api_key: &str,
    timeout: Duration,
) -> Result<Arc<dyn LlmProvider>, AiError> {
    let timeout = if timeout.is_zero() {
        DEFAULT_TIMEOUT
    } else {
        timeout
    };
    let provider: Arc<dyn LlmProvider> = match wire {
        AiWireKind::OpenAiChat => Arc::new(OpenAiCompatProvider::new(base_url, api_key, timeout)?),
        AiWireKind::AnthropicMessages => {
            Arc::new(AnthropicProvider::new(base_url, api_key, timeout)?)
        }
        AiWireKind::GeminiGenerateContent => {
            Arc::new(GeminiProvider::new(base_url, api_key, timeout)?)
        }
    };
    Ok(provider)
}

/// 拼接 base_url 与端点路径；base 自带 query 时把路径插到 query 之前（Azure 风格）。
pub(crate) fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match base.split_once('?') {
        Some((head, query)) => format!("{}/{}?{}", head.trim_end_matches('/'), path, query),
        None => format!("{base}/{path}"),
    }
}

/// 校验并规范化 base_url（去尾部斜杠，仅允许 http/https）。
pub(crate) fn validate_base_url(base_url: &str) -> Result<String, AiError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AiError::config("接口地址为空，请在模型档案中填写 Base URL"));
    }
    let url = reqwest::Url::parse(trimmed).map_err(|_| invalid_base_url())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid_base_url());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn invalid_base_url() -> AiError {
    AiError::config("接口地址格式不正确，请填写以 http:// 或 https:// 开头的地址")
}

pub(crate) fn invalid_api_key() -> AiError {
    AiError::config("API Key 含有非法字符，请重新填写密钥")
}

/// 构造 `Authorization: Bearer ...` 头；中间字符串用 `Zeroizing` 保管。
pub(crate) fn bearer_header(api_key: &str) -> Result<HeaderValue, AiError> {
    let bearer = Zeroizing::new(format!("Bearer {api_key}"));
    HeaderValue::from_str(&bearer).map_err(|_| invalid_api_key())
}

/// 提前校验 Key 能否作为 header 值（含非 ASCII 字符会直接失败）。
pub(crate) fn validate_api_key(api_key: &str) -> Result<(), AiError> {
    bearer_header(api_key).map(|_| ())
}

/// 创建共享 HTTP 客户端：只启用 rustls，绝不关闭证书校验。
pub(crate) fn default_client(timeout: Duration) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .connect_timeout(timeout)
        .user_agent(concat!("OpenShell/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| AiError::internal("初始化模型服务 HTTP 客户端失败"))
}

/// 发送请求：请求阶段同时受 `CancellationToken` 与超时约束。
pub(crate) async fn send_guarded(
    builder: reqwest::RequestBuilder,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<reqwest::Response, AiError> {
    if cancel.is_cancelled() {
        return Err(http_error::cancelled());
    }
    tokio::select! {
        biased;
        _ = wait_for_cancel(cancel) => Err(http_error::cancelled()),
        result = tokio::time::timeout(timeout, builder.send()) => match result {
            Err(_) => Err(http_error::timeout()),
            Ok(Err(err)) => Err(http_error::classify_reqwest(&err)),
            Ok(Ok(response)) => Ok(response),
        },
    }
}

/// 非 2xx 状态码统一转为中文错误。
pub(crate) async fn ensure_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, AiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(http_error::classify_status(status.as_u16(), &body))
}

async fn wait_for_cancel(cancel: &CancellationToken) {
    while !cancel.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AiErrorCode;
    use crate::types::ChatMessage;
    use std::time::Duration;

    #[test]
    fn create_provider_dispatches_by_wire() {
        let openai = create_provider(
            AiWireKind::OpenAiChat,
            "https://api.deepseek.com/v1",
            "sk-secret",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(openai.wire(), AiWireKind::OpenAiChat);

        let anthropic = create_provider(
            AiWireKind::AnthropicMessages,
            "https://api.anthropic.com/v1",
            "sk-ant-secret",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(anthropic.wire(), AiWireKind::AnthropicMessages);

        // Gemini 允许空白 base（走官方默认端点）。
        let gemini = create_provider(
            AiWireKind::GeminiGenerateContent,
            "",
            "AIza-secret",
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(gemini.wire(), AiWireKind::GeminiGenerateContent);
    }

    #[test]
    fn create_provider_requires_base_for_non_gemini() {
        for wire in [AiWireKind::OpenAiChat, AiWireKind::AnthropicMessages] {
            let Err(error) = create_provider(wire, "  ", "sk", Duration::from_secs(5)) else {
                panic!("空 Base URL 应返回错误");
            };
            assert_eq!(error.code, AiErrorCode::Config);
            assert!(error.message.contains("Base URL"));
        }
    }

    #[test]
    fn rejects_invalid_base_scheme() {
        let Err(error) = create_provider(
            AiWireKind::OpenAiChat,
            "ftp://example.com/v1",
            "",
            Duration::from_secs(5),
        ) else {
            panic!("非法 scheme 应返回错误");
        };
        assert_eq!(error.code, AiErrorCode::Config);
    }

    #[test]
    fn join_url_handles_query_and_slashes() {
        assert_eq!(
            join_url("https://api.example.com/v1/", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            join_url(
                "https://x.openai.azure.com/openai/deployments/d?api-version=2024-06-01",
                "chat/completions"
            ),
            "https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01"
        );
    }

    struct MockProvider;

    #[async_trait]
    impl LlmProvider for MockProvider {
        fn wire(&self) -> AiWireKind {
            AiWireKind::OpenAiChat
        }

        async fn stream(
            &self,
            _request: CompletionRequest,
            cancel: CancellationToken,
        ) -> Result<BoxStream<'static, StreamEvent>, AiError> {
            if cancel.is_cancelled() {
                return Err(http_error::cancelled());
            }
            let events = vec![
                StreamEvent::TextDelta("你好".into()),
                StreamEvent::TextDelta("，世界".into()),
                StreamEvent::Finish("stop".into()),
            ];
            Ok(Box::pin(futures_util::stream::iter(events)))
        }
    }

    #[tokio::test]
    async fn default_complete_accumulates_stream() {
        let provider = MockProvider;
        let response = provider
            .complete(
                CompletionRequest::new("mock", vec![ChatMessage::user("hi")]),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.text, "你好，世界");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
    }

    #[tokio::test]
    async fn complete_returns_cancelled_when_token_is_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = MockProvider
            .complete(
                CompletionRequest::new("mock", vec![ChatMessage::user("hi")]),
                cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, AiErrorCode::Cancelled);
    }

    #[tokio::test]
    async fn send_guarded_reports_cancelled_before_dispatch() {
        let client = default_client(Duration::from_secs(1)).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let builder = client.post("http://127.0.0.1:9/never-sent");
        let error = send_guarded(builder, &cancel, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.code, AiErrorCode::Cancelled);
    }
}
