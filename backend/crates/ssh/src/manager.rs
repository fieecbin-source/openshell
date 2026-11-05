use crate::connection::{ConnectOptions, SshConnection};
use async_trait::async_trait;
use openshell_core_domain::{
    ByteStream, ChannelOpener, ConnectionId, DomainError, DomainResult, ErrorCode, ExecOutput,
    KnownHostRepository, RemoteForwardHandle, TermSize,
};
use std::collections::HashMap;

use std::sync::Arc;
use tokio::sync::RwLock;

pub struct SshConnectionManager {
    connections: Arc<RwLock<HashMap<ConnectionId, Arc<SshConnection>>>>,
}

impl SshConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn connect(
        &self,
        opts: ConnectOptions,
        known_host_repo: Option<Arc<dyn KnownHostRepository>>,
    ) -> DomainResult<ConnectionId> {
        let conn_id = opts.connection_id.clone();
        let conn = Arc::new(SshConnection::connect(opts, known_host_repo).await?);
        let mut conns = self.connections.write().await;
        conns.insert(conn_id.clone(), conn);
        Ok(conn_id)
    }

    pub async fn connect_via_proxy(
        &self,
        opts: ConnectOptions,
        repo: Option<Arc<dyn KnownHostRepository>>,
        proxy: Option<&openshell_core_domain::ProxyServerConfig>,
    ) -> DomainResult<ConnectionId> {
        let id = opts.connection_id.clone();
        let conn = Arc::new(SshConnection::connect_via_proxy(opts, repo, proxy).await?);
        self.connections.write().await.insert(id.clone(), conn);
        Ok(id)
    }

    pub async fn connect_stream<S>(
        &self,
        opts: ConnectOptions,
        repo: Option<Arc<dyn KnownHostRepository>>,
        stream: S,
    ) -> DomainResult<ConnectionId>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let id = opts.connection_id.clone();
        let conn = Arc::new(SshConnection::connect_stream(opts, repo, stream).await?);
        self.connections.write().await.insert(id.clone(), conn);
        Ok(id)
    }

    pub async fn disconnect(&self, c: &ConnectionId) -> DomainResult<()> {
        let conn = {
            let mut conns = self.connections.write().await;
            conns.remove(c)
        };
        if let Some(conn) = conn {
            conn.close().await?;
            Ok(())
        } else {
            Err(DomainError::new(
                ErrorCode::NotFound,
                format!("connection not found: {c}"),
            ))
        }
    }

    pub async fn get(&self, c: &ConnectionId) -> DomainResult<Arc<SshConnection>> {
        let conns = self.connections.read().await;
        conns.get(c).cloned().ok_or_else(|| {
            DomainError::new(ErrorCode::NotFound, format!("connection not found: {c}"))
        })
    }

    pub async fn list(&self) -> Vec<ConnectionId> {
        let conns = self.connections.read().await;
        conns.keys().cloned().collect()
    }

    /// 仅当连接仍登记在管理器中时才移除，返回是否真的移除了。
    ///
    /// 用于「连接被远端关闭」的清理路径：如果用户已经主动断开（条目已被
    /// `disconnect` 移除），这里返回 false，调用方就不会重复发 Closed 事件。
    pub async fn remove_if_active(&self, c: &ConnectionId) -> bool {
        let mut conns = self.connections.write().await;
        conns.remove(c).is_some()
    }
}

impl Default for SshConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ChannelOpener for SshConnectionManager {
    async fn open_shell(
        &self,
        c: &ConnectionId,
        size: TermSize,
    ) -> DomainResult<Box<dyn ByteStream>> {
        let conn = self.get(c).await?;
        conn.open_shell(size).await
    }

    async fn open_exec(&self, c: &ConnectionId, cmd: &str) -> DomainResult<ExecOutput> {
        let conn = self.get(c).await?;
        conn.open_exec(cmd).await
    }

    async fn open_direct_tcpip(
        &self,
        c: &ConnectionId,
        host: &str,
        port: u16,
    ) -> DomainResult<Box<dyn ByteStream>> {
        let conn = self.get(c).await?;
        conn.open_direct_tcpip(host, port).await
    }

    async fn open_sftp(&self, c: &ConnectionId) -> DomainResult<Box<dyn ByteStream>> {
        let conn = self.get(c).await?;
        conn.open_sftp().await
    }

    async fn bind_remote(
        &self,
        _c: &ConnectionId,
        _host: &str,
        _port: u16,
    ) -> DomainResult<Box<dyn RemoteForwardHandle>> {
        Err(DomainError::new(
            ErrorCode::Unsupported,
            "use SshConnection::start_remote_forward with an explicit destination",
        ))
    }
}
