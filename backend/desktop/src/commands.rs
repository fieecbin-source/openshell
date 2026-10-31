//! Tauri IPC 命令实现（薄层：契约映射与参数校验）。

use crate::error::IpcError;
use openshell_app_core::{AppServices, ConnectOverrides, VaultStatus};
use openshell_core_domain::{
    AiCatalogView, AiConfigView, AiProfile, AiProfileInput, ChannelOpener, ConnectionId,
    Credential, CredentialId, CredentialKind, FileEntryType, Group, GroupId, GroupKind,
    HostMetrics, PortForwardId, PortForwardRepository, PortForwardRule, PortForwardRuleInput,
    Protocol, ProviderTestResult, SavePolicy, Session, SessionId, SessionInput, SessionPatch,
    SessionQuery, SftpFileEntry, Snippet, SnippetId, SnippetInput, SnippetRepository, SshKey,
    SshKeyId, TabId, TermSize, TransferTask,
};
use openshell_forward::ForwardStatus;
use openshell_importer::{
    CandidateAction, ConflictStrategy, FinalShellParser, ImportCandidate, ImportPreviewEngine,
    ImportPreviewReport, OpenShellExportBundle, OpenSshParser,
};
use openshell_store::SettingRecord;
use serde::Serialize;
use std::sync::Arc;

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
    let stream = state
        .ssh_manager
        .open_shell(&cid, TermSize::new(cols, rows))
        .await?;
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

