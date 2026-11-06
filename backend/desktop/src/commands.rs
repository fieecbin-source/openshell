//! Tauri IPC 命令实现（薄层：契约映射与参数校验）。

use crate::error::IpcError;
use openshell_app_core::{AppServices, ConnectOverrides, VaultStatus};
use openshell_core_domain::{
    AiCatalogView, AiConfigView, AiProfile, AiProfileInput, ChannelOpener, ConnectionId,
    Credential, CredentialId, CredentialKind, DomainError, ErrorCode, FileEntryType, Group,
    GroupId, GroupKind, HostMetrics, PortForwardId, PortForwardRepository, PortForwardRule,
    PortForwardRuleInput, PortForwardType, Protocol, ProviderTestResult, SavePolicy, Session,
    SessionId, SessionInput, SessionPatch, SessionQuery, SftpFileEntry, Snippet, SnippetId,
    SnippetInput, SnippetRepository, SshKey, SshKeyId, TabId, TermSize, TransferTask,
};
use openshell_forward::ForwardStatus;
use openshell_importer::{
    CandidateAction, ConflictStrategy, FinalShellParser, ImportCandidate, ImportPreviewEngine,
    ImportPreviewReport, OpenSshParser,
};
use openshell_store::SettingRecord;
use serde::Serialize;
use std::sync::Arc;

struct RdpRuntimeEntry {
    session_id: String,
    state: &'static str,
    error: Option<String>,
    exit_code: Option<i32>,
    child: Option<std::process::Child>,
    file: std::path::PathBuf,
    events: Option<Arc<std::sync::Mutex<crate::rdp_host::Status>>>,
    reader: Option<std::thread::JoinHandle<()>>,
    recorded_login: bool,
}

static RDP_LAUNCHES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, RdpRuntimeEntry>>,
> = std::sync::OnceLock::new();

fn rdp_launches() -> &'static std::sync::Mutex<std::collections::HashMap<String, RdpRuntimeEntry>> {
    RDP_LAUNCHES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn shutdown_rdp_launches() {
    let mut launches = rdp_launches()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for (launch_id, mut entry) in launches.drain() {
        if let Err(error) = crate::rdp_process::close(&mut entry.child, &entry.file) {
            tracing::error!(%launch_id,%error,"failed to close owned RDP host at application exit");
        } else if let Some(reader) = entry.reader.take() {
            let _ = reader.join();
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub version: &'static str,
    pub target: &'static str,
    pub arch: &'static str,
    pub data_dir: String,
    /// 本地数据库实际的 schema 版本（低于程序支持的版本表示处于「已恢复」状态）。
    pub schema_version: u32,
    /// 迁移失败并已从快照恢复：前端显示横幅，提示用户确认数据后继续使用。
    pub degraded: bool,
    /// 便携运行（可执行文件旁存在 `openshell.portable` 标记文件）。
    pub is_portable: bool,
}

#[derive(Debug, Serialize)]
pub struct ConnectSessionResult {
    pub connection_id: String,
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub accepted: usize,
}

#[derive(Debug, Serialize)]
pub struct AckResult {
    pub credit: i64,
}

#[tauri::command]
pub async fn app_info(state: tauri::State<'_, Arc<AppServices>>) -> Result<AppInfo, IpcError> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        target: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        schema_version: state.migration.schema_version,
        degraded: state.migration.was_recovered(),
        is_portable: is_portable(),
    })
}

/// 便携模式判定：可执行文件旁存在 `openshell.portable` 时提示前端关闭自动更新。
pub(crate) fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent()
                .map(|dir| dir.join("openshell.portable").exists())
        })
        .unwrap_or(false)
}

// ==========================================
// Vault
// ==========================================

