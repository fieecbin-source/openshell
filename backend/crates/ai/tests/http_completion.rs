use openshell_ai::provider::create_provider;
use openshell_ai::service::{HttpProfileTester, ProfileTester};
use openshell_ai::types::{CancellationToken, ChatMessage, CompletionRequest};
use openshell_core_domain::AiWireKind;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn endpoint(body: &str, hang: bool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_owned();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        let length = if hang { body.len() + 1000 } else { body.len() };
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}");
        socket.write_all(response.as_bytes()).await.unwrap();
        if hang {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    format!("http://{address}/v1")
}

fn valid_body(wire: AiWireKind) -> &'static str {
    match wire {
        AiWireKind::OpenAiChat => "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        AiWireKind::AnthropicMessages => "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
        AiWireKind::GeminiGenerateContent => "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}\n\n",
    }
}

fn partial_body(wire: AiWireKind) -> &'static str {
    match wire {
        AiWireKind::OpenAiChat => "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}\n\n",
        AiWireKind::AnthropicMessages => "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
        AiWireKind::GeminiGenerateContent => "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\n",
    }
}

#[tokio::test]
async fn valid_responses_complete_for_all_wires() {
    for wire in [
        AiWireKind::OpenAiChat,
        AiWireKind::AnthropicMessages,
        AiWireKind::GeminiGenerateContent,
    ] {
        let url = endpoint(valid_body(wire), false).await;
        let result = HttpProfileTester
            .test_profile(wire, &url, "test", "", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(result.ok, "{wire:?}: {result:?}");
    }
}

#[tokio::test]
async fn invalid_or_truncated_responses_never_verify_for_all_wires() {
    for wire in [
        AiWireKind::OpenAiChat,
        AiWireKind::AnthropicMessages,
        AiWireKind::GeminiGenerateContent,
    ] {
        for body in [
            "",
            "<html>login</html>",
            "data: {\"error\":{\"message\":\"synthetic-secret-do-not-echo\"}}\n\n",
            partial_body(wire),
        ] {
            let url = endpoint(body, false).await;
            let result = HttpProfileTester
                .test_profile(wire, &url, "test", "", Duration::from_secs(1))
                .await
                .unwrap();
            assert!(!result.ok, "{wire:?} accepted {body:?}");
            assert!(!result.message.contains("synthetic-secret-do-not-echo"));
        }
    }
}

#[tokio::test]
async fn malformed_data_before_valid_completion_never_verifies() {
    for wire in [
        AiWireKind::OpenAiChat,
        AiWireKind::AnthropicMessages,
        AiWireKind::GeminiGenerateContent,
    ] {
        let url = endpoint(&format!("data: {{not json\n\n{}", valid_body(wire)), false).await;
        let result = HttpProfileTester
            .test_profile(wire, &url, "test", "", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!result.ok, "{wire:?} ignored malformed data");
    }
}

#[tokio::test]
async fn named_error_event_is_never_ignored_before_valid_content() {
    for wire in [
        AiWireKind::OpenAiChat,
        AiWireKind::AnthropicMessages,
        AiWireKind::GeminiGenerateContent,
    ] {
        let body = format!(
            "event: error\ndata: synthetic-secret-do-not-echo\n\n{}",
            valid_body(wire)
        );
        let url = endpoint(&body, false).await;
        let result = HttpProfileTester
            .test_profile(wire, &url, "test", "", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!result.ok, "{wire:?} ignored SSE error");
        assert!(!result.message.contains("synthetic-secret-do-not-echo"));
    }
}

#[tokio::test]
async fn shared_complete_rejects_error_after_content() {
    let body = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"error\":{\"message\":\"no\"}}\n\n";
    let url = endpoint(body, false).await;
    let provider =
        create_provider(AiWireKind::OpenAiChat, &url, "", Duration::from_secs(1)).unwrap();
    assert!(provider
        .complete(
            CompletionRequest::new("test", vec![ChatMessage::user("hi")]),
            CancellationToken::new()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn hanging_body_respects_total_timeout_for_all_wires() {
    for wire in [
        AiWireKind::OpenAiChat,
        AiWireKind::AnthropicMessages,
        AiWireKind::GeminiGenerateContent,
    ] {
        let url = endpoint("", true).await;
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            HttpProfileTester.test_profile(wire, &url, "test", "", Duration::from_millis(80)),
        )
        .await
        .expect("body exceeded total timeout")
        .unwrap();
        assert!(!result.ok);
        assert_eq!(result.code.as_deref(), Some("AI_TIMEOUT"));
    }
}

#[tokio::test]
async fn cancellation_interrupts_waiting_body() {
    let url = endpoint("", true).await;
    let provider =
        create_provider(AiWireKind::OpenAiChat, &url, "", Duration::from_secs(2)).unwrap();
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        signal.cancel();
    });
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        provider.complete(
            CompletionRequest::new("test", vec![ChatMessage::user("hi")]),
            cancel,
        ),
    )
    .await
    .expect("cancellation did not interrupt body");
    assert_eq!(result.unwrap_err().code.as_str(), "AI_CANCELLED");
}
