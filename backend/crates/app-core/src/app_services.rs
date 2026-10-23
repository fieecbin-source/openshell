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
use openshell_store::{
    CredentialRepo, GroupRepo, KnownHostRepo, PortForwardRepo, SecretRepo, SessionRepo,
    SettingsRepo, SnippetRepo, SshKeyRepo, Store, VaultRepo,
};
use openshell_vault::VaultManager;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::card_service::CardService;
use openshell_serial::SerialService;

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
}

impl AppServices {
    /// 以指定应用数据目录启动装配根。
    pub fn new(data_dir: PathBuf) -> DomainResult<Self> {
        let paths = AppPaths::new(data_dir);
        let store = Store::open(&paths.db_path)?;
        store.migrate()?;

        Self::init_with_store(paths, store)
    }

    /// 内存模式（测试使用）。
    pub fn new_in_memory() -> DomainResult<Self> {
        let paths = AppPaths::new(PathBuf::from(":memory:"));
        let store = Store::open_in_memory()?;
        store.migrate()?;

        Self::init_with_store(paths, store)
    }

    fn init_with_store(paths: AppPaths, store: Store) -> DomainResult<Self> {
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

        Ok(Self {
            paths,
            store,
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
