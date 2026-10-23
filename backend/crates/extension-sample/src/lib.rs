//! OpenShell 扩展机制示例模块（ping-port-checker）
//!
//! 验证 docs/architecture.md §21 中核心扩展点契约的可用性与解耦性：
//! 1. ProtocolProvider（协议提供者，阶段二 Telnet/RDP 等由此接入）
//! 2. SidePanelProvider（侧边栏面板提供者，阶段二宏面板等由此接入）
//! 3. ToolPageProvider（独立工具页提供者，阶段二端口扫描/网络探测等由此接入）
//! 4. QuickActionProvider（全局快捷动作，阶段二宏录制/分屏等由此接入）

use async_trait::async_trait;
use openshell_core_domain::{
    ActionContext, ByteStream, DomainResult, PanelPosition, ProtocolCapabilities, ProtocolProvider,
    QuickActionProvider, SecretMaterial, Session, SidePanelProvider, TermSize, ToolPageProvider,
    ToolWindowMode,
};
use serde::{Deserialize, Serialize};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// 端口连通性检测结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortCheckResult {
    pub host: String,
    pub port: u16,
    pub is_open: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// 执行实际 TCP 端口探测（带超时控制）。
pub async fn probe_tcp_port(host: &str, port: u16, timeout_ms: u64) -> PortCheckResult {
    let addr = format!("{}:{}", host, port);
    let start = Instant::now();

    match timeout(Duration::from_millis(timeout_ms), TcpStream::connect(&addr)).await {
        Ok(Ok(_stream)) => {
            let elapsed = start.elapsed().as_millis() as u64;
            PortCheckResult {
                host: host.to_string(),
                port,
                is_open: true,
                latency_ms: elapsed.max(1),
                error: None,
            }
        }
        Ok(Err(err)) => {
            let elapsed = start.elapsed().as_millis() as u64;
            PortCheckResult {
                host: host.to_string(),
                port,
                is_open: false,
                latency_ms: elapsed,
                error: Some(err.to_string()),
            }
        }
        Err(_) => PortCheckResult {
            host: host.to_string(),
            port,
            is_open: false,
            latency_ms: timeout_ms,
            error: Some("Connection timed out".to_string()),
        },
    }
}

// ---------------------------------------------------------------------------
// 1. ToolPageProvider 实现：轻量主机/端口连通性检测独立工作台
// ---------------------------------------------------------------------------

pub struct PortCheckerTool;

impl ToolPageProvider for PortCheckerTool {
    fn tool_id(&self) -> &'static str {
        "ping-port-checker"
    }

    fn route(&self) -> &'static str {
        "/tools/port-checker"
    }

    fn display_name(&self) -> &'static str {
        "Ping & Port Checker"
    }

    fn icon(&self) -> &'static str {
        "network-check"
    }

    fn window_mode(&self) -> ToolWindowMode {
        ToolWindowMode::Tab
    }
}

// ---------------------------------------------------------------------------
// 2. SidePanelProvider 实现：侧边栏实时连通性监控面板
// ---------------------------------------------------------------------------

pub struct PortCheckerSidePanel {
    pub last_activated_session: Arc<parking_lot::RwLock<Option<String>>>,
}

impl PortCheckerSidePanel {
    pub fn new() -> Self {
        Self {
            last_activated_session: Arc::new(parking_lot::RwLock::new(None)),
        }
    }
}

impl Default for PortCheckerSidePanel {
    fn default() -> Self {
        Self::new()
    }
}

impl SidePanelProvider for PortCheckerSidePanel {
    fn panel_id(&self) -> &'static str {
        "port-checker-sidepanel"
    }

    fn title_key(&self) -> &'static str {
        "panel.port_checker"
    }

    fn icon(&self) -> &'static str {
        "activity"
    }

    fn default_position(&self) -> PanelPosition {
        PanelPosition::Right
    }

    fn on_session_activated(&self, session_id: &str) {
        let mut lock = self.last_activated_session.write();
        *lock = Some(session_id.to_string());
    }
}

// ---------------------------------------------------------------------------
// 3. QuickActionProvider 实现：一键会话连通性检测
// ---------------------------------------------------------------------------

pub struct PortCheckerQuickAction {
    pub last_executed_target: Arc<parking_lot::RwLock<Option<String>>>,
}

impl PortCheckerQuickAction {
    pub fn new() -> Self {
        Self {
            last_executed_target: Arc::new(parking_lot::RwLock::new(None)),
        }
    }
}

impl Default for PortCheckerQuickAction {
    fn default() -> Self {
        Self::new()
    }
}

impl QuickActionProvider for PortCheckerQuickAction {
    fn action_id(&self) -> &'static str {
        "check-session-port"
    }

    fn label_key(&self) -> &'static str {
        "action.check_port"
    }

    fn default_shortcut(&self) -> Option<&'static str> {
        Some("Ctrl+Shift+P")
    }

    fn execute(&self, ctx: &ActionContext) -> DomainResult<()> {
        let host = ctx.active_host.as_deref().unwrap_or("127.0.0.1");
        let port = ctx.active_port.unwrap_or(22);
        let target = format!("{}:{}", host, port);
        let mut lock = self.last_executed_target.write();
        *lock = Some(target);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 4. ProtocolProvider 实现：回显测试协议（验证协议可插拔）
// ---------------------------------------------------------------------------

pub struct EchoProtocolStream {
    duplex: DuplexStream,
    is_closed: AtomicBool,
}

impl EchoProtocolStream {
    pub fn new(duplex: DuplexStream) -> Self {
        Self {
            duplex,
            is_closed: AtomicBool::new(false),
        }
    }
}

impl AsyncRead for EchoProtocolStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.is_closed.load(Ordering::Relaxed) {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.duplex).poll_read(cx, buf)
    }
}

