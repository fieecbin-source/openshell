import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AppInfo,
  ConnectSessionResult,
  Credential,
  CredentialKind,
  Group,
  GroupKind,
  SavePolicy,
  Session,
  SessionInput,
  SessionPatch,
  SshKey,
  VaultStatus,
} from "../types/ipc";

/**
 * 当前是否运行在 Tauri 桌面容器内。
 *
 * 在浏览器预览（Vite dev server）里没有注入 `__TAURI_INTERNALS__`，
 * 直接调用 `invoke` 会抛出 "Cannot read properties of undefined (reading 'invoke')"。
 * 调用前先用它做一次判断，可以给出可读的提示而不是底层 TypeError。
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAppInfo(): Promise<AppInfo> {
  return await invoke<AppInfo>("app_info");
}

export async function getVaultStatus(): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_status");
}

export async function initVault(
  masterPassword: string,
  rememberInKeychain = false
): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_init", {
    masterPassword,
    rememberInKeychain,
  });
}

export async function unlockVault(
  masterPassword?: string,
  useKeychain = false
): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_unlock", {
    masterPassword: masterPassword || null,
    useKeychain,
  });
}

export async function lockVault(): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_lock");
}

export async function changeVaultPassword(
  oldPassword: string,
  newPassword: string
): Promise<VaultStatus> {
  return await invoke<VaultStatus>("vault_change_password", {
    oldPassword,
    newPassword,
  });
}

export async function listSessions(params?: {
  groupId?: string;
  query?: string;
  favoriteOnly?: boolean;
}): Promise<Session[]> {
  return await invoke<Session[]>("session_list", {
    groupId: params?.groupId || null,
    query: params?.query || null,
    favoriteOnly: params?.favoriteOnly || false,
  });
}

export async function getSession(id: string): Promise<Session> {
  return await invoke<Session>("session_get", { id });
}

export async function createSession(input: SessionInput): Promise<Session> {
  return await invoke<Session>("session_create", { input });
}

export async function updateSession(
  id: string,
  patch: SessionPatch
): Promise<Session> {
  return await invoke<Session>("session_update", { id, patch });
}

export async function deleteSession(id: string): Promise<void> {
  await invoke("session_delete", { id });
}

export async function duplicateSession(id: string): Promise<Session> {
  return await invoke<Session>("session_duplicate", { id });
}

export async function listGroups(kind: GroupKind = "session"): Promise<Group[]> {
  return await invoke<Group[]>("group_list", { kind });
}

export async function createGroup(
  name: string,
  parentId?: string | null,
  kind: GroupKind = "session"
): Promise<Group> {
  return await invoke<Group>("group_create", {
    parentId: parentId || null,
    name,
    kind,
  });
}

export async function renameGroup(id: string, name: string): Promise<Group> {
  return await invoke<Group>("group_rename", { id, name });
}

/** 移动分组到新父级并调整排序（拖拽移组 / 排序）；后端会做成环与深度校验 */
export async function moveGroup(
  id: string,
  parentId: string | null,
  sortOrder?: number
): Promise<Group> {
  return await invoke<Group>("group_move", {
    id,
    parentId: parentId || null,
    sortOrder: sortOrder ?? null,
  });
}

export async function deleteGroup(id: string): Promise<void> {
  await invoke("group_delete", { id });
}

export async function listCredentials(): Promise<Credential[]> {
  return await invoke<Credential[]>("credential_list");
}

export async function createCredential(
  name: string,
  kind: CredentialKind,
  secret: string,
  username?: string,
  hint?: string,
  savePolicy: SavePolicy = "always"
): Promise<Credential> {
  return await invoke<Credential>("credential_create", {
    name,
    kind,
    secret,
    username: username || null,
    hint: hint || null,
    savePolicy,
  });
}

export async function deleteCredential(id: string): Promise<void> {
  await invoke("credential_delete", { id });
}

export async function listSshKeys(): Promise<SshKey[]> {
  return await invoke<SshKey[]>("ssh_key_list");
}

export async function importSshKey(
  name: string,
  pem: string,
  passphrase?: string,
  comment?: string
): Promise<SshKey> {
  return await invoke<SshKey>("ssh_key_import", {
    name,
    pem,
    passphrase: passphrase || null,
    comment: comment || null,
  });
}

export async function deleteSshKey(id: string): Promise<void> {
  await invoke("ssh_key_delete", { id });
}

export async function setSshKeyPassphrase(id: string, passphrase: string): Promise<SshKey> {
  return await invoke<SshKey>("ssh_key_set_passphrase", { id, passphrase });
}

