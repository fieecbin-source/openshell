use crate::connection::{ConnectOptions, SshConnection};
use async_trait::async_trait;
use openshell_core_domain::{
    ByteStream, ChannelOpener, ConnectionId, DomainError, DomainResult, ErrorCode, ExecOutput,
    KnownHostRepository, RemoteForwardHandle, TermSize,
};
use std::collections::HashMap;
use std::net::SocketAddr;
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
}

impl Default for SshConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

struct DummyRemoteHandle {
    addr: SocketAddr,
}

#[async_trait]
impl RemoteForwardHandle for DummyRemoteHandle {
    async fn accept(&mut self) -> DomainResult<Box<dyn ByteStream>> {
        Err(DomainError::new(
            ErrorCode::Unsupported,
            "remote port forward incoming accept not yet attached",
        ))
    }

    fn bound_addr(&self) -> SocketAddr {
        self.addr
    }

    async fn close(&mut self) -> DomainResult<()> {
        Ok(())
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
        port: u16,
    ) -> DomainResult<Box<dyn RemoteForwardHandle>> {
        let addr = format!("127.0.0.1:{}", port)
            .parse::<SocketAddr>()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));
        Ok(Box::new(DummyRemoteHandle { addr }))
    }
}
