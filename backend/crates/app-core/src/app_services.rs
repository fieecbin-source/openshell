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

use crate::ai_service::AiService;
use crate::card_service::CardService;
use openshell_serial::SerialService;

/// 当前客户端版本，与 Cargo workspace 版本同源（由 `scripts/version.mjs` 保证一致）。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 设置表中「自动备份保留份数」的键（scope = `user`）。
pub const SETTING_BACKUP_KEEP: &str = "update.backup_keep";

pub struct AppServices {
    pub paths: AppPaths,
    pub store: Store,
    pub vault: Arc<VaultService>,
    pub archive: Arc<crate::archive_service::ArchiveService>,
    pub network_secrets: Arc<crate::network_secrets::NetworkSecrets>,
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
    /// AI 终端助手配置服务（默认关闭，由设置页开关启用）。
    pub ai: Arc<AiService>,
}

impl AppServices {
    /// 以指定应用数据目录启动装配根。
    ///
    /// 迁移失败会自动用迁移前快照恢复并以旧 schema 启动，因此这里的 `Err`
    /// 只代表「数据目录不可用」或「本地数据比程序更新」，两种情况都不应继续运行。
    pub fn new(data_dir: PathBuf) -> DomainResult<Self> {
        let paths = AppPaths::new(data_dir);
        std::fs::create_dir_all(&paths.backups_dir)?;
        // 迁移成功后读取规范键及旧键，读取失败时保留全部快照。
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

    /// 主密码解锁后列出仅含安全元数据的待补录项；错误主密码在此即失败，原库与备份不动。
    pub fn inspect_legacy_recovery(
        data_dir: PathBuf,
        master_password: &str,
    ) -> DomainResult<Vec<crate::network_secrets::LegacyRecoveryItem>> {
        let (_, network, _) = Self::unlock_legacy_store(data_dir, master_password)?;
        network.legacy_recovery_items()
    }

    /// 取消保留：不写库、不覆盖备份，供启动编排如实告知用户可重试。
    pub fn cancel_legacy_recovery() -> DomainResult<()> {
        Err(DomainError::new(
            ErrorCode::VaultLocked,
            "已取消数据恢复；原数据库与备份保持不变，可重新启动后重试或改走逐条补录",
        ))
    }

    fn unlock_legacy_store(
        data_dir: PathBuf,
        master_password: &str,
    ) -> DomainResult<(
        Store,
        crate::network_secrets::NetworkSecrets,
        Arc<VaultService>,
    )> {
        let paths = AppPaths::new(data_dir);
        if !paths.db_path.is_file() {
            return Err(DomainError::not_found("旧数据库不存在"));
        }
        let store = Store::open(&paths.db_path)?;
        let version = store.schema_version()?;
        if version == 0 || version > SCHEMA_VERSION {
            return Err(DomainError::validation("此数据库不能使用凭据恢复入口"));
        }
        let manager = Arc::new(VaultManager::new());
        let vault = Arc::new(VaultService::new(
            manager.clone(),
            Arc::new(VaultRepo::new(store.clone())),
            Arc::new(CredentialRepo::new(store.clone())),
            Arc::new(SshKeyRepo::new(store.clone())),
            Arc::new(SecretRepo::new(store.clone())),
            Arc::new(EventBus::new(512)),
        ));
        if vault.status()?.state == "uninitialized" {
            vault.init(master_password, false, None)?;
        } else {
            vault.unlock(Some(master_password), false)?;
        }
        let network = crate::network_secrets::NetworkSecrets::new(store.clone(), manager);
        Ok((store, network, vault))
    }

    /// Unlock the old schema before any snapshot; credentials and references commit together.
    ///
    /// 若仍有来源不明项，返回带 `recovery_items` 的错误（仅安全元数据），
    /// 使启动入口能逐条补录或取消，而不是反复只问主密码后退出。
    pub fn recover_legacy_network_secrets(
        data_dir: PathBuf,
        master_password: &str,
    ) -> DomainResult<Self> {
        let (store, network, vault) = Self::unlock_legacy_store(data_dir.clone(), master_password)?;
        let items = network.legacy_recovery_items()?;
        if !items.is_empty() {
            return Err(DomainError::new(
                ErrorCode::VaultLocked,
                "部分规则凭据来源不明，请逐条补录或取消保留",
            )
            .with_details(serde_json::json!({
                "requires_reentry": true,
                "recovery_items": items,
            })));
        }
        network.migrate_legacy()?;
        drop(network);
        drop(vault);
        drop(store);
        let services = Self::new(data_dir)?;
        services.vault.unlock(Some(master_password), false)?;
        Ok(services)
    }

    /// 逐条显式补录后恢复；新口令由调用方以 Zeroizing 持有，单事务提交或整事务回滚。
    pub fn recover_legacy_network_secrets_with_reentry(
        data_dir: PathBuf,
        master_password: &str,
        entries: &[crate::network_secrets::LegacyRecoveryEntry],
    ) -> DomainResult<Self> {
        let (store, network, vault) = Self::unlock_legacy_store(data_dir.clone(), master_password)?;
        let pending = network.legacy_recovery_items()?;
        if pending.is_empty() {
            return Err(DomainError::validation("没有需要补录的规则"));
        }
        // 补录与凭据迁移已在同一事务内提交；此处不重复迁移，避免留下半提交状态。
        let applied = network.reenter_legacy_socks(entries)?;
        if applied != pending.len() {
            return Err(DomainError::validation("仍有规则需要逐条补录"));
        }
        drop(network);
        drop(vault);
        drop(store);
        let services = Self::new(data_dir)?;
        services.vault.unlock(Some(master_password), false)?;
        Ok(services)
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
        backup::retention_count(&self.store, DEFAULT_KEEP_BACKUPS).unwrap_or(MAX_KEEP_BACKUPS)
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
        let network_secrets = Arc::new(crate::network_secrets::NetworkSecrets::new(
            store.clone(),
            vault_manager.clone(),
        ));
        // 仅记录凭据已验证状态；缺标记不证明旧值是明文，记录失败不阻断启动。
        if let Err(error) = network_secrets.record_reference_store_if_clean() {
            tracing::warn!(%error, "failed to probe credential store provenance");
        }
        let archive = Arc::new(crate::archive_service::ArchiveService::new(
            store.clone(),
            vault_manager.clone(),
        ));
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
            network_secrets.clone(),
        ));