export async function connectSession(
  requestId: string,
  sessionId: string,
  overrides?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    passphrase?: string;
  }
): Promise<ConnectSessionResult> {
  return await invoke<ConnectSessionResult>("connect_session", {
    requestId,
    sessionId,
    overrides: overrides || null,
  });
}

export async function closeConnection(connectionId: string): Promise<void> {
  await invoke("connection_close", { connectionId });
}

export async function openTerminal(
  tabId: string,
  connectionId: string,
  cols: number,
  rows: number,
  onData: (data: number[]) => void
): Promise<string> {
  const channel = new Channel<number[]>();
  channel.onmessage = onData;

  return await invoke<string>("terminal_open", {
    tabId,
    connectionId,
    cols,
    rows,
    onData: channel,
  });
}

export async function writeTerminal(
  tabId: string,
  data: number[] | Uint8Array
): Promise<number> {
  const payload = Array.from(data);
  const res = await invoke<{ accepted: number }>("terminal_write", {
    tabId,
    data: payload,
  });
  return res.accepted;
}

export async function resizeTerminal(
  tabId: string,
  cols: number,
  rows: number
): Promise<void> {
  await invoke("terminal_resize", { tabId, cols, rows });
}

export async function ackTerminal(
  tabId: string,
  bytes: number
): Promise<number> {
  const res = await invoke<{ credit: number }>("terminal_ack", {
    tabId,
    bytes,
  });
  return res.credit;
}

export async function closeTerminal(tabId: string): Promise<void> {
  await invoke("terminal_close", { tabId });
}

export async function cancelOperation(requestId: string): Promise<boolean> {
  return await invoke<boolean>("op_cancel", { requestId });
}

// ==========================================
// Local FS & SFTP
// ==========================================

export async function localFsHome(): Promise<string> {
  return await invoke<string>("local_fs_home");
}

export async function localFsList(path?: string): Promise<import("../types/ipc").SftpFileEntry[]> {
  return await invoke<import("../types/ipc").SftpFileEntry[]>("local_fs_list", { path: path || null });
}

export async function sftpListDir(connId: string, path: string): Promise<import("../types/ipc").SftpFileEntry[]> {
  return await invoke<import("../types/ipc").SftpFileEntry[]>("sftp_list_dir", { connId, path });
}

export async function sftpStat(connId: string, path: string): Promise<import("../types/ipc").SftpFileEntry> {
  return await invoke<import("../types/ipc").SftpFileEntry>("sftp_stat", { connId, path });
}

export async function sftpMkdir(connId: string, path: string): Promise<void> {
  await invoke("sftp_mkdir", { connId, path });
}

export async function sftpRemoveFile(connId: string, path: string): Promise<void> {
  await invoke("sftp_remove_file", { connId, path });
}

export async function sftpRemoveDir(connId: string, path: string): Promise<void> {
  await invoke("sftp_remove_dir", { connId, path });
}

export async function sftpRename(connId: string, oldPath: string, newPath: string): Promise<void> {
  await invoke("sftp_rename", { connId, oldPath, newPath });
}

export async function sftpSetPermissions(connId: string, path: string, permissions: number): Promise<void> {
  await invoke("sftp_set_permissions", { connId, path, permissions });
}

export async function sftpReadFile(connId: string, path: string, maxBytes?: number): Promise<number[]> {
  return await invoke<number[]>("sftp_read_file", { connId, path, maxBytes: maxBytes || null });
}

export async function sftpWriteFile(connId: string, path: string, data: number[] | Uint8Array): Promise<void> {
  const payload = Array.from(data);
  await invoke("sftp_write_file", { connId, path, data: payload });
}

export async function sftpStartTransfer(
  connId: string,
  sessionId: string,
  direction: "upload" | "download",
  localPath: string,
  remotePath: string,
  resume = true
): Promise<string> {
  return await invoke<string>("sftp_start_transfer", {
    connId,
    sessionId,
    direction,
    localPath,
    remotePath,
    resume,
  });
}

export async function sftpListTransfers(): Promise<import("../types/ipc").TransferTask[]> {
  return await invoke<import("../types/ipc").TransferTask[]>("sftp_list_transfers");
}

export async function sftpPauseTransfer(taskId: string): Promise<void> {
  await invoke("sftp_pause_transfer", { taskId });
}

export async function sftpCancelTransfer(taskId: string): Promise<void> {
  await invoke("sftp_cancel_transfer", { taskId });
}

export async function sftpGetCwd(sessionId: string): Promise<string | null> {
  return await invoke<string | null>("sftp_get_cwd", { sessionId });
}

// ==========================================
// Monitor
// ==========================================

export async function monitorStart(sessionId: string, connId: string, intervalSec = 3): Promise<void> {
  await invoke("monitor_start", { sessionId, connId, intervalSec });
}

