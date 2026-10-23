//! 扩展点注册表（ExtensionRegistry）
//!
//! 负责集中管理协议扩展、侧边栏扩展、工具页扩展、快捷动作与导入器扩展。
//! 严格满足 docs/architecture.md §21：
//! - 接口解耦
//! - 独立开关（Feature Toggle）
//! - 零侵入可插拔

use openshell_core_domain::{
    ActionContext, DomainError, DomainResult, ProtocolMetadata, ProtocolProvider,
    QuickActionMetadata, QuickActionProvider, SessionImporter, SessionInput, SidePanelMetadata,
    SidePanelProvider, ToolMetadata, ToolPageProvider,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

struct RegisteredItem<T: ?Sized> {
    provider: Arc<T>,
    enabled: bool,
}

/// 扩展点中央注册表。
#[derive(Default)]
pub struct ExtensionRegistry {
    protocols: RwLock<HashMap<String, RegisteredItem<dyn ProtocolProvider>>>,
    panels: RwLock<HashMap<String, RegisteredItem<dyn SidePanelProvider>>>,
    tools: RwLock<HashMap<String, RegisteredItem<dyn ToolPageProvider>>>,
    actions: RwLock<HashMap<String, RegisteredItem<dyn QuickActionProvider>>>,
    importers: RwLock<HashMap<String, RegisteredItem<dyn SessionImporter>>>,
}

impl ExtensionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    // --- 协议扩展 ---
    pub fn register_protocol(&self, provider: Arc<dyn ProtocolProvider>) {
        let mut map = self.protocols.write();
        map.insert(
            provider.protocol_id().to_string(),
            RegisteredItem {
                provider,
                enabled: true,
            },
        );
    }

    pub fn set_protocol_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut map = self.protocols.write();
        if let Some(item) = map.get_mut(id) {
            item.enabled = enabled;
            true
        } else {
            false
        }
    }

    pub fn get_protocol(&self, id: &str) -> Option<Arc<dyn ProtocolProvider>> {
        let map = self.protocols.read();
        map.get(id)
            .filter(|i| i.enabled)
            .map(|i| i.provider.clone())
    }

    pub fn list_protocols(&self) -> Vec<ProtocolMetadata> {
        let map = self.protocols.read();
        map.iter()
            .map(|(k, v)| ProtocolMetadata {
                protocol_id: k.clone(),
                display_name: v.provider.display_name().to_string(),
                capabilities: v.provider.capabilities(),
                enabled: v.enabled,
            })
            .collect()
    }

    // --- 侧边栏扩展 ---
    pub fn register_panel(&self, provider: Arc<dyn SidePanelProvider>) {
        let mut map = self.panels.write();
        map.insert(
            provider.panel_id().to_string(),
            RegisteredItem {
                provider,
                enabled: true,
            },
        );
    }

    pub fn set_panel_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut map = self.panels.write();
        if let Some(item) = map.get_mut(id) {
            item.enabled = enabled;
            true
        } else {
            false
        }
    }

    pub fn list_panels(&self) -> Vec<SidePanelMetadata> {
        let map = self.panels.read();
        map.iter()
            .map(|(k, v)| SidePanelMetadata {
                panel_id: k.clone(),
                title_key: v.provider.title_key().to_string(),
                icon: v.provider.icon().to_string(),
                default_position: v.provider.default_position(),
                enabled: v.enabled,
            })
            .collect()
    }

    pub fn notify_session_activated(&self, session_id: &str) {
        let map = self.panels.read();
        for item in map.values() {
            if item.enabled {
                item.provider.on_session_activated(session_id);
            }
        }
    }

    // --- 工具页扩展 ---
    pub fn register_tool(&self, provider: Arc<dyn ToolPageProvider>) {
        let mut map = self.tools.write();
        map.insert(
            provider.tool_id().to_string(),
            RegisteredItem {
                provider,
                enabled: true,
            },
        );
    }

    pub fn set_tool_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut map = self.tools.write();
        if let Some(item) = map.get_mut(id) {
            item.enabled = enabled;
            true
        } else {
            false
        }
    }

    pub fn list_tools(&self) -> Vec<ToolMetadata> {
        let map = self.tools.read();
        map.iter()
            .map(|(k, v)| ToolMetadata {
                tool_id: k.clone(),
                route: v.provider.route().to_string(),
                display_name: v.provider.display_name().to_string(),
                icon: v.provider.icon().to_string(),
                window_mode: v.provider.window_mode(),
                enabled: v.enabled,
            })
            .collect()
    }

    // --- 快捷动作扩展 ---
    pub fn register_quick_action(&self, provider: Arc<dyn QuickActionProvider>) {
        let mut map = self.actions.write();
        map.insert(
            provider.action_id().to_string(),
            RegisteredItem {
                provider,
                enabled: true,
            },
        );
    }

    pub fn set_action_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut map = self.actions.write();
        if let Some(item) = map.get_mut(id) {
            item.enabled = enabled;
            true
        } else {
            false
        }
    }

    pub fn list_quick_actions(&self) -> Vec<QuickActionMetadata> {
        let map = self.actions.read();
        map.iter()
            .map(|(k, v)| QuickActionMetadata {
                action_id: k.clone(),
                label_key: v.provider.label_key().to_string(),
                default_shortcut: v.provider.default_shortcut().map(ToString::to_string),
                enabled: v.enabled,
            })
            .collect()
    }

    pub fn execute_quick_action(&self, action_id: &str, ctx: &ActionContext) -> DomainResult<()> {
        let map = self.actions.read();
        if let Some(item) = map.get(action_id) {
            if !item.enabled {
                return Err(DomainError::validation(format!(
                    "Quick action '{}' is disabled",
                    action_id
                )));
            }
            item.provider.execute(ctx)
        } else {
            Err(DomainError::not_found(format!(
                "Quick action '{}' not found",
                action_id
            )))
        }
    }

    // --- 导入器扩展 ---
    pub fn register_importer(&self, provider: Arc<dyn SessionImporter>) {
        let mut map = self.importers.write();
        map.insert(
            provider.format_id().to_string(),
            RegisteredItem {
                provider,
                enabled: true,
            },
        );
    }

    pub fn parse_import(&self, format_id: &str, content: &str) -> DomainResult<Vec<SessionInput>> {
        let map = self.importers.read();
        if let Some(item) = map.get(format_id) {
            if !item.enabled {
                return Err(DomainError::validation(format!(
                    "Importer '{}' is disabled",
                    format_id
                )));
            }
            item.provider.parse(content)
        } else {
            Err(DomainError::not_found(format!(
                "Importer '{}' not found",
                format_id
            )))
        }
    }
}
