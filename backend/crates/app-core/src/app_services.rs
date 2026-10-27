//! OpenShell 装配根：初始化存储、仓储、管理器与业务服务。

use crate::connection_service::ConnectionService;
use crate::event_bus::EventBus;
use crate::extension_registry::ExtensionRegistry;
use crate::op_registry::OpRegistry;
use crate::session_service::SessionService;
use crate::sync_service::SyncService;
use crate::terminal_router::TerminalRouter;
use crate::vault_service::VaultService;
use openshell_core_domain::{AppPaths, ConnectionId, DomainError, DomainResult, ErrorCode};
use openshell_forward::ForwardManager;
use openshell_monitor::MonitorEngine;
use openshell_sftp::{CwdTracker, SftpClient, SftpSession, TransferManager};
use openshell_ssh::SshConnectionManager;
use openshell_store::backup::{
    self, BackupInfo, BackupReason, DEFAULT_KEEP_BACKUPS, MAX_KEEP_BACKUPS,
};
use openshell_store::meta;
use openshell_store::{
    open_with_migration, CredentialRepo, GroupRepo, KnownHostRepo, MigrationOptions,
    MigrationReport, PortForwardRepo, SecretRepo, SessionRepo, SettingsRepo, SnippetRepo,
    SshKeyRepo, Store, VaultRepo, SCHEMA_VERSION,
};
use openshell_vault::VaultManager;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::card_service::CardService;
use openshell_serial::SerialService;

/// 当前客户端版本，与 Cargo workspace 版本同源（由 `scripts/version.mjs` 保证一致）。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 设置表中「自动备份保留份数」的键（scope = `user`）。
pub const SETTING_BACKUP_KEEP: &str = "update.backupKeep";

pub struct AppServices {
    pub paths: AppPaths,
    pub store: Store,
    pub vault: Arc<VaultService>,
    pub session: Arc<SessionService>,
    pub connection: Arc<ConnectionService>,
    pub terminal: Arc<TerminalRouter>,
    pub event_bus: Arc<EventBus>,
    pub op_registry: Arc<OpRegistry>,
    pub ssh_manager: Arc<SshConnectionManager>,
    pub snippet_repo: Arc<SnippetRepo>,
    pub port_forward_repo: Arc<PortForwardRepo>,
    pub settings_repo: Arc<SettingsRepo>,
    pub sftp_transfers: Arc<TransferManager>,
    pub cwd_tracker: Arc<CwdTracker>,
    pub monitor: Arc<MonitorEngine>,
    pub forward: Arc<ForwardManager>,
    pub sftp_clients: Arc<tokio::sync::Mutex<HashMap<ConnectionId, Arc<SftpClient>>>>,
    pub sync: Arc<SyncService>,
    pub extensions: Arc<ExtensionRegistry>,
    pub card: Arc<CardService>,
    pub serial: Arc<SerialService>,
    /// 启动时的迁移/恢复情况（迁移失败已回滚时 `was_recovered()` 为 true，前端据此提示）。
    pub migration: MigrationReport,
}

impl AppServices {
    /// 以指定应用数据目录启动装配根。
    ///
    /// 迁移失败会自动用迁移前快照恢复并以旧 schema 启动，因此这里的 `Err`
    /// 只代表「数据目录不可用」或「本地数据比程序更新」，两种情况都不应继续运行。
    pub fn new(data_dir: PathBuf) -> DomainResult<Self> {
        let paths = AppPaths::new(data_dir);
        std::fs::create_dir_all(&paths.backups_dir)?;
        // 迁移阶段还没法读设置（库未打开），先用默认保留份数；用户自定义值在启动后裁剪时生效。
        let opts = MigrationOptions {
            app_version: APP_VERSION.to_string(),
            backups_dir: paths.backups_dir.clone(),
            keep_backups: DEFAULT_KEEP_BACKUPS,
        };
        let (store, migration) = open_with_migration(&paths.db_path, &opts)?;

        Self::init_with_store(paths, store, migration)
    }

    /// 内存模式（测试使用）。
    pub fn new_in_memory() -> DomainResult<Self> {
        let paths = AppPaths::new(PathBuf::from(":memory:"));
        let store = Store::open_in_memory()?;
        store.migrate()?;

        Self::init_with_store(paths, store, MigrationReport::default())
    }

    /// 立即创建一份数据快照（安装更新前、用户手动备份时调用）。
    ///
    /// `reason` 决定文件名与是否参与保留策略裁剪（手动快照永不自动删除）。
    pub fn backup_now(&self, reason: BackupReason) -> DomainResult<BackupInfo> {
        let info = backup::create(&self.store, &self.paths.backups_dir, APP_VERSION, reason)?;
        if reason.is_prunable() {
            let keep = self.backup_keep();
            if let Err(err) = backup::prune(&self.paths.backups_dir, keep) {
                tracing::warn!(error = %err, "failed to prune old backups");
            }
        }
        Ok(info)
    }

    /// 列出本目录下的全部快照（新 → 旧）。
    pub fn list_backups(&self) -> DomainResult<Vec<BackupInfo>> {
        backup::list(&self.paths.backups_dir)
    }

    /// 自动快照保留份数，来自设置表，缺省 5，取值范围 1..=20。
    pub fn backup_keep(&self) -> usize {
        self.settings_repo
            .get("user", None, SETTING_BACKUP_KEEP)
            .ok()
            .flatten()
            .and_then(|record| record.value_json.as_u64())
            .map(|raw| (raw as usize).clamp(1, MAX_KEEP_BACKUPS))
            .unwrap_or(DEFAULT_KEEP_BACKUPS)
    }