export async function monitorStop(sessionId: string): Promise<void> {
  await invoke("monitor_stop", { sessionId });
}

export async function monitorGetLatest(sessionId: string): Promise<import("../types/ipc").HostMetrics | null> {
  return await invoke<import("../types/ipc").HostMetrics | null>("monitor_get_latest", { sessionId });
}

export async function monitorGetHistory(sessionId: string, durationSec = 300): Promise<import("../types/ipc").HostMetrics[]> {
  return await invoke<import("../types/ipc").HostMetrics[]>("monitor_get_history", { sessionId, durationSec });
}

export async function monitorKillProcess(connId: string, pid: number, signal = 15): Promise<void> {
  await invoke("monitor_kill_process", { connId, pid, signal });
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

export async function sshExec(connId: string, command: string): Promise<SshExecResult> {
  return await invoke<SshExecResult>("ssh_exec", { connId, command });
}

// ==========================================
// Port Forwarding
// ==========================================

export async function forwardList(sessionId?: string): Promise<import("../types/ipc").PortForwardRule[]> {
  return await invoke<import("../types/ipc").PortForwardRule[]>("forward_list", { sessionId: sessionId || null });
}

export async function forwardCreate(input: import("../types/ipc").PortForwardRuleInput): Promise<import("../types/ipc").PortForwardRule> {
  return await invoke<import("../types/ipc").PortForwardRule>("forward_create", { input });
}

export async function forwardUpdate(id: string, input: import("../types/ipc").PortForwardRuleInput): Promise<import("../types/ipc").PortForwardRule> {
  return await invoke<import("../types/ipc").PortForwardRule>("forward_update", { id, input });
}

export async function forwardDelete(id: string): Promise<void> {
  await invoke("forward_delete", { id });
}

export async function forwardStart(id: string, connId: string): Promise<void> {
  await invoke("forward_start", { id, connId });
}

export async function forwardStop(id: string): Promise<void> {
  await invoke("forward_stop", { id });
}

export async function forwardListStatuses(): Promise<Record<string, import("../types/ipc").ForwardStatus>> {
  return await invoke<Record<string, import("../types/ipc").ForwardStatus>>("forward_list_statuses");
}

// ==========================================
// Snippets & Quick Commands
// ==========================================

export async function snippetList(groupId?: string): Promise<import("../types/ipc").Snippet[]> {
  return await invoke<import("../types/ipc").Snippet[]>("snippet_list", { groupId: groupId || null });
}

export async function snippetCreate(input: import("../types/ipc").SnippetInput): Promise<import("../types/ipc").Snippet> {
  return await invoke<import("../types/ipc").Snippet>("snippet_create", { input });
}

export async function snippetUpdate(id: string, input: import("../types/ipc").SnippetInput): Promise<import("../types/ipc").Snippet> {
  return await invoke<import("../types/ipc").Snippet>("snippet_update", { id, input });
}

export async function snippetDelete(id: string): Promise<void> {
  await invoke("snippet_delete", { id });
}

// ==========================================
// Importer & Exporter
// ==========================================

export async function importerPreviewOpenSsh(
  content: string,
  strategy?: import("../types/ipc").ConflictStrategy
): Promise<import("../types/ipc").ImportPreviewReport> {
  return await invoke<import("../types/ipc").ImportPreviewReport>("importer_preview_openssh", {
    content,
    strategy: strategy || null,
  });
}

export async function importerPreviewFinalShell(
  content: string,
  strategy?: import("../types/ipc").ConflictStrategy
): Promise<import("../types/ipc").ImportPreviewReport> {
  return await invoke<import("../types/ipc").ImportPreviewReport>("importer_preview_finalshell", {
    content,
    strategy: strategy || null,
  });
}

export async function importerCommit(candidates: import("../types/ipc").ImportCandidate[]): Promise<number> {
  return await invoke<number>("importer_commit", { candidates });
}

export async function importerExportBundleJson(): Promise<string> {
  return await invoke<string>("importer_export_bundle_json");
}

export async function importerExportBundleEncrypted(password: string): Promise<number[]> {
  return await invoke<number[]>("importer_export_bundle_encrypted", { password });
}

export async function importerPreviewBundleJson(
  jsonStr: string,
  strategy?: import("../types/ipc").ConflictStrategy
): Promise<import("../types/ipc").ImportPreviewReport> {
  return await invoke<import("../types/ipc").ImportPreviewReport>("importer_preview_bundle_json", {
    jsonStr,
    strategy: strategy || null,
  });
}

export async function importerPreviewBundleEncrypted(
  pkgBytes: number[] | Uint8Array,
  password: string,
  strategy?: import("../types/ipc").ConflictStrategy
): Promise<import("../types/ipc").ImportPreviewReport> {
  const payload = Array.from(pkgBytes);
  return await invoke<import("../types/ipc").ImportPreviewReport>("importer_preview_bundle_encrypted", {
    pkgBytes: payload,
    password,
    strategy: strategy || null,
  });
}

// ==========================================
// Settings
// ==========================================

export async function settingsGet(
  scope: string,
  key: string,
  scopeId?: string
): Promise<import("../types/ipc").SettingRecord | null> {
  return await invoke<import("../types/ipc").SettingRecord | null>("settings_get", {
    scope,
    scopeId: scopeId || null,
    key,
  });
}

export async function settingsSet(
  scope: string,
  key: string,
  value: any,
  scopeId?: string,
  syncable = false
): Promise<import("../types/ipc").SettingRecord> {
  return await invoke<import("../types/ipc").SettingRecord>("settings_set", {
    scope,
    scopeId: scopeId || null,
    key,
    value,
    syncable,
  });
}

export async function settingsList(scope: string): Promise<import("../types/ipc").SettingRecord[]> {
  return await invoke<import("../types/ipc").SettingRecord[]>("settings_list", { scope });
}

// ==========================================
// Session Cards (视图卡)
// ==========================================

export async function createCard(sessionId: string): Promise<import("../types/ipc").SessionCard> {
  return await invoke<import("../types/ipc").SessionCard>("card_create", { sessionId });
}

export async function listCards(): Promise<import("../types/ipc").SessionCard[]> {
  return await invoke<import("../types/ipc").SessionCard[]>("card_list");
}

export async function getCard(cardId: string): Promise<import("../types/ipc").SessionCard> {
  return await invoke<import("../types/ipc").SessionCard>("card_get", { cardId });
}

export async function setCardMode(
  cardId: string,
  mode: import("../types/ipc").CardMode
): Promise<import("../types/ipc").SessionCard> {
  return await invoke<import("../types/ipc").SessionCard>("card_set_mode", { cardId, mode });
}

export async function markCardConnected(
  cardId: string,
  connectionId?: string
): Promise<import("../types/ipc").SessionCard> {
  return await invoke<import("../types/ipc").SessionCard>("card_mark_connected", {
    cardId,
    connectionId: connectionId || null,
  });
}

export async function markCardDisconnected(
  cardId: string,
  reason?: string
): Promise<import("../types/ipc").SessionCard> {
  return await invoke<import("../types/ipc").SessionCard>("card_mark_disconnected", {
    cardId,
    reason: reason || null,
  });
}

export async function closeCard(cardId: string): Promise<void> {
  return await invoke<void>("card_close", { cardId });
}

// ==========================================
// Serial Subsystem (串口通信)
// ==========================================

export async function listSerialPorts(): Promise<import("../types/ipc").SerialPortInfo[]> {
  return await invoke<import("../types/ipc").SerialPortInfo[]>("serial_list_ports");
}

export async function openSerial(
  cardId: string,
  config: import("../types/ipc").SerialProfileConfig,
  useMock = false
): Promise<void> {
  return await invoke<void>("serial_open", {
    cardId,
    config,
    useMock,
  });
}

export async function sendSerial(cardId: string, data: number[] | Uint8Array): Promise<number> {
  const bytes = Array.from(data);
  return await invoke<number>("serial_send", { cardId, data: bytes });
}

export async function readSerial(cardId: string, maxBytes?: number): Promise<number[]> {
  return await invoke<number[]>("serial_read", { cardId, maxBytes: maxBytes || null });
}

export async function setSerialLines(
  cardId: string,
  dtr?: boolean,
  rts?: boolean
): Promise<void> {
  return await invoke<void>("serial_set_lines", {
    cardId,
    dtr: dtr ?? null,
    rts: rts ?? null,
  });
}

export async function getSerialModemStatus(
  cardId: string
): Promise<import("../types/ipc").ModemStatus> {
  return await invoke<import("../types/ipc").ModemStatus>("serial_get_modem_status", { cardId });
}

export async function setSerialBaudRate(cardId: string, baudRate: number): Promise<void> {
  return await invoke<void>("serial_set_baud_rate", { cardId, baudRate });
}

export async function getSerialStats(
  cardId: string
): Promise<import("../types/ipc").SerialStats | null> {
  return await invoke<import("../types/ipc").SerialStats | null>("serial_get_stats", { cardId });
}

export async function closeSerial(cardId: string): Promise<void> {
  return await invoke<void>("serial_close", { cardId });
}

// AI 终端助手（阶段 1）：模型配置与凭据命令统一由 ai/aiIpc 提供。
export * from "./ai/aiIpc";

