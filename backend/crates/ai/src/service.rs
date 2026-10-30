//! 服务层契约：厂商联通测试的可注入接口。
//!
//! Batch 2 Agent D 在此实现 `HttpProfileTester` 与配置编排所需的辅助函数；
//! 单元测试通过实现本 trait 注入 Mock，覆盖 401 / 429 / 超时 / 模型不存在等场景。

use crate::error::AiError;
use crate::provider::create_provider;
use crate::types::{CancellationToken, ChatMessage, CompletionRequest};
use async_trait::async_trait;
use openshell_core_domain::{AiWireKind, ProviderTestResult};
use std::time::{Duration, Instant};

/// 联通测试默认超时（短超时，避免设置页长时间等待）。
pub const PROFILE_TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 联通测试提示词：尽最大可能压低 Token 消耗。
pub const PROFILE_TEST_PROMPT: &str = "Reply with the single word: ok";

/// 厂商联通测试端口（可注入 Mock）。
#[async_trait]
pub trait ProfileTester: Send + Sync {
    async fn test_profile(
        &self,
        wire: AiWireKind,
        base_url: &str,
        model_id: &str,
        api_key: &str,
        timeout: Duration,
    ) -> Result<ProviderTestResult, AiError>;
}

/// 基于实际 HTTP 请求的联通测试器。
///
/// 失败一律归一为 `Ok(ProviderTestResult { ok: false, .. })`，
/// `message` 只使用 [`AiError::message`] 的中文短句，不透出远端原始报文。
pub struct HttpProfileTester;

#[async_trait]
impl ProfileTester for HttpProfileTester {
    async fn test_profile(
        &self,
        wire: AiWireKind,
        base_url: &str,
        model_id: &str,
        api_key: &str,
        timeout: Duration,
    ) -> Result<ProviderTestResult, AiError> {
        let started = Instant::now();
        let outcome = async {
            let provider = create_provider(wire, base_url, api_key, timeout)?;
            let request =
                CompletionRequest::new(model_id, vec![ChatMessage::user(PROFILE_TEST_PROMPT)]);
            provider.complete(request, CancellationToken::new()).await?;
            Ok::<(), AiError>(())
        }
        .await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        Ok(match outcome {
            Ok(()) => ProviderTestResult {
                ok: true,
                latency_ms,
                model: model_id.to_string(),
                message: "连接成功".to_string(),
                code: None,
            },
            Err(error) => ProviderTestResult {
                ok: false,
                latency_ms,
                model: model_id.to_string(),
                message: error.message,
                code: Some(error.code.as_str().to_string()),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AiErrorCode;

    #[tokio::test]
    async fn tester_rejects_invalid_base_url_without_network() {
        let result = HttpProfileTester
            .test_profile(
                AiWireKind::OpenAiChat,
                "ftp://example.com/v1",
                "mock-model",
                "",
                Duration::from_millis(50),
            )
            .await
            .expect("联通测试应返回结构化结果");
        assert!(!result.ok);
        assert_eq!(result.code.as_deref(), Some(AiErrorCode::Config.as_str()));
        assert!(!result.message.is_empty());
        assert_eq!(result.model, "mock-model");
    }

    #[tokio::test]
    async fn tester_classifies_unreachable_local_endpoint() {
        let result = HttpProfileTester
            .test_profile(
                AiWireKind::OpenAiChat,
                "http://127.0.0.1:1/v1",
                "mock-model",
                "",
                Duration::from_millis(50),
            )
            .await
            .expect("联通测试应返回结构化结果");
        assert!(!result.ok);
        assert!(
            matches!(
                result.code.as_deref(),
                Some("AI_TIMEOUT") | Some("AI_NETWORK")
            ),
            "不可达端点应归类为超时或网络错误，实际为 {:?}",
            result.code
        );
    }
}
