//! 扩展机制端口与契约（严格参照 docs/architecture.md §21）。
//!
//! 核心原则：
//! 1. 接口驱动：核心层仅依赖 Trait 抽象。
//! 2. 零侵入可插拔：各模块具备独立开关，关闭时无常驻开销。
//! 3. 严格安全合规：凭据必须经由 SecretResolver/VaultPort，严禁绕过。

use crate::entities::{SecretMaterial, Session, SessionInput};
use crate::errors::DomainResult;
use crate::ports::ByteStream;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// 协议能力画像。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolCapabilities {
    pub has_terminal_stream: bool,
    pub has_file_transfer: bool,
    pub has_port_forward: bool,
    pub has_exec: bool,
}

impl Default for ProtocolCapabilities {
    fn default() -> Self {
        Self {
            has_terminal_stream: true,
            has_file_transfer: false,
            has_port_forward: false,
            has_exec: false,
        }
    }
}

/// 1. 协议扩展点（ProtocolProvider）
#[async_trait]
pub trait ProtocolProvider: Send + Sync {
    /// 唯一协议标识符，如 "ssh", "serial", "telnet", "rdp", "ping-probe"
    fn protocol_id(&self) -> &'static str;

    /// 人类可读名称
    fn display_name(&self) -> &'static str;

    /// 协议能力画像
    fn capabilities(&self) -> ProtocolCapabilities;

    /// 根据会话定义创建抽象连接通道
    async fn connect(
        &self,
        session: &Session,
        credentials: Option<&SecretMaterial>,
    ) -> DomainResult<Box<dyn ByteStream>>;
}

/// 侧边栏停靠位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PanelPosition {
    LeftTop,
    LeftBottom,
    Right,
}

/// 2. 侧边栏面板扩展点（SidePanelProvider）
pub trait SidePanelProvider: Send + Sync {
    fn panel_id(&self) -> &'static str;
    fn title_key(&self) -> &'static str;
    fn icon(&self) -> &'static str;
    fn default_position(&self) -> PanelPosition;

    /// 当用户激活某个终端标签时的通知
    fn on_session_activated(&self, session_id: &str);
}

/// 独立工具窗口展示模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolWindowMode {
    Tab,
    StandaloneWindow,
    Modal,
}

/// 3. 独立工作台工具扩展点（ToolPageProvider）
pub trait ToolPageProvider: Send + Sync {
    fn tool_id(&self) -> &'static str;
    fn route(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn icon(&self) -> &'static str;
    fn window_mode(&self) -> ToolWindowMode;
}

/// 全局快捷动作上下文。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActionContext {
    pub active_session_id: Option<String>,
    pub active_host: Option<String>,
    pub active_port: Option<u16>,
    pub selected_text: Option<String>,
}

/// 4. 全局快捷动作扩展点（QuickActionProvider）
pub trait QuickActionProvider: Send + Sync {
    fn action_id(&self) -> &'static str;
    fn label_key(&self) -> &'static str;
    fn default_shortcut(&self) -> Option<&'static str>;

    /// 动作触发时的处理逻辑
    fn execute(&self, ctx: &ActionContext) -> DomainResult<()>;
}

/// 5. 外部会话导入器扩展点（SessionImporter）
pub trait SessionImporter: Send + Sync {
    fn format_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn parse(&self, content: &str) -> DomainResult<Vec<SessionInput>>;
}

/// 工具元数据描述（供前端序列化消费）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolMetadata {
    pub tool_id: String,
    pub route: String,
    pub display_name: String,
    pub icon: String,
    pub window_mode: ToolWindowMode,
    pub enabled: bool,
}

/// 面板元数据描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidePanelMetadata {
    pub panel_id: String,
    pub title_key: String,
    pub icon: String,
    pub default_position: PanelPosition,
    pub enabled: bool,
}

/// 快捷动作元数据描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickActionMetadata {
    pub action_id: String,
    pub label_key: String,
    pub default_shortcut: Option<String>,
    pub enabled: bool,
}

/// 协议元数据描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolMetadata {
    pub protocol_id: String,
    pub display_name: String,
    pub capabilities: ProtocolCapabilities,
    pub enabled: bool,
}