        let terminal_router = Arc::new(TerminalRouter::new(event_bus.clone()));

        let snippet_repo = Arc::new(SnippetRepo::new(store.clone()));
        let port_forward_repo = Arc::new(PortForwardRepo::new(store.clone()));
        // 4 路并发（上限 8）：配合 512 KiB 分块与 1 MiB 缓冲，把单条 SFTP 通道的
        // 串行往返等待摊到多条子通道上，彻底消除「伪限速」。
        let sftp_transfers = Arc::new(TransferManager::new(4));
        let cwd_tracker = Arc::new(CwdTracker::new());
        let monitor = Arc::new(MonitorEngine::new());
        let forward = Arc::new(ForwardManager::new());
        let sftp_clients = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let sync_service = Arc::new(SyncService::new(store.clone(), vault_manager.clone()));
        let extensions = Arc::new(ExtensionRegistry::new());
        let card_service = Arc::new(CardService::new(session_repo.clone(), event_bus.clone()));
        let serial_service = Arc::new(SerialService::new());
        let ai_service = Arc::new(AiService::new(
            &paths,
            store.clone(),
            vault_manager.clone(),
        )?);

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
                            if let Err(err) = backup::retention_count(&store, DEFAULT_KEEP_BACKUPS)
                                .and_then(|keep| backup::prune(&paths.backups_dir, keep))
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
            network_secrets,
            archive,
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
            ai: ai_service,
        })
    }

    /// 获取或懒加载指定连接的 SFTP 客户端。
    ///
    /// 复刻 FinalShell `zD.I()` 的前置判定：只有在底层 SSH 会话仍存活时才复用/新建
    /// SFTP 子通道；会话已关闭时先清掉失效缓存并直接报错，避免把「已死的通道」
    /// 反复交给上层。
    pub async fn get_or_create_sftp(
        &self,
        conn_id: &ConnectionId,
    ) -> DomainResult<Arc<SftpClient>> {
        let mut lock = self.sftp_clients.lock().await;
        let conn = self.ssh_manager.get(conn_id).await?;
        if *conn.closed_channel().borrow() {
            lock.remove(conn_id);
            return Err(DomainError::new(
                ErrorCode::Io,
                format!("connection {conn_id} is closed, cannot open sftp channel"),
            ));
        }
        if let Some(client) = lock.get(conn_id) {
            return Ok(Arc::clone(client));
        }
        let stream = conn.open_sftp().await?;
        let session = SftpSession::new(stream)
            .await
            .map_err(|e| DomainError::new(ErrorCode::Io, format!("sftp init error: {e}")))?;
        let client = Arc::new(SftpClient::new(session));
        lock.insert(conn_id.clone(), Arc::clone(&client));
        Ok(client)
    }

    /// 清理旧缓存并重开一条全新的 SFTP 子系统通道（Auto-Heal）。
    ///
    /// 触发场景：SFTP 子通道因空闲超时 / 服务端 `MaxSessions` 回收 / 通道异常而失效，
    /// 但 SSH 主会话仍然存活。此时丢弃旧 `SftpClient` 并透明地重开一次，
    /// 上层无需感知即可继续操作。
    pub async fn reconnect_sftp(&self, conn_id: &ConnectionId) -> DomainResult<Arc<SftpClient>> {
        self.remove_sftp_client(conn_id).await;
        self.get_or_create_sftp(conn_id).await
    }

    /// 移除失效连接的 SFTP 客户端缓存。
    pub async fn remove_sftp_client(&self, conn_id: &ConnectionId) {
        let mut lock = self.sftp_clients.lock().await;
        lock.remove(conn_id);
    }
}

#[cfg(test)]
mod backup_retention_tests {
    use super::*;

    #[test]
    fn canonical_backup_retention_takes_precedence() {
        let app = AppServices::new_in_memory().unwrap();
        app.settings_repo
            .set(
                "user",
                None,
                "update.backupKeep",
                serde_json::json!(7),
                false,
            )
            .unwrap();
        assert_eq!(app.backup_keep(), 7);
        app.settings_repo
            .set(
                "user",
                None,
                "update.backup_keep",
                serde_json::json!(20),
                false,
            )
            .unwrap();
        assert_eq!(app.backup_keep(), 20);
    }

    #[test]
    fn twenty_backups_survive_creation_and_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let app = AppServices::new(directory.path().to_path_buf()).unwrap();
        app.settings_repo
            .set(
                "user",
                None,
                "update.backup_keep",
                serde_json::json!(20),
                false,
            )
            .unwrap();
        for _ in 0..22 {
            app.backup_now(BackupReason::PreInstall).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(app.list_backups().unwrap().len(), 20);
        meta::set(&app.store, meta::KEY_LAST_APP_VERSION, "old-version").unwrap();
        drop(app);
        let reopened = AppServices::new(directory.path().to_path_buf()).unwrap();
        assert_eq!(reopened.list_backups().unwrap().len(), 20);
    }
}
