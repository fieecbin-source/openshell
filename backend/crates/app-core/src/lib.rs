pub mod ai_service;
pub mod app_services;
pub mod card_service;
pub mod connection_service;
pub mod credit_tracker;
pub mod event_bus;
pub mod extension_registry;
pub mod op_registry;
pub mod session_service;
pub mod sync_codec;
pub mod sync_service;
mod sync_vault;
pub mod terminal_router;
pub mod vault_service;

pub use app_services::{AppServices, APP_VERSION};
pub use card_service::CardService;
pub use connection_service::{ConnectOverrides, ConnectionService};
pub use credit_tracker::{CreditTracker, FlowAction};
pub use event_bus::{forward_events, EventBus};
pub use extension_registry::ExtensionRegistry;
pub use op_registry::{CancellationToken, OpRegistry};
pub use session_service::SessionService;
pub use sync_codec::{
    apply_remote_records, backup_conflict, collect_dirty_records, mark_records_applied,
    AppliedSyncRecord, ApplySummary, ConflictBackupInput, LocalSyncRecord, SyncRecordType,
    SYNC_SCHEMA_VERSION,
};
pub use sync_service::{SyncConfig, SyncResult, SyncService};
pub use terminal_router::{encode_data_frame, encode_notice_frame, TerminalRouter};
pub use vault_service::{VaultService, VaultStatus};

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::{GroupKind, Protocol, SessionInput, SessionQuery};

    #[tokio::test]
    async fn test_app_services_in_memory_lifecycle() {
        let services = AppServices::new_in_memory().expect("init in-memory app services");

        // 1. 保险库状态检查与初始化
        let status = services.vault.status().expect("check vault status");
        assert_eq!(status.state, "uninitialized");

        let unlocked_status = services
            .vault
            .init("MasterPassword123!", false, None)
            .expect("init vault");
        assert_eq!(unlocked_status.state, "unlocked");

        // 2. 分组创建
        let group = services
            .session
            .create_group(None, "Linux Servers".to_string(), GroupKind::Session)
            .await
            .expect("create group");
        assert_eq!(group.name, "Linux Servers");

        // 3. 凭据创建
        let cred = services
            .session
            .create_credential(
                "Root Password".to_string(),
                openshell_core_domain::CredentialKind::Password,
                Some("root".to_string()),
                "secret_p@ssw0rd!",
                Some("main server pass".to_string()),
                None,
            )
            .await
            .expect("create credential");
        assert_eq!(cred.name, "Root Password");

        // 4. 会话创建
        let session = services
            .session
            .create_session(SessionInput {
                group_id: Some(group.id.clone()),
                name: Some("Web-Prod-01".to_string()),
                protocol: Some(Protocol::Ssh),
                host: Some("192.168.1.100".to_string()),
                port: Some(22),
                username: Some("root".to_string()),
                credential_id: Some(cred.id.clone()),
                ..Default::default()
            })
            .await
            .expect("create session");
        assert_eq!(session.name, "Web-Prod-01");
        assert_eq!(session.host, Some("192.168.1.100".to_string()));

        // 5. 查询会话
        let sessions = services
            .session
            .list_sessions(&SessionQuery::default())
            .await
            .expect("list sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session.id);

        // 6. 锁定保险库
        let locked_status = services.vault.lock().expect("lock vault");
        assert_eq!(locked_status.state, "locked");

        // 7. 解锁保险库
        let re_unlocked = services
            .vault
            .unlock(Some("MasterPassword123!"), false)
            .expect("re-unlock vault");
        assert_eq!(re_unlocked.state, "unlocked");
    }
}