    fn init_with_store(
        paths: AppPaths,
        store: Store,
        migration: MigrationReport,
    ) -> DomainResult<Self> {
        let vault_repo = Arc::new(VaultRepo::new(store.clone()));
        let group_repo = Arc::new(GroupRepo::new(store.clone()));
        let session_repo = Arc::new(SessionRepo::new(store.clone()));
        let credential_repo = Arc::new(CredentialRepo::new(store.clone()));
        let ssh_key_repo = Arc::new(SshKeyRepo::new(store.clone()));
        let known_host_repo = Arc::new(KnownHostRepo::new(store.clone()));
        let settings_repo = Arc::new(SettingsRepo::new(store.clone()));
        let secret_repo = Arc::new(SecretRepo::new(store.clone()));

        let vault_manager = Arc::new(VaultManager::new());
        let event_bus = Arc::new(EventBus::new(512));
        let op_registry = Arc::new(OpRegistry::new());
        let ssh_manager = Arc::new(SshConnectionManager::new());

        let vault_service = Arc::new(VaultService::new(
            vault_manager.clone(),
            vault_repo.clone(),
            credential_repo.clone(),
            ssh_key_repo.clone(),
            secret_repo.clone(),
            event_bus.clone(),
        ));

        let session_service = Arc::new(SessionService::new(
            session_repo.clone(),
            group_repo.clone(),
            credential_repo.clone(),
            ssh_key_repo.clone(),
            known_host_repo.clone(),
            settings_repo.clone(),
            secret_repo.clone(),
            vault_manager.clone(),
            event_bus.clone(),
        ));

        let connection_service = Arc::new(ConnectionService::new(
            session_repo.clone(),
            known_host_repo.clone(),
            vault_service.clone(), // implements SecretResolver
            ssh_manager.clone(),
            op_registry.clone(),
            event_bus.clone(),
        ));

        let terminal_router = Arc::new(TerminalRouter::new(event_bus.clone()));

        let snippet_repo = Arc::new(SnippetRepo::new(store.clone()));
        let port_forward_repo = Arc::new(PortForwardRepo::new(store.clone()));
        let sftp_transfers = Arc::new(TransferManager::new(2));
        let cwd_tracker = Arc::new(CwdTracker::new());
        let monitor = Arc::new(MonitorEngine::new());
        let forward = Arc::new(ForwardManager::new());
        let sftp_clients = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let sync_service = Arc::new(SyncService::new(store.clone(), vault_manager.clone()));
        let extensions = Arc::new(ExtensionRegistry::new());
        let card_service = Arc::new(CardService::new(session_repo.clone(), event_bus.clone()));
        let serial_service = Arc::new(SerialService::new());

        // 升级后首次启动：留一份「迁移已完成」的快照，作为后续问题的回退锚点。
        // 迁移失败已回滚（schema 仍是旧版本）时不写 app_meta —— 旧库还没有这张表。
        if migration.was_recovered() {
            tracing::warn!(
                snapshot = migration
                    .recovered_from
                    .as_ref()
                    .map(|b| b.file_name.as_str())
                    .unwrap_or(""),
                "started with restored pre-migration snapshot"
            );
        } else if migration.schema_version == SCHEMA_VERSION {
            match meta::record_startup(&store, APP_VERSION) {
                Ok(Some(previous)) if previous != APP_VERSION => {
                    match backup::create(
                        &store,
                        &paths.backups_dir,
                        APP_VERSION,
                        BackupReason::PostUpgrade,
                    ) {
                        Ok(info) => {
                            tracing::info!(
                                from = %previous,
                                to = APP_VERSION,
                                file = %info.file_name,
                                "app upgraded, post-upgrade snapshot created"
                            );
                            if let Err(err) =
                                backup::prune(&paths.backups_dir, DEFAULT_KEEP_BACKUPS)
                            {
                                tracing::warn!(error = %err, "failed to prune backups after upgrade");
                            }
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "failed to create post-upgrade snapshot")
                        }
                    }
                }
                Ok(_) => {}
                Err(err) => tracing::warn!(error = %err, "failed to record app version"),
            }
        }

        Ok(Self {
            paths,
            store,
            migration,
            vault: vault_service,
            session: session_service,
            connection: connection_service,
            terminal: terminal_router,
            event_bus,
            op_registry,
            ssh_manager,
            snippet_repo,
            port_forward_repo,
            settings_repo,
            sftp_transfers,
            cwd_tracker,
            monitor,
            forward,
            sftp_clients,
            sync: sync_service,
            extensions,
            card: card_service,
            serial: serial_service,
        })
    }

    /// 获取或懒加载指定连接的 SFTP 客户端。
    pub async fn get_or_create_sftp(
        &self,
        conn_id: &ConnectionId,
    ) -> DomainResult<Arc<SftpClient>> {
        let mut lock = self.sftp_clients.lock().await;
        if let Some(client) = lock.get(conn_id) {
            return Ok(Arc::clone(client));
        }
        let conn = self.ssh_manager.get(conn_id).await?;
        let stream = conn.open_sftp().await?;
        let session = SftpSession::new(stream)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp init error: {e}")))?;
        let client = Arc::new(SftpClient::new(session));
        lock.insert(conn_id.clone(), Arc::clone(&client));
        Ok(client)
    }

    /// 移除失效连接的 SFTP 客户端缓存。
    pub async fn remove_sftp_client(&self, conn_id: &ConnectionId) {
        let mut lock = self.sftp_clients.lock().await;
        lock.remove(conn_id);
    }
}
