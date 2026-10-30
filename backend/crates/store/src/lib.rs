//! OpenShell 本地存储：SQLite（WAL）、迁移、快照备份、仓储实现。

pub mod backup;
pub mod meta;
pub mod migrator;
pub mod models;
pub mod open;
pub mod repositories;

pub use backup::{BackupInfo, BackupReason, DEFAULT_KEEP_BACKUPS, MAX_KEEP_BACKUPS};
pub use migrator::{open_with_migration, MigrationOptions, MigrationReport, SCHEMA_VERSION};
pub use models::SettingRecord;
pub use open::Store;
pub use repositories::{
    AiProfileRepo, CommandHistoryRepo, CredentialRepo, GroupRepo, KnownHostRepo, PortForwardRepo,
    SecretRepo, SessionRepo, SettingsRepo, SnippetRepo, SshKeyRepo, VaultRepo,
};

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::*;

    #[tokio::test]
    async fn test_store_migration_and_repositories() {
        let store = Store::open_in_memory().expect("open in-memory db");
        let ver = store.migrate().expect("migration succeed");
        assert_eq!(ver, SCHEMA_VERSION);

        // Settings repo
        let settings_repo = SettingsRepo::new(store.clone());
        let saved = settings_repo
            .set("app", None, "theme", serde_json::json!("dracula"), true)
            .expect("save setting");
        assert_eq!(saved.value_json, serde_json::json!("dracula"));
        let val = settings_repo
            .get("app", None, "theme")
            .expect("read setting");
        assert_eq!(val.unwrap().value_json, serde_json::json!("dracula"));

        // Group repo
        let group_repo = GroupRepo::new(store.clone());
        let group = group_repo
            .create(None, "Production Servers".to_string(), GroupKind::Session)
            .await
            .expect("create group");
        assert_eq!(group.name, "Production Servers");
        let groups = group_repo
            .list(GroupKind::Session)
            .await
            .expect("list groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Production Servers");
    }

    /// 回归用例：`migrate()` 不得改写用户显式设置的严格主机密钥策略。
    ///
    /// 历史实现每次启动都会执行 `UPDATE session SET host_key_policy='accept_new'`，
    /// 把 strict 静默降级，导致中间人攻击无法被察觉。此用例锁死该行为。
    #[tokio::test]
    async fn test_migrate_keeps_strict_host_key_policy() {
        let store = Store::open_in_memory().expect("open in-memory db");
        store.migrate().expect("migration succeed");

        let session_repo = SessionRepo::new(store.clone());
        let session = session_repo
            .create(SessionInput {
                name: Some("strict-host".to_string()),
                host_key_policy: Some(HostKeyPolicy::Strict),
                ..Default::default()
            })
            .await
            .expect("create session");
        assert_eq!(session.host_key_policy, HostKeyPolicy::Strict);

        // 再次迁移等价于应用重启
        store.migrate().expect("re-migrate succeed");
        let reloaded = session_repo.get(&session.id).await.expect("get session");
        assert_eq!(reloaded.host_key_policy, HostKeyPolicy::Strict);
    }
}
