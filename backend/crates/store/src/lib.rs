//! OpenShell 本地存储：SQLite（WAL）、迁移、仓储实现。

pub mod migrator;
pub mod models;
pub mod open;
pub mod repositories;

pub use migrator::SCHEMA_VERSION;
pub use models::SettingRecord;
pub use open::Store;
pub use repositories::{
    CredentialRepo, GroupRepo, KnownHostRepo, PortForwardRepo, SecretRepo, SessionRepo,
    SettingsRepo, SnippetRepo, SshKeyRepo, VaultRepo,
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
}