#[tauri::command]
pub async fn vault_status(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<VaultStatus, IpcError> {
    state.vault.status().map_err(Into::into)
}

#[tauri::command]
pub async fn vault_init(
    state: tauri::State<'_, Arc<AppServices>>,
    master_password: String,
    remember_in_keychain: bool,
) -> Result<VaultStatus, IpcError> {
    state
        .vault
        .init(&master_password, remember_in_keychain, None)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn vault_unlock(
    state: tauri::State<'_, Arc<AppServices>>,
    master_password: Option<String>,
    use_keychain: bool,
) -> Result<VaultStatus, IpcError> {
    state
        .vault
        .unlock(master_password.as_deref(), use_keychain)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn vault_lock(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<VaultStatus, IpcError> {
    state.vault.lock().map_err(Into::into)
}

#[tauri::command]
pub async fn vault_change_password(
    state: tauri::State<'_, Arc<AppServices>>,
    old_password: String,
    new_password: String,
) -> Result<VaultStatus, IpcError> {
    state
        .vault
        .change_password(&old_password, &new_password)
        .map_err(Into::into)
}

// ==========================================
// Sessions
// ==========================================

#[tauri::command]
pub async fn session_list(
    state: tauri::State<'_, Arc<AppServices>>,
    group_id: Option<String>,
    query: Option<String>,
    protocol: Option<Protocol>,
    favorite_only: Option<bool>,
) -> Result<Vec<Session>, IpcError> {
    let group_id = group_id.and_then(|g| GroupId::from_string(g).ok());
    let q = SessionQuery {
        group_id,
        query,
        protocol,
        favorite_only: favorite_only.unwrap_or(false),
        include_deleted: false,
        limit: 1000,
        offset: 0,
    };
    state.session.list_sessions(&q).await.map_err(Into::into)
}

#[tauri::command]
pub async fn session_get(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<Session, IpcError> {
    let id = SessionId::from_string(id)?;
    state.session.get_session(&id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn session_create(
    state: tauri::State<'_, Arc<AppServices>>,
    input: SessionInput,
) -> Result<Session, IpcError> {
    state
        .session
        .create_session(input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn session_update(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    patch: SessionPatch,
    expected_local_rev: Option<i64>,
) -> Result<Session, IpcError> {
    let id = SessionId::from_string(id)?;
    state
        .session
        .update_session(&id, patch, expected_local_rev)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn session_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let id = SessionId::from_string(id)?;
    state.session.delete_session(&id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn session_duplicate(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<Session, IpcError> {
    let id = SessionId::from_string(id)?;
    state
        .session
        .duplicate_session(&id)
        .await
        .map_err(Into::into)
}

// ==========================================
// Groups
// ==========================================

#[tauri::command]
pub async fn group_list(
    state: tauri::State<'_, Arc<AppServices>>,
    kind: Option<GroupKind>,
) -> Result<Vec<Group>, IpcError> {
    state
        .session
        .list_groups(kind.unwrap_or(GroupKind::Session))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn group_create(
    state: tauri::State<'_, Arc<AppServices>>,
    parent_id: Option<String>,
    name: String,
    kind: Option<GroupKind>,
) -> Result<Group, IpcError> {
    let parent_id = parent_id.and_then(|p| GroupId::from_string(p).ok());
    state
        .session
        .create_group(parent_id, name, kind.unwrap_or(GroupKind::Session))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn group_rename(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    name: String,
) -> Result<Group, IpcError> {
    let id = GroupId::from_string(id)?;
    state
        .session
        .rename_group(&id, name)
        .await
        .map_err(Into::into)
}

/// 移动分组到新的父级并调整排序（拖拽移组 / 拖拽排序）。
///
/// 仓储层 `move_to` 已内置成环检测与 8 层深度上限，这里只做参数编解码。
/// `parent_id` 为 `None` 表示移到根层级。
#[tauri::command]
pub async fn group_move(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    parent_id: Option<String>,
    sort_order: Option<i64>,
) -> Result<Group, IpcError> {
    let id = GroupId::from_string(id)?;
    let parent_id = match parent_id {
        Some(p) => Some(GroupId::from_string(p)?),
        None => None,
    };
    state
        .session
        .move_group(&id, parent_id, sort_order.unwrap_or(1024))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn group_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let id = GroupId::from_string(id)?;
    state.session.delete_group(&id).await.map_err(Into::into)
}

// ==========================================
// Credentials
// ==========================================

#[tauri::command]
pub async fn credential_list(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<Credential>, IpcError> {
    state.session.list_credentials().await.map_err(Into::into)
}

#[tauri::command]
pub async fn credential_create(
    state: tauri::State<'_, Arc<AppServices>>,
    name: String,
    kind: CredentialKind,
    username: Option<String>,
    secret: String,
    hint: Option<String>,
    save_policy: Option<SavePolicy>,
) -> Result<Credential, IpcError> {
    state
        .session
        .create_credential(name, kind, username, &secret, hint, save_policy)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn credential_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let id = CredentialId::from_string(id)?;
    state
        .session
        .delete_credential(&id)
        .await
        .map_err(Into::into)
}

// ==========================================
// SSH Keys
// ==========================================

#[tauri::command]
pub async fn ssh_key_list(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<SshKey>, IpcError> {
    state.session.list_ssh_keys().await.map_err(Into::into)
}

#[tauri::command]
pub async fn ssh_key_import(
    state: tauri::State<'_, Arc<AppServices>>,
    name: String,
    pem: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<SshKey, IpcError> {
    state
        .session
        .import_ssh_key(name, &pem, passphrase, comment)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn ssh_key_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let id = SshKeyId::from_string(id)?;
    state.session.delete_ssh_key(&id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn ssh_key_set_passphrase(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    passphrase: String,
) -> Result<SshKey, IpcError> {
    let id = SshKeyId::from_string(id)?;
    state
        .session
        .set_ssh_key_passphrase(&id, &passphrase)
        .await
        .map_err(Into::into)
}

// ==========================================
// Connection & Terminal
// ==========================================

#[tauri::command]
pub async fn connect_session(
    state: tauri::State<'_, Arc<AppServices>>,
    request_id: String,
    session_id: String,
    overrides: Option<ConnectOverrides>,
) -> Result<ConnectSessionResult, IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    let cid = state
        .connection
        .connect_session(&request_id, &sid, overrides)
        .await?;
    Ok(ConnectSessionResult {
        connection_id: cid.to_string(),
        session_id,
    })
}

#[tauri::command]
pub async fn connection_close(
    state: tauri::State<'_, Arc<AppServices>>,
    connection_id: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&connection_id)?;
    // 先清理 SFTP 子通道缓存，再断开 SSH 主会话：
    // 否则缓存的 SftpClient 会指向一条已关闭的通道，下次同 ConnectionId 复用时
    // 只能拿到「通道已死」的错误（复刻 FinalShell 关闭会话时同步释放 zD 缓存的顺序）。
    state.remove_sftp_client(&cid).await;
    state.connection.disconnect(&cid).await.map_err(Into::into)
}

#[tauri::command]
pub async fn connection_list(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<String>, IpcError> {
    let list = state.connection.list_connections().await;
    Ok(list.into_iter().map(|c| c.to_string()).collect())
}

#[tauri::command]
pub async fn terminal_open(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    connection_id: String,
    cols: u16,
    rows: u16,
    on_data: tauri::ipc::Channel<Vec<u8>>,
) -> Result<String, IpcError> {
    let cid = ConnectionId::from_string(&connection_id)?;
    let tid = TabId::from_string(&tab_id)?;
    let conn = state.ssh_manager.get(&cid).await?;
    let sid = conn.session_id.clone();
    let session = state.session.get_session(&sid).await?;
    let mut stream = state
        .ssh_manager
        .open_shell(&cid, TermSize::new(cols, rows))
        .await?;
    use tokio::io::AsyncWriteExt;
    if let Some(dir) = session.working_dir.filter(|dir| !dir.is_empty()) {
        let escaped = dir.replace('\'', "'\\''");
        stream
            .write_all(format!("cd -- '{escaped}'\n").as_bytes())
            .await?;
    }
    if let Some(command) = session
        .startup_command
        .filter(|command| !command.trim().is_empty())
    {
        stream.write_all(format!("{command}\n").as_bytes()).await?;
    }
    stream.flush().await?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(128);

    let tracker = state.cwd_tracker.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            tracker.ingest_terminal_output(&sid, &frame).await;
            if on_data.send(frame).is_err() {
                break;
            }
        }
    });

    state.terminal.attach_stream(tid, stream, tx)?;
    Ok(tab_id)
}

#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    data: Vec<u8>,
) -> Result<WriteResult, IpcError> {
    let tid = TabId::from_string(&tab_id)?;
    let accepted = state.terminal.write(&tid, data).await?;
    Ok(WriteResult { accepted })
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    let tid = TabId::from_string(&tab_id)?;
    state
        .terminal
        .resize(&tid, TermSize::new(cols, rows))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn terminal_ack(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    bytes: usize,
) -> Result<AckResult, IpcError> {
    let tid = TabId::from_string(&tab_id)?;
    let credit = state.terminal.ack(&tid, bytes)?;
    Ok(AckResult { credit })
}

#[tauri::command]
pub async fn terminal_close(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
) -> Result<(), IpcError> {
    let tid = TabId::from_string(&tab_id)?;
    state.terminal.close(&tid).map_err(Into::into)
}

#[tauri::command]
pub fn op_cancel(state: tauri::State<'_, Arc<AppServices>>, request_id: String) -> bool {
    state.op_registry.cancel(&request_id)
}

// ==========================================
// Local FS & SFTP
// ==========================================

#[tauri::command]
pub async fn local_fs_home() -> Result<String, IpcError> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    Ok(home)
}

#[tauri::command]
pub async fn local_fs_list(path: Option<String>) -> Result<Vec<SftpFileEntry>, IpcError> {
    let target_path = path.unwrap_or_else(|| {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string())
    });

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&target_path).await.map_err(|e| {
        openshell_core_domain::DomainError::new(
            openshell_core_domain::ErrorCode::Io,
            format!("cannot read local dir: {e}"),
        )
    })?;

    while let Ok(Some(entry)) = dir.next_entry().await {
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let file_type = if meta.is_dir() {
            FileEntryType::Directory
        } else if meta.is_symlink() {
            FileEntryType::Symlink
        } else {
            FileEntryType::Regular
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        entries.push(SftpFileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            size: meta.len(),
            file_type,
            permissions: 0o755,
            modified_at,
            accessed_at: modified_at,
            uid: None,
            gid: None,
        });
    }

    entries.sort_by(|a, b| {
        let a_is_dir = a.file_type == FileEntryType::Directory;
        let b_is_dir = b.file_type == FileEntryType::Directory;
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// SSH 主会话是否仍然存活（存在且未被判定关闭）。
async fn ssh_alive(state: &AppServices, cid: &ConnectionId) -> bool {
    match state.ssh_manager.get(cid).await {
        Ok(conn) => !*conn.closed_channel().borrow(),
        Err(_) => false,
    }
}

/// SFTP 子通道断线自动重开（复刻 FinalShell `zD.I()` Auto-Heal）。
///
/// 行为：先用缓存/新建的 `SftpClient` 执行 `op`；若返回通道级 `Io` 错误，
/// 但底层 SSH 会话仍然存活，则丢弃失效的 SFTP 子通道、重开一条新的子系统通道，
/// 并透明重试 `op` 一次。SSH 主会话也已断开时不做无谓重试，直接把原始错误抛给前端
/// （由前端的断线自动重连调度接手）。
async fn with_sftp_heal<T, F, Fut>(
    state: &AppServices,
    cid: &ConnectionId,
    op: F,
) -> Result<T, IpcError>
where
    F: Fn(Arc<openshell_sftp::SftpClient>) -> Fut,
    Fut: std::future::Future<Output = openshell_core_domain::DomainResult<T>>,
{
    let client = state.get_or_create_sftp(cid).await?;
    match op(Arc::clone(&client)).await {
        Ok(value) => Ok(value),
        // 只有通道级 IO 失败才值得重开；NotFound / Validation 等业务错误直接透出。
        Err(err) if err.code == ErrorCode::Io && ssh_alive(state, cid).await => {
            tracing::warn!(
                error = %err.message,
                "sftp channel failed, reopening subsystem channel and retrying once"
            );
            let fresh = state.reconnect_sftp(cid).await?;
            op(fresh).await.map_err(Into::into)
        }
        Err(err) => Err(err.into()),
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<Vec<SftpFileEntry>, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(
        &state,
        &cid,
        |client| async move { client.read_dir(path).await },
    )
    .await
}

#[tauri::command]
pub async fn sftp_stat(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<SftpFileEntry, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(
        &state,
        &cid,
        |client| async move { client.stat(path).await },
    )
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(
        &state,
        &cid,
        |client| async move { client.mkdir(path).await },
    )
    .await
}

#[tauri::command]
pub async fn sftp_remove_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(&state, &cid, |client| async move {
        client.remove_file(path).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_remove_dir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(&state, &cid, |client| async move {
        client.remove_dir(path).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let old_path = old_path.as_str();
    let new_path = new_path.as_str();
    with_sftp_heal(&state, &cid, |client| async move {
        client.rename(old_path, new_path).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_set_permissions(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    permissions: u32,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    with_sftp_heal(&state, &cid, |client| async move {
        client.set_permissions(path, permissions).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_read_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, IpcError> {
    if path.contains('\0') {
        return Err(
            openshell_core_domain::DomainError::validation("路径包含非法字符 (null-byte)").into(),
        );
    }
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    let max = max_bytes.unwrap_or(10 * 1024 * 1024).min(50 * 1024 * 1024);
    with_sftp_heal(&state, &cid, |client| async move {
        client.read_file_content(path, max).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_write_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), IpcError> {
    if path.contains('\0') {
        return Err(
            openshell_core_domain::DomainError::validation("路径包含非法字符 (null-byte)").into(),
        );
    }
    if data.len() > 100 * 1024 * 1024 {
        return Err(openshell_core_domain::DomainError::new(
            openshell_core_domain::ErrorCode::Validation,
            "写入单文件超出 100MB 限制，请通过传输管理器（SFTP 队列）上传大文件",
        )
        .into());
    }
    let cid = ConnectionId::from_string(&conn_id)?;
    let path = path.as_str();
    let data = data.as_slice();
    with_sftp_heal(&state, &cid, |client| async move {
        client.write_file_content(path, data).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_start_transfer(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    session_id: String,
    direction: String,
    local_path: String,
    remote_path: String,
    resume: Option<bool>,
) -> Result<String, IpcError> {
    if local_path.contains('\0') || remote_path.contains('\0') {
        return Err(openshell_core_domain::DomainError::validation(
            "传输路径包含非法字符 (null-byte)",
        )
        .into());
    }
    let cid = ConnectionId::from_string(&conn_id)?;
    let sid = SessionId::from_string(&session_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    let resume = resume.unwrap_or(false);
    let task_id = if direction == "download" {
        state
            .sftp_transfers
            .start_download(sid, remote_path, local_path, resume, client)
            .await?
    } else {
        state
            .sftp_transfers
            .start_upload(sid, local_path, remote_path, resume, client)
            .await?
    };
    Ok(task_id)
}

#[tauri::command]
pub async fn sftp_list_transfers(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<TransferTask>, IpcError> {
    let list = state.sftp_transfers.list().await;
    Ok(list)
}

#[tauri::command]
pub async fn sftp_pause_transfer(
    state: tauri::State<'_, Arc<AppServices>>,
    task_id: String,
) -> Result<(), IpcError> {
    state
        .sftp_transfers
        .pause(&task_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: tauri::State<'_, Arc<AppServices>>,
    task_id: String,
) -> Result<(), IpcError> {
    state
        .sftp_transfers
        .cancel(&task_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn sftp_resume_transfer(
    state: tauri::State<'_, Arc<AppServices>>,
    task_id: String,
) -> Result<(), IpcError> {
    state
        .sftp_transfers
        .resume(&task_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn terminal_encode(text: String, encoding: String) -> Result<Vec<u8>, IpcError> {
    crate::terminal_encoding::encode(&text, &encoding)
        .map_err(|message| openshell_core_domain::DomainError::validation(message).into())
}

#[tauri::command]
pub async fn sftp_get_cwd(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
) -> Result<Option<String>, IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    let cwd = state.cwd_tracker.get_cwd(&sid).await;
    Ok(cwd)
}

// ==========================================
// Monitor
// ==========================================

#[tauri::command]
pub async fn monitor_start(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
    conn_id: String,
    interval_sec: Option<u64>,
) -> Result<(), IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    let session = state.session.get_session(&sid).await?;
    if session
        .protocol_options_json
        .as_ref()
        .and_then(|options| options.get("exec_channel_enable"))
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        state.monitor.stop_monitoring(&sid).await;
        return Ok(());
    }
    let cid = ConnectionId::from_string(&conn_id)?;
    let conn = state.ssh_manager.get(&cid).await?;
    state
        .monitor
        .start_monitoring(sid, conn, interval_sec.unwrap_or(3))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn monitor_stop(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
) -> Result<(), IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    state.monitor.stop_monitoring(&sid).await;
    Ok(())
}

#[tauri::command]
pub async fn monitor_get_latest(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
) -> Result<Option<HostMetrics>, IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    state.monitor.get_latest(&sid).await.map_err(Into::into)
}

#[tauri::command]
pub async fn monitor_get_history(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
    duration_sec: Option<u64>,
) -> Result<Vec<HostMetrics>, IpcError> {
    let sid = SessionId::from_string(&session_id)?;
    let window = duration_sec.unwrap_or(300);
    let list = state.monitor.history().get_history(&sid, window).await;
    Ok(list)
}

#[tauri::command]
pub async fn monitor_kill_process(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    pid: u32,
    signal: Option<u32>,
) -> Result<(), IpcError> {
    if pid <= 1 {
        return Err(openshell_core_domain::DomainError::new(
            openshell_core_domain::ErrorCode::Permission,
            "安全拦截：系统保护禁止向 PID 0 或 PID 1 (init/systemd) 发送结束信号",
        )
        .into());
    }
    let cid = ConnectionId::from_string(&conn_id)?;
    let conn = state.ssh_manager.get(&cid).await?;
    state
        .monitor
        .kill_process(&conn, pid, signal.unwrap_or(15))
        .await
        .map_err(Into::into)
}

#[derive(Debug, Serialize)]
pub struct SshExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

#[tauri::command]
pub async fn ssh_exec(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    command: String,
) -> Result<SshExecResult, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let conn = state.ssh_manager.get(&cid).await?;
    let out = conn.open_exec(&command).await?;
    Ok(SshExecResult {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        exit_code: out.exit_code,
    })
}

// ==========================================
// Port Forwarding
// ==========================================

#[tauri::command]
pub async fn forward_list(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: Option<String>,
) -> Result<Vec<PortForwardRule>, IpcError> {
    let sid = session_id
        .as_deref()
        .map(SessionId::from_string)
        .transpose()?;
    let list = state.network_secrets.forwards(sid.as_ref()).await?;
    Ok(list)
}

#[tauri::command]
pub async fn forward_create(
    state: tauri::State<'_, Arc<AppServices>>,
    input: PortForwardRuleInput,
) -> Result<PortForwardRule, IpcError> {
    let input = state.network_secrets.prepare_forward(input, None).await?;
    let rule = state.port_forward_repo.create(input).await?;
    Ok(rule)
}

#[tauri::command]
pub async fn forward_update(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    input: PortForwardRuleInput,
) -> Result<PortForwardRule, IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    let input = state
        .network_secrets
        .prepare_forward(input, Some(&pf_id))
        .await?;
    let rule = state.port_forward_repo.update(&pf_id, input).await?;
    Ok(rule)
}

#[tauri::command]
pub async fn forward_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    state.forward.stop_rule(&pf_id).await?;
    state.port_forward_repo.delete(&pf_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn forward_start(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    conn_id: String,
) -> Result<(), IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    let cid = ConnectionId::from_string(&conn_id)?;
    state.network_secrets.forwards(None).await?;
    let rule = state.port_forward_repo.get(&pf_id).await?;
    let socks_password = rule
        .socks_password_ref
        .as_deref()
        .map(|reference| state.network_secrets.resolve(reference, "socks_password"))
        .transpose()?
        .map(|password| password.to_string());
    let conn = state.ssh_manager.get(&cid).await?;
    state
        .forward
        .start_rule(rule, conn, socks_password)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn forward_stop(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    state.forward.stop_rule(&pf_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn forward_list_statuses(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<std::collections::HashMap<String, ForwardStatus>, IpcError> {
    let map = state.forward.list_statuses().await;
    let res = map.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    Ok(res)
}

// ==========================================
// Snippets & Quick Commands
// ==========================================

#[tauri::command]
pub async fn snippet_list(
    state: tauri::State<'_, Arc<AppServices>>,
    group_id: Option<String>,
) -> Result<Vec<Snippet>, IpcError> {
    let gid = group_id.as_deref().map(GroupId::from_string).transpose()?;
    let list = state.snippet_repo.list(gid.as_ref()).await?;
    Ok(list)
}

#[tauri::command]
pub async fn snippet_create(
    state: tauri::State<'_, Arc<AppServices>>,
    input: SnippetInput,
) -> Result<Snippet, IpcError> {
    let snip = state.snippet_repo.create(input).await?;
    Ok(snip)
}

#[tauri::command]
pub async fn snippet_update(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
    input: SnippetInput,
) -> Result<Snippet, IpcError> {
    let sid = SnippetId::from_string(&id)?;
    let snip = state.snippet_repo.update(&sid, input).await?;
    Ok(snip)
}

#[tauri::command]
pub async fn snippet_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let sid = SnippetId::from_string(&id)?;
    state.snippet_repo.delete(&sid).await?;
    Ok(())
}

// ==========================================
// Importer / Exporter
// ==========================================

fn parse_conflict_strategy(strategy: Option<&str>) -> ConflictStrategy {
    match strategy {
        Some("overwrite") => ConflictStrategy::Overwrite,
        Some("keep_both") => ConflictStrategy::KeepBoth,
        _ => ConflictStrategy::Skip,
    }
}

#[tauri::command]
pub async fn importer_preview_openssh(
    state: tauri::State<'_, Arc<AppServices>>,
    content: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    let strat = parse_conflict_strategy(strategy.as_deref());
    let (blocks, warnings) = OpenSshParser::parse_config(&content);
    let inputs = OpenSshParser::to_session_inputs(&blocks);
    let existing = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let report = ImportPreviewEngine::generate_preview(inputs, &existing, strat, warnings);
    Ok(report)
}

#[tauri::command]
pub async fn importer_preview_finalshell(
    state: tauri::State<'_, Arc<AppServices>>,
    content: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    let strat = parse_conflict_strategy(strategy.as_deref());
    let inputs = FinalShellParser::parse_json(&content)
        .map_err(openshell_core_domain::DomainError::validation)?;
    let existing = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let report = ImportPreviewEngine::generate_preview(inputs, &existing, strat, Vec::new());
    Ok(report)
}

/// 把 FinalShell 内嵌的 `port_forwarding_list`（`YE.class` 结构）转成独立端口转发规则落库。
///
/// 已存在「同名 + 同绑定端口 + 同类型」规则时更新，避免重复并保留覆盖导入的变更。
/// 写入失败返回错误，避免把丢失隧道配置的导入报告为成功。
async fn import_embedded_forwards(
    state: &AppServices,
    session: &Session,
    protocol_options_json: Option<&serde_json::Value>,
    auto_reconnect: Option<bool>,
) -> Result<(), IpcError> {
    let rules = FinalShellParser::extract_embedded_forwards(
        &session.id,
        protocol_options_json,
        auto_reconnect.or(Some(session.auto_reconnect)),
    );
    if rules.is_empty() {
        return Ok(());
    }
    let mut existing = state.port_forward_repo.list(Some(&session.id)).await?;
    for mut rule in rules {
        rule.reconnect_max = rule.reconnect_max.or(Some(session.reconnect_max));
        let rule_type = rule.rule_type.unwrap_or(PortForwardType::Local);
        let duplicated = existing.iter().find(|e| {
            e.name == rule.name && e.bind_port == rule.bind_port && e.rule_type == rule_type
        });
        let result = if let Some(duplicated) = duplicated {
            rule.auto_start = Some(duplicated.auto_start);
            rule.socks_auth = Some(duplicated.socks_auth);
            rule.socks_username = duplicated.socks_username.clone();
            rule.socks_password_ref = duplicated.socks_password_ref.clone();
            rule.expose_warning_ack = Some(duplicated.expose_warning_ack);
            state.port_forward_repo.update(&duplicated.id, rule).await?
        } else {
            state.port_forward_repo.create(rule).await?
        };
        existing.retain(|rule| rule.id != result.id);
        existing.push(result);
    }
    Ok(())
}

fn import_session_patch(input: SessionInput) -> SessionPatch {
    SessionPatch {
        // 未指定分组时保留已有自定义分组；未分组连接仍由首页按协议归类。
        group_id: input.group_id.map(Some),
        name: input.name,
        protocol: input.protocol,
        host: Some(input.host),
        port: Some(
            input
                .port
                .or_else(|| input.protocol.unwrap_or(Protocol::Ssh).default_port()),
        ),
        username: Some(input.username),
        auth_method: input.auth_method,
        credential_id: Some(input.credential_id),
        ssh_key_id: Some(input.ssh_key_id),
        host_key_policy: input.host_key_policy,
        proxy_id: input.proxy_id,
        proxy_jump_json: Some(input.proxy_jump_json),
        terminal_profile_id: Some(input.terminal_profile_id),
        startup_command: Some(input.startup_command),
        working_dir: Some(input.working_dir),
        encoding: input.encoding,
        keepalive_sec: input.keepalive_sec,
        keepalive_max_miss: input.keepalive_max_miss,
        auto_reconnect: input.auto_reconnect,
        reconnect_max: input.reconnect_max,
        compression: input.compression,
        agent_forwarding: input.agent_forwarding,
        x11_forwarding: input.x11_forwarding,
        tags_json: Some(input.tags_json),
        favorite: input.favorite,
        color: Some(input.color),
        icon_key: Some(input.icon_key),
        notes: Some(input.notes),
        protocol_options_json: Some(input.protocol_options_json),
        sort_order: input.sort_order,
    }
}

#[tauri::command]
pub async fn importer_commit(
    state: tauri::State<'_, Arc<AppServices>>,
    candidates: Vec<ImportCandidate>,
    archive_token: Option<String>,
) -> Result<usize, IpcError> {
    if let Some(token) = archive_token {
        return state
            .archive
            .commit(&candidates, &token)
            .map_err(Into::into);
    }
    let mut count = 0;
    for cand in candidates {
        if cand.action != CandidateAction::Skip
            && cand
                .input
                .protocol_options_json
                .as_ref()
                .and_then(|v| v.get("import_blocked"))
                .is_some()
        {
            return Err(openshell_core_domain::DomainError::validation("导入依赖尚未补齐").into());
        }
        match cand.action {
            CandidateAction::Create => {
                // 会话被创建后 `input` 即被消费，转发列表需要提前取出。
                let forwards_src = cand.input.protocol_options_json.clone();
                let auto_reconnect = cand.input.auto_reconnect;
                let created = state.session.create_session(cand.input).await?;
                import_embedded_forwards(&state, &created, forwards_src.as_ref(), auto_reconnect)
                    .await?;
                count += 1;
            }
            CandidateAction::Update => {
                if let Some(id_str) = cand.existing_session_id {
                    let sid = SessionId::from_string(&id_str)?;
                    let forwards_src = cand.input.protocol_options_json.clone();
                    let auto_reconnect = cand.input.auto_reconnect;
                    let patch = import_session_patch(cand.input);
                    let updated = state.session.update_session(&sid, patch, None).await?;
                    import_embedded_forwards(
                        &state,
                        &updated,
                        forwards_src.as_ref(),
                        auto_reconnect,
                    )
                    .await?;
                    count += 1;
                }
            }
            CandidateAction::Skip => {}
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn importer_discard_preview(
    state: tauri::State<'_, Arc<AppServices>>,
    archive_token: String,
) -> Result<(), IpcError> {
    state.archive.discard(&archive_token);
    Ok(())
}

#[tauri::command]
pub async fn importer_export_bundle_json(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<String, IpcError> {
    Ok(state.archive.export_json().await?)
}

#[tauri::command]
pub async fn importer_export_bundle_encrypted(
    state: tauri::State<'_, Arc<AppServices>>,
    password: String,
) -> Result<Vec<u8>, IpcError> {
    let password = zeroize::Zeroizing::new(password);
    Ok(state.archive.export_encrypted(&password).await?)
}

#[tauri::command]
pub async fn importer_preview_bundle_json(
    state: tauri::State<'_, Arc<AppServices>>,
    json_str: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    Ok(state
        .archive
        .preview_json(&json_str, parse_conflict_strategy(strategy.as_deref()))
        .await?)
}

#[tauri::command]
pub async fn importer_preview_bundle_encrypted(
    state: tauri::State<'_, Arc<AppServices>>,
    pkg_bytes: Vec<u8>,
    password: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    let password = zeroize::Zeroizing::new(password);
    Ok(state
        .archive
        .preview_encrypted(
            &pkg_bytes,
            &password,
            parse_conflict_strategy(strategy.as_deref()),
        )
        .await?)
}

// ==========================================
// Settings
// ==========================================

#[tauri::command]
pub async fn settings_get(
    state: tauri::State<'_, Arc<AppServices>>,
    scope: String,
    scope_id: Option<String>,
    key: String,
) -> Result<Option<SettingRecord>, IpcError> {
    if scope == "global" && scope_id.is_none() && key == "proxy_list" {
        state.network_secrets.proxies()?;
    }
    let record = state.settings_repo.get(&scope, scope_id.as_deref(), &key)?;
    Ok(record)
}

#[tauri::command]
pub async fn settings_set(
    state: tauri::State<'_, Arc<AppServices>>,
    scope: String,
    scope_id: Option<String>,
    key: String,
    value: serde_json::Value,
    syncable: Option<bool>,
) -> Result<SettingRecord, IpcError> {
    if key == "proxy_list" {
        if scope != "global" || scope_id.is_some() {
            return Err(DomainError::validation("Invalid proxy settings scope").into());
        }
        let inputs = serde_json::from_value(value)
            .map_err(|_| DomainError::validation("Invalid proxy settings"))?;
        state.network_secrets.save_proxies(inputs)?;
        return state
            .settings_repo
            .get("global", None, "proxy_list")?
            .ok_or_else(|| DomainError::internal("Proxy settings were not saved").into());
    }
    let record = state.settings_repo.set(
        &scope,
        scope_id.as_deref(),
        &key,
        value,
        syncable.unwrap_or(false),
    )?;
    Ok(record)
}

#[tauri::command]
pub async fn settings_list(
    state: tauri::State<'_, Arc<AppServices>>,
    scope: String,
) -> Result<Vec<SettingRecord>, IpcError> {
    if scope == "global" {
        state.network_secrets.proxies()?;
    }
    let list = state.settings_repo.list(&scope)?;
    Ok(list)
}

// ==========================================
// Sync & E2EE Cloud
// ==========================================

#[tauri::command]
pub async fn sync_list_conflicts(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_app_core::sync_service::SyncConflict>, IpcError> {
    Ok(state.sync.list_conflicts()?)
}

#[tauri::command]
pub async fn sync_resolve_conflict(
    state: tauri::State<'_, Arc<AppServices>>,
    conflict_id: String,
    choice: openshell_app_core::sync_service::SyncConflictChoice,
) -> Result<(), IpcError> {
    state.sync.resolve_conflict(&conflict_id, choice).await?;
    Ok(())
}

#[tauri::command]
pub async fn sync_get_config(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<openshell_app_core::SyncConfig, IpcError> {
    let cfg = state.sync.get_config()?;
    Ok(cfg)
}

#[tauri::command]
pub async fn sync_save_config(
    state: tauri::State<'_, Arc<AppServices>>,
    server_url: Option<String>,
    auto_sync: bool,
) -> Result<(), IpcError> {
    state.sync.save_config(server_url, auto_sync)?;
    Ok(())
}

#[tauri::command]
pub async fn sync_register(
    state: tauri::State<'_, Arc<AppServices>>,
    server_url: String,
    email: String,
    password: String,
    invite_code: Option<String>,
) -> Result<openshell_app_core::SyncConfig, IpcError> {
    let password = zeroize::Zeroizing::new(password);
    state
        .sync
        .register(&server_url, &email, &password, invite_code)
        .await?;
    Ok(state.sync.get_config()?)
}

#[tauri::command]
pub async fn sync_login(
    state: tauri::State<'_, Arc<AppServices>>,
    server_url: String,
    email: String,
    password: String,
) -> Result<openshell_app_core::SyncConfig, IpcError> {
    let password = zeroize::Zeroizing::new(password);
    state.sync.login(&server_url, &email, &password).await?;
    Ok(state.sync.get_config()?)
}

#[tauri::command]
pub async fn sync_logout(state: tauri::State<'_, Arc<AppServices>>) -> Result<(), IpcError> {
    state.sync.logout()?;
    Ok(())
}

#[tauri::command]
pub async fn sync_now(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<openshell_app_core::SyncResult, IpcError> {
    let res = state.sync.sync_now().await?;
    Ok(res)
}

#[tauri::command]
pub async fn sync_check_updates(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Option<openshell_sync_protocol::UpdateManifest>, IpcError> {
    let update = state.sync.check_updates().await?;
    Ok(update)
}

// ==========================================
// Extension / Plugin Mechanism (Architecture §21)
// ==========================================

#[tauri::command]
pub async fn plugin_list_tools(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_core_domain::ToolMetadata>, IpcError> {
    Ok(state.extensions.list_tools())
}

#[tauri::command]
pub async fn plugin_list_panels(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_core_domain::SidePanelMetadata>, IpcError> {
    Ok(state.extensions.list_panels())
}

#[tauri::command]
pub async fn plugin_list_quick_actions(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_core_domain::QuickActionMetadata>, IpcError> {
    Ok(state.extensions.list_quick_actions())
}

#[tauri::command]
pub async fn plugin_execute_quick_action(
    state: tauri::State<'_, Arc<AppServices>>,
    action_id: String,
    ctx: openshell_core_domain::ActionContext,
) -> Result<(), IpcError> {
    state.extensions.execute_quick_action(&action_id, &ctx)?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_toggle_feature(
    state: tauri::State<'_, Arc<AppServices>>,
    kind: String,
    id: String,
    enabled: bool,
) -> Result<bool, IpcError> {
    let res = match kind.as_str() {
        "tool" => state.extensions.set_tool_enabled(&id, enabled),
        "panel" => state.extensions.set_panel_enabled(&id, enabled),
        "action" => state.extensions.set_action_enabled(&id, enabled),
        "protocol" => state.extensions.set_protocol_enabled(&id, enabled),
        _ => {
            return Err(openshell_core_domain::DomainError::validation(format!(
                "Unknown extension kind: {}",
                kind
            ))
            .into())
        }
    };
    Ok(res)
}

#[tauri::command]
pub async fn plugin_check_port(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<openshell_extension_sample::PortCheckResult, IpcError> {
    let timeout_ms = timeout_ms.unwrap_or(2000);
    let res = openshell_extension_sample::probe_tcp_port(&host, port, timeout_ms).await;
    Ok(res)
}

// ==========================================
// Session Cards (视图卡)
// ==========================================

#[tauri::command]
pub async fn card_create(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
) -> Result<openshell_core_domain::SessionCard, IpcError> {
    let sess_id = SessionId::from_string(session_id)?;
    let card = state.card.create_card(&sess_id).await?;
    Ok(card)
}

#[tauri::command]
pub async fn card_list(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_core_domain::SessionCard>, IpcError> {
    Ok(state.card.list_cards())
}

#[tauri::command]
pub async fn card_get(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
) -> Result<openshell_core_domain::SessionCard, IpcError> {
    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    let card = state.card.get_card(&cid)?;
    Ok(card)
}

#[tauri::command]
pub async fn card_set_mode(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    mode: String,
) -> Result<openshell_core_domain::SessionCard, IpcError> {
    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    let m = match mode.to_lowercase().as_str() {
        "view" => openshell_core_domain::CardMode::View,
        _ => openshell_core_domain::CardMode::Command,
    };
    let card = state.card.set_mode(&cid, m)?;
    Ok(card)
}

#[tauri::command]
pub async fn card_mark_connected(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    connection_id: Option<String>,
) -> Result<openshell_core_domain::SessionCard, IpcError> {
    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    let conn_id = connection_id.map(ConnectionId::from_string).transpose()?;
    let card = state.card.mark_connected(&cid, conn_id)?;
    Ok(card)
}

#[tauri::command]
pub async fn card_mark_disconnected(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    reason: Option<String>,
) -> Result<openshell_core_domain::SessionCard, IpcError> {
    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    let card = state.card.mark_disconnected(&cid, reason)?;
    Ok(card)
}

#[tauri::command]
pub async fn card_close(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
) -> Result<(), IpcError> {
    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    if let Some(conn_id) = state.card.close_card(&cid)? {
        let _ = state.connection.disconnect(&conn_id).await;
    }
    let _ = state.serial.close(cid.as_str()).await;
    Ok(())
}

// ==========================================
// Serial Subsystem (串口通信)
// ==========================================

#[tauri::command]
pub async fn serial_list_ports() -> Result<Vec<openshell_serial::SerialPortInfo>, IpcError> {
    let ports = openshell_serial::list_serial_ports().map_err(|e| {
        openshell_core_domain::DomainError::new(openshell_core_domain::ErrorCode::Io, e.to_string())
    })?;
    Ok(ports)
}

#[tauri::command]
pub async fn serial_open(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    config: openshell_serial::SerialProfileConfig,
    use_mock: Option<bool>,
) -> Result<(), IpcError> {
    if use_mock.unwrap_or(false) {
        return Err(
            openshell_core_domain::DomainError::validation("生产串口入口不允许使用 Mock").into(),
        );
    }
    let mock = false;
    state
        .serial
        .open(&card_id, &config, mock)
        .await
        .map_err(|e| {
            openshell_core_domain::DomainError::new(
                openshell_core_domain::ErrorCode::Io,
                e.to_string(),
            )
        })?;

    let cid = openshell_core_domain::CardId::from_string(card_id)?;
    let _ = state.card.mark_connected(&cid, None);
    Ok(())
}

#[tauri::command]
pub async fn serial_send(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    data: Vec<u8>,
) -> Result<usize, IpcError> {
    let written = state.serial.write(&card_id, &data).await.map_err(|e| {
        openshell_core_domain::DomainError::new(openshell_core_domain::ErrorCode::Io, e.to_string())
    })?;
    Ok(written)
}

#[tauri::command]
pub async fn serial_read(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, IpcError> {
    let cap = max_bytes.unwrap_or(16384).min(65536);
    let mut buf = vec![0u8; cap];
    let n = state.serial.read(&card_id, &mut buf).await.map_err(|e| {
        openshell_core_domain::DomainError::new(openshell_core_domain::ErrorCode::Io, e.to_string())
    })?;
    buf.truncate(n);
    Ok(buf)
}

#[tauri::command]
pub async fn serial_set_lines(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    dtr: Option<bool>,
    rts: Option<bool>,
) -> Result<(), IpcError> {
    state
        .serial
        .set_lines(&card_id, dtr, rts)
        .await
        .map_err(|e| {
            openshell_core_domain::DomainError::new(
                openshell_core_domain::ErrorCode::Io,
                e.to_string(),
            )
        })?;
    Ok(())
}

#[tauri::command]
pub async fn serial_get_modem_status(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
) -> Result<openshell_serial::ModemStatus, IpcError> {
    let status = state.serial.get_modem_status(&card_id).await.map_err(|e| {
        openshell_core_domain::DomainError::new(openshell_core_domain::ErrorCode::Io, e.to_string())
    })?;
    Ok(status)
}

#[tauri::command]
pub async fn serial_set_baud_rate(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
    baud_rate: u32,
) -> Result<(), IpcError> {
    state
        .serial
        .set_baud_rate(&card_id, baud_rate)
        .await
        .map_err(|e| {
            openshell_core_domain::DomainError::new(
                openshell_core_domain::ErrorCode::Io,
                e.to_string(),
            )
        })?;
    Ok(())
}

#[tauri::command]
pub async fn serial_get_stats(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
) -> Result<Option<openshell_serial::SerialStats>, IpcError> {
    Ok(state.serial.get_stats(&card_id).await)
}

#[tauri::command]
pub async fn serial_close(
    state: tauri::State<'_, Arc<AppServices>>,
    card_id: String,
) -> Result<(), IpcError> {
    state.serial.close(&card_id).await.map_err(|e| {
        openshell_core_domain::DomainError::new(openshell_core_domain::ErrorCode::Io, e.to_string())
    })?;
    Ok(())
}

// ==========================================
// AI 终端助手：模型配置与凭据
// ==========================================

#[tauri::command]
pub async fn ai_config_get(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<AiConfigView, IpcError> {
    Ok(state.ai.config_get()?)
}

#[tauri::command]
pub async fn ai_catalog_get(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<AiCatalogView, IpcError> {
    Ok(state.ai.catalog_get()?)
}

#[tauri::command]
pub async fn ai_config_save(
    state: tauri::State<'_, Arc<AppServices>>,
    profile: AiProfileInput,
) -> Result<AiProfile, IpcError> {
    Ok(state.ai.config_save(profile)?)
}

#[tauri::command]
pub async fn ai_delete_profile(
    state: tauri::State<'_, Arc<AppServices>>,
    profile_id: String,
) -> Result<(), IpcError> {
    state.ai.delete_profile(&profile_id)?;
    Ok(())
}

#[tauri::command]
pub async fn ai_set_active_profile(
    state: tauri::State<'_, Arc<AppServices>>,
    profile_id: String,
) -> Result<(), IpcError> {
    state.ai.set_active_profile(&profile_id)?;
    Ok(())
}

#[tauri::command]
pub async fn ai_profile_test(
    state: tauri::State<'_, Arc<AppServices>>,
    profile_id: String,
) -> Result<ProviderTestResult, IpcError> {
    Ok(state.ai.profile_test(&profile_id).await?)
}

#[tauri::command]
pub async fn ai_logo_get(
    state: tauri::State<'_, Arc<AppServices>>,
    logo_key: String,
) -> Result<String, IpcError> {
    Ok(state.ai.logo_svg(&logo_key))
}

#[tauri::command]
pub async fn ai_history_list(
    state: tauri::State<'_, Arc<AppServices>>,
    limit: Option<u32>,
) -> Result<Vec<String>, IpcError> {
    Ok(state.ai.history_list(limit)?)
}

#[tauri::command]
pub async fn ai_set_enabled(
    state: tauri::State<'_, Arc<AppServices>>,
    enabled: bool,
) -> Result<(), IpcError> {
    state.ai.set_enabled(enabled)?;
    Ok(())
}

// ==========================================
// Proxy servers and non-SSH terminal runtimes
// ==========================================

fn load_proxies(
    state: &AppServices,
) -> Result<Vec<openshell_core_domain::ProxyServerConfig>, IpcError> {
    state.network_secrets.proxies().map_err(Into::into)
}

#[tauri::command]
pub async fn proxy_list_get(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<Vec<openshell_core_domain::ProxyServerConfig>, IpcError> {
    load_proxies(&state)
}

#[tauri::command]
pub async fn proxy_list_save(
    state: tauri::State<'_, Arc<AppServices>>,
    proxies: Vec<openshell_core_domain::ProxyServerInput>,
) -> Result<Vec<openshell_core_domain::ProxyServerConfig>, IpcError> {
    state
        .network_secrets
        .save_proxies(proxies)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn proxy_test(
    state: tauri::State<'_, Arc<AppServices>>,
    proxy: openshell_core_domain::ProxyServerInput,
) -> Result<openshell_core_domain::ProxyTestResult, IpcError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let proxy = state.network_secrets.test_proxy(proxy)?;
    let start = std::time::Instant::now();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut socket = tokio::net::TcpStream::connect((proxy.host.as_str(), proxy.port)).await?;
        if proxy.proxy_type == openshell_core_domain::ProxyType::Socks5 {
            let authenticated = proxy.username.as_deref().is_some_and(|u| !u.is_empty());
            socket
                .write_all(if authenticated {
                    &[5, 1, 2]
                } else {
                    &[5, 1, 0]
                })
                .await?;
            let mut reply = [0; 2];
            socket.read_exact(&mut reply).await?;
            let method = if authenticated { 2 } else { 0 };
            if reply != [5, method] {
                return Err(std::io::Error::other("SOCKS5 authentication rejected"));
            }
            if authenticated {
                let username = proxy.username.as_deref().unwrap_or("").as_bytes();
                let password = proxy.password.as_deref().unwrap_or("").as_bytes();
                if username.len() > 255 || password.is_empty() || password.len() > 255 {
                    return Err(std::io::Error::other("SOCKS5 credentials invalid"));
                }
                let mut auth = vec![1, username.len() as u8];
                auth.extend_from_slice(username);
                auth.push(password.len() as u8);
                auth.extend_from_slice(password);
                socket.write_all(&auth).await?;
                socket.read_exact(&mut reply).await?;
                if reply != [1, 0] {
                    return Err(std::io::Error::other("SOCKS5 authentication rejected"));
                }
            }
        }
        Ok::<_, std::io::Error>(())
    })
    .await;
    let ok = matches!(result, Ok(Ok(())));
    Ok(openshell_core_domain::ProxyTestResult {
        ok,
        latency_ms: ok.then(|| start.elapsed().as_millis() as u64),
        message: if ok {
            "代理握手完成"
        } else if result.is_err() {
            "连接超时"
        } else {
            "代理连接失败"
        }
        .into(),
    })
}

#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalShellOpenOptions {
    session_id: Option<String>,
    shell_kind: Option<String>,
    shell_path: Option<String>,
    working_dir: Option<String>,
    startup_command: Option<String>,
}

fn attach_runtime(
    state: &AppServices,
    tab_id: &str,
    stream: Box<dyn openshell_core_domain::ByteStream>,
    on_data: tauri::ipc::Channel<Vec<u8>>,
) -> Result<(), IpcError> {
    let tid = TabId::from_string(tab_id)?;
    let (tx, mut rx) = tokio::sync::mpsc::channel(128);
    state.terminal.attach_stream(tid, stream, tx)?;
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if on_data.send(frame).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn local_shell_open(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    cols: u16,
    rows: u16,
    on_data: tauri::ipc::Channel<Vec<u8>>,
    options: Option<LocalShellOpenOptions>,
) -> Result<String, IpcError> {
    let options = options.unwrap_or_default();
    let session = if let Some(sid) = options.session_id {
        let session = state
            .session
            .get_session(&SessionId::from_string(sid)?)
            .await?;
        if session.protocol != Protocol::LocalShell {
            return Err(
                openshell_core_domain::DomainError::validation("此连接不是本地终端").into(),
            );
        }
        Some(session)
    } else {
        None
    };
    let mut config = serde_json::from_value::<crate::protocol_runtime::ShellConfig>(
        session
            .as_ref()
            .and_then(|s| s.protocol_options_json.clone())
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|_| openshell_core_domain::DomainError::validation("本地终端配置无效"))?;
    if options.shell_kind.is_some() {
        config.shell_kind = options.shell_kind;
    }
    if options.shell_path.is_some() {
        config.shell_path = options.shell_path;
    }
    let working = options
        .working_dir
        .or_else(|| session.as_ref().and_then(|s| s.working_dir.clone()));
    let startup = options
        .startup_command
        .or_else(|| session.as_ref().and_then(|s| s.startup_command.clone()));
    let mut stream = crate::protocol_runtime::open_shell(config, working, startup).await?;
    stream.resize(TermSize::new(cols, rows))?;
    attach_runtime(&state, &tab_id, stream, on_data)?;
    if let Some(session) = session {
        state.session.touch_used(&session.id, "ok").await?;
    }
    Ok(tab_id)
}

async fn saved_password(
    state: &AppServices,
    session: &Session,
) -> Option<zeroize::Zeroizing<String>> {
    use openshell_core_domain::{PromptPolicy, SecretMaterial, SecretResolver};
    if let Some(id) = &session.credential_id {
        if let Ok(SecretMaterial::Password(password)) = state
            .vault
            .resolve_credential(id, PromptPolicy::StoredOnly)
            .await
        {
            return Some(password);
        }
    }
    None
}

#[tauri::command]
pub async fn telnet_open(
    state: tauri::State<'_, Arc<AppServices>>,
    tab_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
    on_data: tauri::ipc::Channel<Vec<u8>>,
    overrides: Option<ConnectOverrides>,
) -> Result<String, IpcError> {
    let sid = SessionId::from_string(session_id)?;
    let session = state.session.get_session(&sid).await?;
    if session.protocol != Protocol::Telnet {
        return Err(openshell_core_domain::DomainError::validation("此连接不是 Telnet").into());
    }
    let overrides = overrides.unwrap_or_default();
    let host = overrides
        .host
        .or_else(|| session.host.clone())
        .filter(|h| !h.trim().is_empty())
        .ok_or_else(|| openshell_core_domain::DomainError::validation("主机不能为空"))?;
    let port = overrides.port.or(session.port).unwrap_or(23);
    if port == 0 {
        return Err(openshell_core_domain::DomainError::validation("端口无效").into());
    }
    let proxies = load_proxies(&state)?
        .into_iter()
        .map(|p| state.network_secrets.runtime_proxy(p))
        .collect::<Result<Vec<_>, _>>()?;
    let proxy = if let Some(id) = &session.proxy_id {
        Some(
            proxies
                .iter()
                .find(|p| &p.id == id)
                .ok_or_else(|| openshell_core_domain::DomainError::not_found("代理服务器不存在"))?,
        )
    } else {
        None
    };
    let socket = openshell_ssh::connect_tcp_via_proxy(
        &host,
        port,
        proxy,
        std::time::Duration::from_secs(15),
    )
    .await?;
    let config = serde_json::from_value::<crate::protocol_runtime::TelnetConfig>(
        session
            .protocol_options_json
            .clone()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|_| openshell_core_domain::DomainError::validation("Telnet 配置无效"))?;
    let username = overrides.username.or_else(|| session.username.clone());
    let password = match overrides.password {
        Some(password) => Some(zeroize::Zeroizing::new(password)),
        None => saved_password(&state, &session).await,
    };
    let mut stream = crate::protocol_runtime::open_telnet(socket, config, username, password);
    stream.resize(TermSize::new(cols, rows))?;
    attach_runtime(&state, &tab_id, stream, on_data)?;
    state.session.touch_used(&sid, "ok").await?;
    Ok(tab_id)
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
pub struct RdpLaunchOverrides {
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    fullscreen: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    drivestoredirect: Option<bool>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct RdpOptions {
    fullscreen: bool,
    custom_size: bool,
    width: Option<u32>,
    height: Option<u32>,
    drivestoredirect: bool,
    redirect_clipboard: Option<bool>,
    redirect_printers: bool,
    redirect_audio: Option<String>,
    domain: Option<String>,
    admin_session: bool,
}
#[derive(Serialize)]
pub struct RdpLaunchResult {
    launch_id: String,
    session_id: String,
    rdp_file_path: String,
    pid: Option<u32>,
    host: String,
    port: u16,
}

#[derive(Serialize)]
pub struct RdpRuntimeStatus {
    launch_id: String,
    session_id: String,
    state: &'static str,
    error: Option<String>,
    exit_code: Option<i32>,
}

fn rdp_config(
    host: &str,
    port: u16,
    username: &str,
    options: &RdpOptions,
) -> Result<String, openshell_core_domain::DomainError> {
    if host.trim().is_empty()
        || host.contains(['\r', '\n', '\0'])
        || username.contains(['\r', '\n', '\0'])
        || options
            .domain
            .as_deref()
            .is_some_and(|d| d.contains(['\r', '\n', '\0']))
        || port == 0
    {
        return Err(openshell_core_domain::DomainError::validation(
            "远程桌面地址或用户名无效",
        ));
    }
    let width = if options.custom_size {
        options.width.unwrap_or(1920)
    } else {
        1920
    };
    let height = if options.custom_size {
        options.height.unwrap_or(1080)
    } else {
        1080
    };
    if options.custom_size && (!(200..=8192).contains(&width) || !(200..=8192).contains(&height)) {
        return Err(openshell_core_domain::DomainError::validation(
            "远程桌面分辨率无效",
        ));
    }
    let address = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let audio = match options.redirect_audio.as_deref().unwrap_or("local") {
        "local" => 0,
        "remote" => 1,
        "none" => 2,
        _ => {
            return Err(openshell_core_domain::DomainError::validation(
                "音频重定向配置无效",
            ))
        }
    };
    let mut output=format!("full address:s:{address}\r\nusername:s:{username}\r\nscreen mode id:i:{}\r\nsmart sizing:i:1\r\nredirectclipboard:i:{}\r\nredirectprinters:i:{}\r\ndrivestoredirect:s:{}\r\naudiomode:i:{audio}\r\nadministrative session:i:{}\r\n", if options.fullscreen {2}else{1},u8::from(options.redirect_clipboard.unwrap_or(true)),u8::from(options.redirect_printers),if options.drivestoredirect {"*"}else{""},u8::from(options.admin_session));
    output.push_str(&format!(
        "desktopwidth:i:{width}\r\ndesktopheight:i:{height}\r\n"
    ));
    if let Some(domain) = &options.domain {
        output.push_str(&format!("domain:s:{domain}\r\n"));
    }
    Ok(output)
}

#[tauri::command]
pub async fn rdp_launch(
    state: tauri::State<'_, Arc<AppServices>>,
    session_id: String,
    overrides: Option<RdpLaunchOverrides>,
) -> Result<RdpLaunchResult, IpcError> {
    if !cfg!(windows) {
        return Err(openshell_core_domain::DomainError::new(
            openshell_core_domain::ErrorCode::Unsupported,
            "远程桌面启动仅支持 Windows",
        )
        .into());
    }
    let sid = SessionId::from_string(&session_id)?;
    let session = state.session.get_session(&sid).await?;
    if session.protocol != Protocol::Rdp {
        return Err(
            openshell_core_domain::DomainError::validation("此连接不是 Windows 远程桌面").into(),
        );
    }
    if session.proxy_id.as_deref().is_some_and(|id| !id.is_empty())
        || session.proxy_jump_json.is_some()
    {
        return Err(openshell_core_domain::DomainError::new(
            openshell_core_domain::ErrorCode::Unsupported,
            "Windows 远程桌面不支持此 HTTP/SOCKS 代理或 SSH 跳板配置",
        )
        .into());
    }
    let overrides = overrides.unwrap_or_default();
    let mut options = serde_json::from_value::<RdpOptions>(
        session
            .protocol_options_json
            .clone()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|_| openshell_core_domain::DomainError::validation("远程桌面配置无效"))?;
    if let Some(value) = overrides.fullscreen {
        options.fullscreen = value;
    }
    if let Some(value) = overrides.drivestoredirect {
        options.drivestoredirect = value;
    }
    if let Some(value) = overrides.width {
        options.width = Some(value);
        options.custom_size = true;
    }
    if let Some(value) = overrides.height {
        options.height = Some(value);
        options.custom_size = true;
    }
    let host = overrides
        .host
        .or_else(|| session.host.clone())
        .unwrap_or_default();
    let port = overrides.port.or(session.port).unwrap_or(3389);
    let username = overrides
        .username
        .or_else(|| session.username.clone())
        .unwrap_or_default();
    let contents = rdp_config(&host, port, &username, &options)?;
    let password = match overrides.password.filter(|password| !password.is_empty()) {
        Some(password) => Some(zeroize::Zeroizing::new(password)),
        None => {
            if let Some(id) = &session.credential_id {
                use openshell_core_domain::{PromptPolicy, SecretMaterial, SecretResolver};
                match state
                    .vault
                    .resolve_credential(id, PromptPolicy::Interactive)
                    .await?
                {
                    SecretMaterial::Password(password) => Some(password),
                    _ => {
                        return Err(openshell_core_domain::DomainError::validation(
                            "远程桌面需要密码凭据",
                        )
                        .into())
                    }
                }
            } else {
                None
            }
        }
    };
    if !session_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(openshell_core_domain::DomainError::validation("会话 ID 无效").into());
    }
    let launch_id = openshell_core_domain::new_id();
    let file = std::env::temp_dir()
        .join("openshell_rdp")
        .join(format!("{launch_id}.rdp"));
    tokio::fs::create_dir_all(
        file.parent()
            .ok_or_else(|| openshell_core_domain::DomainError::internal("远程桌面路径无效"))?,
    )
    .await?;
    let data: Vec<u8> = std::iter::once(0xfeffu16)
        .chain(contents.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    tokio::fs::write(&file, data).await?;
    #[cfg(windows)]
    let (pid, child, events, reader) = {
        let config = serde_json::json!({"host":host,"port":port,"username":username,"domain":options.domain,"width":if options.custom_size {options.width.unwrap_or(1920)}else{1920},"height":if options.custom_size {options.height.unwrap_or(1080)}else{1080},"fullscreen":options.fullscreen,"redirect_clipboard":options.redirect_clipboard,"redirect_printers":options.redirect_printers,"drivestoredirect":options.drivestoredirect,"redirect_audio":options.redirect_audio,"admin_session":options.admin_session});
        let launch_file = file.clone();
        let (child, events, reader) = match tokio::task::spawn_blocking(move || {
            crate::rdp_host::start(
                &config,
                password.as_deref().map(|password| password.as_str()),
                &launch_file,
            )
        })
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                crate::rdp_process::cleanup(&file)?;
                return Err(error.into());
            }
            Err(_) => {
                crate::rdp_process::cleanup(&file)?;
                return Err(
                    openshell_core_domain::DomainError::internal("远程桌面启动任务失败").into(),
                );
            }
        };
        (Some(child.id()), Some(child), Some(events), Some(reader))
    };
    #[cfg(not(windows))]
    let (pid, child, events, reader) = (None, None, None, None);
    rdp_launches()
        .lock()
        .map_err(|_| openshell_core_domain::DomainError::internal("RDP 状态不可用"))?
        .insert(
            launch_id.clone(),
            RdpRuntimeEntry {
                session_id: session_id.clone(),
                state: "starting",
                error: None,
                exit_code: None,
                child,
                file: file.clone(),
                events,
                reader,
                recorded_login: false,
            },
        );
    Ok(RdpLaunchResult {
        launch_id,
        session_id,
        rdp_file_path: file.to_string_lossy().into_owned(),
        pid,
        host,
        port,
    })
}

#[tauri::command]
pub async fn rdp_get_status(
    state: tauri::State<'_, Arc<AppServices>>,
    launch_id: String,
) -> Result<RdpRuntimeStatus, IpcError> {
    let (status, record_login) = {
        let mut launches = rdp_launches()
            .lock()
            .map_err(|_| openshell_core_domain::DomainError::internal("RDP 状态不可用"))?;
        let entry = launches
            .get_mut(&launch_id)
            .ok_or_else(|| openshell_core_domain::DomainError::not_found("RDP launch not found"))?;
        if entry.state != "closed" {
            if let Some(events) = &entry.events {
                let events = events.lock().map_err(|_| {
                    openshell_core_domain::DomainError::internal("RDP 状态通道不可用")
                })?;
                entry.state = events.state;
                entry.error = events.error.clone();
            }
        }
        if let Some(child) = entry.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    entry.exit_code = status.code();
                    if !matches!(entry.state, "failed" | "closed" | "disconnected") {
                        entry.state = if entry.recorded_login {
                            "disconnected"
                        } else {
                            "failed"
                        };
                        entry.error = if entry.recorded_login {
                            None
                        } else {
                            Some("远程桌面进程退出，未取得登录结果".into())
                        };
                    }
                    entry.child = None;
                    if let Some(reader) = entry.reader.take() {
                        let _ = reader.join();
                    }
                    if let Some(events) = &entry.events {
                        let events = events.lock().map_err(|_| {
                            openshell_core_domain::DomainError::internal("RDP 状态通道不可用")
                        })?;
                        if matches!(events.state, "closed" | "failed" | "disconnected") {
                            entry.state = events.state;
                            entry.error = events.error.clone();
                        }
                    }
                    if let Err(error) = crate::rdp_process::cleanup(&entry.file) {
                        entry.state = "failed";
                        entry.error = Some("远程桌面已退出，但临时文件清理失败".into());
                        return Err(error.into());
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    entry.state = "failed";
                    entry.error = Some("无法查询远程桌面进程状态".into());
                    tracing::warn!(error = %error, launch_id, "failed to query RDP host process");
                }
            }
        }
        let record_login = !entry.recorded_login
            && entry
                .events
                .as_ref()
                .is_some_and(|events| events.lock().is_ok_and(|events| events.authenticated));
        if record_login {
            entry.recorded_login = true;
        }
        (
            RdpRuntimeStatus {
                launch_id,
                session_id: entry.session_id.clone(),
                state: entry.state,
                error: entry.error.clone(),
                exit_code: entry.exit_code,
            },
            record_login,
        )
    };
    if record_login {
        state
            .session
            .touch_used(&SessionId::from_string(&status.session_id)?, "success")
            .await?;
    }
    Ok(status)
}

#[tauri::command]
pub async fn rdp_close(launch_id: String) -> Result<(), IpcError> {
    let mut launches = rdp_launches()
        .lock()
        .map_err(|_| openshell_core_domain::DomainError::internal("RDP 状态不可用"))?;
    let entry = launches
        .get_mut(&launch_id)
        .ok_or_else(|| openshell_core_domain::DomainError::not_found("RDP launch not found"))?;
    match crate::rdp_process::close(&mut entry.child, &entry.file) {
        Ok(exit_code) => entry.exit_code = exit_code.or(entry.exit_code),
        Err(error) => {
            entry.state = "failed";
            entry.error = Some("无法完成远程桌面清理".into());
            return Err(error.into());
        }
    }
    if let Some(reader) = entry.reader.take() {
        let _ = reader.join();
    }
    entry.state = "closed";
    entry.error = None;
    Ok(())
}

#[cfg(test)]
mod protocol_command_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn application_exit_closes_owned_rdp_launches_and_files() {
        use std::os::windows::process::CommandExt;
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("owned.rdp");
        std::fs::write(&file, b"synthetic").unwrap();
        let child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        rdp_launches().lock().unwrap().insert(
            "exit-test".into(),
            RdpRuntimeEntry {
                session_id: String::new(),
                state: "launched",
                error: None,
                exit_code: None,
                child: Some(child),
                file: file.clone(),
                events: None,
                reader: None,
                recorded_login: false,
            },
        );
        shutdown_rdp_launches();
        assert!(!file.exists());
        assert!(rdp_launches().lock().unwrap().is_empty());
    }

    #[test]
    fn task4_wire_values_and_runtime_metadata_match_shared_contract() {
        use openshell_core_domain::{SnippetKind, SocksAuth, TransferState};
        assert_eq!(
            serde_json::to_value(TransferState::Running).unwrap(),
            "running"
        );
        assert_eq!(
            serde_json::to_value(SocksAuth::Userpass).unwrap(),
            "userpass"
        );
        assert_eq!(serde_json::to_value(SnippetKind::Macro).unwrap(), "macro");
        let input: SnippetInput = serde_json::from_value(
            serde_json::json!({"name":"test","kind":"snippet","body":"echo test"}),
        )
        .unwrap();
        assert_eq!(input.body.as_deref(), Some("echo test"));
        let status = RdpRuntimeStatus {
            launch_id: "launch".into(),
            session_id: "session".into(),
            state: "launched",
            error: None,
            exit_code: None,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"launch_id":"launch","session_id":"session","state":"launched","error":null,"exit_code":null})
        );
    }

    #[tokio::test]
    async fn all_protocol_fields_survive_save_update_and_readback() {
        let state = AppServices::new_in_memory().unwrap();
        let group = state
            .session
            .create_group(None, "自定义".into(), GroupKind::Session)
            .await
            .unwrap();
        for (protocol, options) in [
            (
                Protocol::Ssh,
                serde_json::json!({"accelerate":true,"exec_channel_enable":false}),
            ),
            (
                Protocol::Rdp,
                serde_json::json!({"width":1600,"height":900,"domain":"DOMAIN","fullscreen":false}),
            ),
            (
                Protocol::Serial,
                serde_json::json!({"port_name":"COM9","baud_rate":921600,"data_bits":"eight","auto_reconnect":false}),
            ),
            (
                Protocol::Telnet,
                serde_json::json!({"auto_login":true,"login_prompt":"登录：","newline_mode":"crlf"}),
            ),
            (
                Protocol::LocalShell,
                serde_json::json!({"shell_kind":"custom","shell_path":"C:/工具/shell.exe","args":["--login"]}),
            ),
        ] {
            let source = serde_json::json!({
                "name":format!("{protocol:?} 连接"), "protocol":protocol,
                "host":protocol.requires_host().then_some("server.test"),
                "port":protocol.default_port(), "username":"用户",
                "auth_method":"agent", "host_key_policy":"strict",
                "proxy_id":"proxy-1", "proxy_jump_json":[{"host":"jump.test","port":2222}],
                "terminal_profile_id":"profile-1", "encoding":"gb18030",
                "startup_command":"echo 你好", "working_dir":"C:/工作目录",
                "keepalive_sec":47, "keepalive_max_miss":9,
                "auto_reconnect":false, "reconnect_max":13, "compression":true,
                "agent_forwarding":true, "x11_forwarding":true,
                "tags_json":["生产","多协议"], "favorite":true,
                "color":"#336699", "icon_key":"device:terminal", "notes":"完整字段",
                "protocol_options_json":options, "sort_order":4096
            });
            let input: SessionInput = serde_json::from_value(source.clone()).unwrap();
            let saved = state.session.create_session(input.clone()).await.unwrap();
            assert!(saved.group_id.is_none());
            let serialized = serde_json::to_value(&saved).unwrap();
            for (key, value) in source.as_object().unwrap() {
                assert_eq!(&serialized[key], value, "create {protocol:?}: {key}");
            }
            let created = state
                .session
                .create_session(SessionInput {
                    name: Some("before import".into()),
                    protocol: Some(protocol),
                    group_id: Some(group.id.clone()),
                    host_key_policy: Some(openshell_core_domain::HostKeyPolicy::AcceptNew),
                    ..Default::default()
                })
                .await
                .unwrap();
            state
                .session
                .update_session(&created.id, import_session_patch(input), None)
                .await
                .unwrap();
            let readback = state.session.get_session(&created.id).await.unwrap();
            assert_eq!(
                readback.group_id.as_ref(),
                Some(&group.id),
                "default grouping must not move a custom group"
            );
            let serialized = serde_json::to_value(&readback).unwrap();
            for (key, value) in source.as_object().unwrap() {
                assert_eq!(&serialized[key], value, "{protocol:?}: {key}");
            }
            let listed = state
                .session
                .list_sessions(&SessionQuery::default())
                .await
                .unwrap();
            let listed = listed
                .iter()
                .find(|session| session.id == created.id)
                .unwrap();
            assert_eq!(serde_json::to_value(listed).unwrap(), serialized);
            let patch = import_session_patch(SessionInput {
                group_id: Some(group.id.clone()),
                protocol: Some(protocol),
                ..Default::default()
            });
            assert_eq!(patch.group_id, Some(Some(group.id.clone())));
            assert_eq!(patch.port, Some(protocol.default_port()));
        }
    }

    #[tokio::test]
    async fn embedded_forwards_update_destinations_without_duplicates_and_inherit_reconnect() {
        let state = AppServices::new_in_memory().unwrap();
        let session = state
            .session
            .create_session(SessionInput {
                name: Some("SSH".into()),
                auto_reconnect: Some(false),
                reconnect_max: Some(11),
                ..Default::default()
            })
            .await
            .unwrap();
        for dest_port in [80, 8080] {
            let rule =
                serde_json::json!({"name":"web","type":100,"port":8888,"dst_port":dest_port});
            let options = serde_json::json!({"port_forwarding_list":[rule.clone(),rule]});
            import_embedded_forwards(
                &state,
                &session,
                Some(&options),
                Some(session.auto_reconnect),
            )
            .await
            .unwrap();
            let rules = state
                .port_forward_repo
                .list(Some(&session.id))
                .await
                .unwrap();
            assert_eq!(rules.len(), 1);
            assert_eq!(rules[0].dest_port, Some(dest_port));
            assert!(!rules[0].auto_reconnect);
            assert_eq!(rules[0].reconnect_max, 11);
        }
    }

    #[test]
    fn local_shell_options_use_ipc_camel_case() {
        let options: LocalShellOpenOptions = serde_json::from_value(
            serde_json::json!({"sessionId":"abc","shellKind":"cmd","workingDir":"C:/"}),
        )
        .unwrap();
        assert_eq!(options.session_id.as_deref(), Some("abc"));
        assert_eq!(options.shell_kind.as_deref(), Some("cmd"));
        assert_eq!(options.working_dir.as_deref(), Some("C:/"));
    }
    #[test]
    fn rdp_file_validates_lines_and_maps_options() {
        let default = rdp_config("host", 3389, "user", &RdpOptions::default()).unwrap();
        assert!(default.contains("desktopwidth:i:1920\r\n"));
        assert!(default.contains("desktopheight:i:1080\r\n"));
        let options = RdpOptions {
            fullscreen: true,
            custom_size: true,
            width: Some(1280),
            height: Some(720),
            drivestoredirect: true,
            redirect_audio: Some("remote".into()),
            ..Default::default()
        };
        let config = rdp_config("::1", 3389, "user", &options).unwrap();
        assert!(config.contains("full address:s:[::1]:3389\r\n"));
        assert!(config.contains("desktopwidth:i:1280\r\n"));
        assert!(config.contains("audiomode:i:1\r\n"));
        assert!(rdp_config("host\r\npassword:s:bad", 3389, "user", &options).is_err());
    }
}
