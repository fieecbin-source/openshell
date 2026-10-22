//! 扩展机制端到端管线验证（TASK-P1-M5-1 与 docs/architecture.md §21）
//!
//! 验证：
//! 1. ProtocolProvider / SidePanel / ToolPage / QuickAction 注册与注销
//! 2. 独立开关（Feature Toggle）生效与零侵入
//! 3. 编排层与扩展模块之间的 Trait 解耦

use openshell_app_core::{AppServices, ExtensionRegistry};
use openshell_core_domain::{ActionContext, PanelPosition, ToolWindowMode};
use openshell_extension_sample::{
    EchoProtocolProvider, PortCheckerQuickAction, PortCheckerSidePanel, PortCheckerTool,
};
use std::sync::Arc;

#[tokio::test]
async fn test_extension_registry_full_pipeline_and_feature_flags() {
    let registry = Arc::new(ExtensionRegistry::new());

    // 1. 注册示例扩展提供者
    let tool = Arc::new(PortCheckerTool);
    let panel = Arc::new(PortCheckerSidePanel::new());
    let action = Arc::new(PortCheckerQuickAction::new());
    let proto = Arc::new(EchoProtocolProvider);

    registry.register_tool(tool.clone());
    registry.register_panel(panel.clone());
    registry.register_quick_action(action.clone());
    registry.register_protocol(proto.clone());

    // 2. 验证元数据发现与列表
    let tools = registry.list_tools();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool_id, "ping-port-checker");
    assert_eq!(tools[0].window_mode, ToolWindowMode::Tab);
    assert!(tools[0].enabled);

    let panels = registry.list_panels();
    assert_eq!(panels.len(), 1);
    assert_eq!(panels[0].panel_id, "port-checker-sidepanel");
    assert_eq!(panels[0].default_position, PanelPosition::Right);
    assert!(panels[0].enabled);

    let actions = registry.list_quick_actions();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].action_id, "check-session-port");
    assert_eq!(actions[0].default_shortcut.as_deref(), Some("Ctrl+Shift+P"));
    assert!(actions[0].enabled);

    let protocols = registry.list_protocols();
    assert_eq!(protocols.len(), 1);
    assert_eq!(protocols[0].protocol_id, "echo-test");
    assert!(protocols[0].capabilities.has_terminal_stream);

    // 3. 执行快捷动作
    let ctx = ActionContext {
        active_session_id: Some("sess_prod_server".to_string()),
        active_host: Some("10.0.0.1".to_string()),
        active_port: Some(2222),
        selected_text: None,
    };
    registry
        .execute_quick_action("check-session-port", &ctx)
        .expect("execute quick action successfully");
    assert_eq!(
        *action.last_executed_target.read(),
        Some("10.0.0.1:2222".to_string())
    );

    // 4. 触发侧边栏会话激活通知
    registry.notify_session_activated("sess_new_tab");
    assert_eq!(
        *panel.last_activated_session.read(),
        Some("sess_new_tab".to_string())
    );

    // 5. 独立开关（Feature Toggle）：关闭快捷动作
    let disabled = registry.set_action_enabled("check-session-port", false);
    assert!(disabled);

    // 验证关闭后执行被拦截（零影响与无侵入）
    let exec_res = registry.execute_quick_action("check-session-port", &ctx);
    assert!(exec_res.is_err());
    let err_msg = exec_res.unwrap_err().to_string();
    assert!(err_msg.contains("disabled"));

    // 重新开启
    registry.set_action_enabled("check-session-port", true);
    let re_exec_res = registry.execute_quick_action("check-session-port", &ctx);
    assert!(re_exec_res.is_ok());

    // 6. 验证协议开关
    assert!(registry.get_protocol("echo-test").is_some());
    registry.set_protocol_enabled("echo-test", false);
    assert!(registry.get_protocol("echo-test").is_none());
    registry.set_protocol_enabled("echo-test", true);
    assert!(registry.get_protocol("echo-test").is_some());
}

#[tokio::test]
async fn test_app_services_extension_integration() {
    let services = AppServices::new_in_memory().expect("in-memory app services");

    // 注册到 AppServices 的 ExtensionRegistry
    services.extensions.register_tool(Arc::new(PortCheckerTool));
    services
        .extensions
        .register_quick_action(Arc::new(PortCheckerQuickAction::new()));

    assert_eq!(services.extensions.list_tools().len(), 1);
    assert_eq!(services.extensions.list_quick_actions().len(), 1);
}
