//! 端口契约：适配层实现，编排层只依赖这些 trait。

use crate::entities::*;
use crate::errors::DomainResult;
use crate::ids::*;
use crate::value_objects::*;
use async_trait::async_trait;
use std::path::PathBuf;
use tokio::io::{AsyncRead, AsyncWrite};

/// 会话查询。
#[derive(Debug, Clone, Default)]
pub struct SessionQuery {
    pub group_id: Option<GroupId>,
    pub query: Option<String>,
    pub protocol: Option<Protocol>,
    pub favorite_only: bool,
    pub include_deleted: bool,
    pub limit: u32,
    pub offset: u32,
}

#[async_trait]
pub trait SessionRepository: Send + Sync {
    async fn list(&self, q: &SessionQuery) -> DomainResult<Vec<Session>>;
    async fn get(&self, id: &SessionId) -> DomainResult<Session>;
    async fn create(&self, input: SessionInput) -> DomainResult<Session>;
    async fn update(
        &self,
        id: &SessionId,
        patch: SessionPatch,
        expected_local_rev: Option<i64>,
    ) -> DomainResult<Session>;
    async fn delete(&self, id: &SessionId) -> DomainResult<()>;
    async fn restore(&self, id: &SessionId) -> DomainResult<Session>;
    async fn touch_used(&self, id: &SessionId, result: &str) -> DomainResult<()>;
}

#[async_trait]
pub trait GroupRepository: Send + Sync {
    async fn list(&self, kind: GroupKind) -> DomainResult<Vec<Group>>;
    async fn create(
        &self,
        parent_id: Option<GroupId>,
        name: String,
        kind: GroupKind,
    ) -> DomainResult<Group>;
    async fn rename(&self, id: &GroupId, name: String) -> DomainResult<Group>;
    async fn delete(&self, id: &GroupId) -> DomainResult<()>;
    async fn move_to(
        &self,
        id: &GroupId,
        parent_id: Option<GroupId>,
        sort_order: i64,
    ) -> DomainResult<Group>;
}

#[async_trait]
pub trait CredentialRepository: Send + Sync {
    async fn list(&self) -> DomainResult<Vec<Credential>>;
    async fn get(&self, id: &CredentialId) -> DomainResult<Credential>;
    /// 保存凭据元数据与加密秘密（同一事务）。
    async fn create(
        &self,
        cred: Credential,
        secret: SecretRecord,
        material: SecretMaterial,
    ) -> DomainResult<Credential>;
    async fn delete(&self, id: &CredentialId) -> DomainResult<()>;
}

#[async_trait]
pub trait SshKeyRepository: Send + Sync {
    async fn list(&self) -> DomainResult<Vec<SshKey>>;
    async fn get(&self, id: &SshKeyId) -> DomainResult<SshKey>;
    async fn create(
        &self,
        key: SshKey,
        secret: SecretRecord,
        material: SecretMaterial,
    ) -> DomainResult<SshKey>;
    async fn delete(&self, id: &SshKeyId) -> DomainResult<()>;
}

#[async_trait]
pub trait KnownHostRepository: Send + Sync {
    async fn find(&self, host: &str, port: u16, key_type: &str) -> DomainResult<Option<KnownHost>>;
    async fn upsert_trusted(&self, host: KnownHost) -> DomainResult<KnownHost>;
    async fn mark_changed(&self, id: &KnownHostId, new_fingerprint: &str) -> DomainResult<()>;
    async fn list(&self) -> DomainResult<Vec<KnownHost>>;
    async fn delete(&self, id: &KnownHostId) -> DomainResult<()>;
}

/// 保险库解锁状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked,
}

/// 秘密解析策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptPolicy {
    /// 允许交互式询问（连接流程）。
    Interactive,
    /// 仅使用已保存的秘密，缺失即失败（后台任务）。
    StoredOnly,
}

/// 凭据解析：`ssh` 适配层不直接读数据库。
#[async_trait]
pub trait SecretResolver: Send + Sync {
    async fn resolve_credential(
        &self,
        id: &CredentialId,
        policy: PromptPolicy,
    ) -> DomainResult<SecretMaterial>;
    async fn resolve_ssh_key(
        &self,
        id: &SshKeyId,
        policy: PromptPolicy,
    ) -> DomainResult<SecretMaterial>;
}

/// 秘密存储（由 `vault` 实现）。
#[async_trait]
pub trait SecretStore: Send + Sync {
    fn is_unlocked(&self) -> bool;
    fn encrypt_secret(
        &self,
        secret_id: &SecretId,
        record_type: &str,
        plaintext: &[u8],
    ) -> DomainResult<SecretRecord>;
    fn decrypt_secret(&self, record: &SecretRecord) -> DomainResult<Vec<u8>>;
}

/// 双向字节流（终端通道/SFTP 通道）。
pub trait ByteStream: AsyncRead + AsyncWrite + Send + Unpin {
    fn resize(&mut self, size: TermSize) -> DomainResult<()>;
    fn close(self: Box<Self>) -> DomainResult<()>;
}

/// 远端转发监听句柄。
#[async_trait]
pub trait RemoteForwardHandle: Send {
    async fn accept(&mut self) -> DomainResult<Box<dyn ByteStream>>;
    fn bound_addr(&self) -> std::net::SocketAddr;
    async fn close(&mut self) -> DomainResult<()>;
}

/// 命令执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u32>,
}

use serde::{Deserialize, Serialize};

/// 打开通道：由 `ssh` 适配层实现。
#[async_trait]
pub trait ChannelOpener: Send + Sync {
    async fn open_shell(
        &self,
        c: &ConnectionId,
        size: TermSize,
    ) -> DomainResult<Box<dyn ByteStream>>;
    async fn open_exec(&self, c: &ConnectionId, cmd: &str) -> DomainResult<ExecOutput>;
    async fn open_direct_tcpip(
        &self,
        c: &ConnectionId,
        host: &str,
        port: u16,
    ) -> DomainResult<Box<dyn ByteStream>>;
    async fn open_sftp(&self, c: &ConnectionId) -> DomainResult<Box<dyn ByteStream>>;
    async fn bind_remote(
        &self,
        c: &ConnectionId,
        host: &str,
        port: u16,
    ) -> DomainResult<Box<dyn RemoteForwardHandle>>;
}

/// 应用数据目录。
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub log_dir: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join("openshell.db"),
            log_dir: data_dir.join("logs"),
            data_dir,
        }
    }
}

/// 主机密钥决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    Trust,
    TrustOnce,
    Reject,
}

#[async_trait]
pub trait SnippetRepository: Send + Sync {
    async fn list(&self, group_id: Option<&GroupId>) -> DomainResult<Vec<Snippet>>;
    async fn get(&self, id: &SnippetId) -> DomainResult<Snippet>;
    async fn create(&self, input: SnippetInput) -> DomainResult<Snippet>;
    async fn update(&self, id: &SnippetId, input: SnippetInput) -> DomainResult<Snippet>;
    async fn delete(&self, id: &SnippetId) -> DomainResult<()>;
}

#[async_trait]
pub trait PortForwardRepository: Send + Sync {
    async fn list(&self, session_id: Option<&SessionId>) -> DomainResult<Vec<PortForwardRule>>;
    async fn get(&self, id: &PortForwardId) -> DomainResult<PortForwardRule>;
    async fn create(&self, input: PortForwardRuleInput) -> DomainResult<PortForwardRule>;
    async fn update(
        &self,
        id: &PortForwardId,
        input: PortForwardRuleInput,
    ) -> DomainResult<PortForwardRule>;
    async fn delete(&self, id: &PortForwardId) -> DomainResult<()>;
}