impl AsyncWrite for EchoProtocolStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.is_closed.load(Ordering::Relaxed) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream closed",
            )));
        }
        Pin::new(&mut self.duplex).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.duplex).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.is_closed.store(true, Ordering::Relaxed);
        Pin::new(&mut self.duplex).poll_shutdown(cx)
    }
}

impl ByteStream for EchoProtocolStream {
    fn resize(&mut self, _size: TermSize) -> DomainResult<()> {
        Ok(())
    }

    fn close(self: Box<Self>) -> DomainResult<()> {
        self.is_closed.store(true, Ordering::Relaxed);
        Ok(())
    }
}

pub struct EchoProtocolProvider;

#[async_trait]
impl ProtocolProvider for EchoProtocolProvider {
    fn protocol_id(&self) -> &'static str {
        "echo-test"
    }

    fn display_name(&self) -> &'static str {
        "Echo Diagnostic Protocol"
    }

    fn capabilities(&self) -> ProtocolCapabilities {
        ProtocolCapabilities {
            has_terminal_stream: true,
            has_file_transfer: false,
            has_port_forward: false,
            has_exec: true,
        }
    }

    async fn connect(
        &self,
        _session: &Session,
        _credential: Option<&SecretMaterial>,
    ) -> DomainResult<Box<dyn ByteStream>> {
        // 创建配对双工流模拟协议回显
        let (client, mut server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 1024];
            while let Ok(n) = server.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                if server.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        });

        Ok(Box::new(EchoProtocolStream::new(client)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::{Protocol, SessionId};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn test_tcp_port_probe_success_and_failure() {
        // 绑定临时本地端口
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // 探测应成功
        let success_res = probe_tcp_port("127.0.0.1", port, 1000).await;
        assert!(success_res.is_open);
        assert!(success_res.error.is_none());
        assert!(success_res.latency_ms > 0);

        // 关闭 listener 后探测已关闭端口（选一个极不可能开放的端口）
        drop(listener);
        let closed_res = probe_tcp_port("127.0.0.1", port, 200).await;
        assert!(!closed_res.is_open);
        assert!(closed_res.error.is_some());
    }

    #[test]
    fn test_tool_page_provider_metadata() {
        let tool = PortCheckerTool;
        assert_eq!(tool.tool_id(), "ping-port-checker");
        assert_eq!(tool.route(), "/tools/port-checker");
        assert_eq!(tool.display_name(), "Ping & Port Checker");
        assert_eq!(tool.icon(), "network-check");
        assert_eq!(tool.window_mode(), ToolWindowMode::Tab);
    }

    #[test]
    fn test_side_panel_and_quick_action() {
        let panel = PortCheckerSidePanel::new();
        assert_eq!(panel.panel_id(), "port-checker-sidepanel");
        assert_eq!(panel.default_position(), PanelPosition::Right);

        panel.on_session_activated("sess_12345");
        assert_eq!(
            *panel.last_activated_session.read(),
            Some("sess_12345".to_string())
        );

        let action = PortCheckerQuickAction::new();
        assert_eq!(action.action_id(), "check-session-port");
        let ctx = ActionContext {
            active_session_id: Some("sess_12345".to_string()),
            active_host: Some("192.168.1.50".to_string()),
            active_port: Some(8080),
            selected_text: None,
        };
        action.execute(&ctx).expect("execute quick action");
        assert_eq!(
            *action.last_executed_target.read(),
            Some("192.168.1.50:8080".to_string())
        );
    }

    #[tokio::test]
    async fn test_echo_protocol_provider() {
        let provider = EchoProtocolProvider;
        assert_eq!(provider.protocol_id(), "echo-test");
        let caps = provider.capabilities();
        assert!(caps.has_terminal_stream);

        let dummy_session = Session {
            id: SessionId::new(),
            group_id: None,
            name: "Test Echo".to_string(),
            protocol: Protocol::LocalShell,
            host: None,
            port: None,
            username: None,
            auth_method: openshell_core_domain::AuthMethod::Password,
            credential_id: None,
            ssh_key_id: None,
            host_key_policy: openshell_core_domain::HostKeyPolicy::AcceptNew,
            proxy_jump_json: None,
            proxy_id: None,
            terminal_profile_id: None,
            encoding: "UTF-8".to_string(),
            startup_command: None,
            working_dir: None,
            keepalive_sec: 30,
            keepalive_max_miss: 3,
            auto_reconnect: false,
            reconnect_max: 5,
            compression: false,
            agent_forwarding: false,
            x11_forwarding: false,
            tags_json: None,
            favorite: false,
            color: None,
            icon_key: None,
            notes: None,
            protocol_options_json: None,
            last_used_at: None,
            last_result: None,
            use_count: 0,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            sync: openshell_core_domain::SyncMeta::default(),
        };

        let mut stream = provider
            .connect(&dummy_session, None)
            .await
            .expect("connect echo protocol");

        // 测试写入并回读
        stream.write_all(b"PING PONG 1234").await.expect("write");
        let mut buf = [0u8; 14];
        stream.read_exact(&mut buf).await.expect("read exact");
        assert_eq!(&buf, b"PING PONG 1234");
    }
}