#[tauri::command]
pub async fn sftp_list_dir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<Vec<SftpFileEntry>, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    let entries = client.read_dir(&path).await?;
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_stat(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<SftpFileEntry, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    let entry = client.stat(&path).await?;
    Ok(entry)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.mkdir(&path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.remove_file(&path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_dir(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.remove_dir(&path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.rename(&old_path, &new_path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_set_permissions(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    permissions: u32,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.set_permissions(&path, permissions).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_read_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    let data = client
        .read_file_content(&path, max_bytes.unwrap_or(10 * 1024 * 1024))
        .await?;
    Ok(data)
}

#[tauri::command]
pub async fn sftp_write_file(
    state: tauri::State<'_, Arc<AppServices>>,
    conn_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), IpcError> {
    let cid = ConnectionId::from_string(&conn_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    client.write_file_content(&path, &data).await?;
    Ok(())
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
    let cid = ConnectionId::from_string(&conn_id)?;
    let sid = SessionId::from_string(&session_id)?;
    let client = state.get_or_create_sftp(&cid).await?;
    let resume = resume.unwrap_or(true);
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
    let metrics = state.monitor.history().get_latest(&sid).await;
    Ok(metrics)
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
    let list = state.port_forward_repo.list(sid.as_ref()).await?;
    Ok(list)
}

#[tauri::command]
pub async fn forward_create(
    state: tauri::State<'_, Arc<AppServices>>,
    input: PortForwardRuleInput,
) -> Result<PortForwardRule, IpcError> {
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
    let rule = state.port_forward_repo.update(&pf_id, input).await?;
    Ok(rule)
}

#[tauri::command]
pub async fn forward_delete(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    state.forward.stop_rule(&pf_id).await;
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
    let rule = state.port_forward_repo.get(&pf_id).await?;
    let conn = state.ssh_manager.get(&cid).await?;
    state
        .forward
        .start_rule(rule, conn)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn forward_stop(
    state: tauri::State<'_, Arc<AppServices>>,
    id: String,
) -> Result<(), IpcError> {
    let pf_id = PortForwardId::from_string(&id)?;
    state.forward.stop_rule(&pf_id).await;
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

#[tauri::command]
pub async fn importer_commit(
    state: tauri::State<'_, Arc<AppServices>>,
    candidates: Vec<ImportCandidate>,
) -> Result<usize, IpcError> {
    let mut count = 0;
    for cand in candidates {
        match cand.action {
            CandidateAction::Create => {
                state.session.create_session(cand.input).await?;
                count += 1;
            }
            CandidateAction::Update => {
                if let Some(id_str) = cand.existing_session_id {
                    let sid = SessionId::from_string(&id_str)?;
                    let patch = SessionPatch {
                        name: cand.input.name,
                        protocol: cand.input.protocol,
                        host: Some(cand.input.host),
                        port: Some(cand.input.port),
                        username: Some(cand.input.username),
                        auth_method: cand.input.auth_method,
                        credential_id: Some(cand.input.credential_id),
                        ssh_key_id: Some(cand.input.ssh_key_id),
                        keepalive_sec: cand.input.keepalive_sec,
                        ..Default::default()
                    };
                    state.session.update_session(&sid, patch, None).await?;
                    count += 1;
                }
            }
            CandidateAction::Skip => {}
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn importer_export_bundle_json(
    state: tauri::State<'_, Arc<AppServices>>,
) -> Result<String, IpcError> {
    let sessions = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let groups = state.session.list_groups(GroupKind::Session).await?;
    let snippets = state.snippet_repo.list(None).await?;
    let port_forwards = state.port_forward_repo.list(None).await?;
    let bundle = OpenShellExportBundle::new(sessions, groups, snippets, port_forwards);
    let json_str = bundle
        .to_json_string()
        .map_err(|e| openshell_core_domain::DomainError::internal(e.to_string()))?;
    Ok(json_str)
}

#[tauri::command]
pub async fn importer_export_bundle_encrypted(
    state: tauri::State<'_, Arc<AppServices>>,
    password: String,
) -> Result<Vec<u8>, IpcError> {
    let sessions = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let groups = state.session.list_groups(GroupKind::Session).await?;
    let snippets = state.snippet_repo.list(None).await?;
    let port_forwards = state.port_forward_repo.list(None).await?;
    let bundle = OpenShellExportBundle::new(sessions, groups, snippets, port_forwards);
    let pkg = bundle.to_encrypted_package(&password)?;
    Ok(pkg)
}

#[tauri::command]
pub async fn importer_preview_bundle_json(
    state: tauri::State<'_, Arc<AppServices>>,
    json_str: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    let strat = parse_conflict_strategy(strategy.as_deref());
    let bundle = OpenShellExportBundle::from_json_str(&json_str)
        .map_err(|e| openshell_core_domain::DomainError::validation(e.to_string()))?;
    let inputs: Vec<SessionInput> = bundle
        .sessions
        .into_iter()
        .map(|s| SessionInput {
            group_id: s.group_id,
            name: Some(s.name),
            protocol: Some(s.protocol),
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: Some(s.auth_method),
            credential_id: s.credential_id,
            ssh_key_id: s.ssh_key_id,
            host_key_policy: Some(s.host_key_policy),
            proxy_jump_json: s.proxy_jump_json,
            terminal_profile_id: s.terminal_profile_id,
            encoding: Some(s.encoding),
            startup_command: s.startup_command,
            working_dir: s.working_dir,
            keepalive_sec: Some(s.keepalive_sec),
            keepalive_max_miss: Some(s.keepalive_max_miss),
            auto_reconnect: Some(s.auto_reconnect),
            reconnect_max: Some(s.reconnect_max),
            compression: Some(s.compression),
            agent_forwarding: Some(s.agent_forwarding),
            tags_json: s.tags_json,
            favorite: Some(s.favorite),
            color: s.color,
            icon_key: s.icon_key,
            notes: s.notes,
            protocol_options_json: s.protocol_options_json,
            sort_order: Some(s.sort_order),
        })
        .collect();
    let existing = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let report = ImportPreviewEngine::generate_preview(inputs, &existing, strat, Vec::new());
    Ok(report)
}

#[tauri::command]
pub async fn importer_preview_bundle_encrypted(
    state: tauri::State<'_, Arc<AppServices>>,
    pkg_bytes: Vec<u8>,
    password: String,
    strategy: Option<String>,
) -> Result<ImportPreviewReport, IpcError> {
    let strat = parse_conflict_strategy(strategy.as_deref());
    let bundle = OpenShellExportBundle::from_encrypted_package(&pkg_bytes, &password)?;
    let inputs: Vec<SessionInput> = bundle
        .sessions
        .into_iter()
        .map(|s| SessionInput {
            group_id: s.group_id,
            name: Some(s.name),
            protocol: Some(s.protocol),
            host: s.host,
            port: s.port,
            username: s.username,
            auth_method: Some(s.auth_method),
            credential_id: s.credential_id,
            ssh_key_id: s.ssh_key_id,
            host_key_policy: Some(s.host_key_policy),
            proxy_jump_json: s.proxy_jump_json,
            terminal_profile_id: s.terminal_profile_id,
            encoding: Some(s.encoding),
            startup_command: s.startup_command,
            working_dir: s.working_dir,
            keepalive_sec: Some(s.keepalive_sec),
            keepalive_max_miss: Some(s.keepalive_max_miss),
            auto_reconnect: Some(s.auto_reconnect),
            reconnect_max: Some(s.reconnect_max),
            compression: Some(s.compression),
            agent_forwarding: Some(s.agent_forwarding),
            tags_json: s.tags_json,
            favorite: Some(s.favorite),
            color: s.color,
            icon_key: s.icon_key,
            notes: s.notes,
            protocol_options_json: s.protocol_options_json,
            sort_order: Some(s.sort_order),
        })
        .collect();
    let existing = state
        .session
        .list_sessions(&SessionQuery::default())
        .await?;
    let report = ImportPreviewEngine::generate_preview(inputs, &existing, strat, Vec::new());
    Ok(report)
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
    let list = state.settings_repo.list(&scope)?;
    Ok(list)
}

// ==========================================
// Sync & E2EE Cloud
// ==========================================

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
    let mock = use_mock.unwrap_or(false);
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
