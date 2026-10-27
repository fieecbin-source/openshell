export type Protocol = "ssh" | "sftp" | "telnet" | "serial" | "local_shell";
export type AuthMethod = "password" | "publickey" | "public_key" | "keyboard_interactive" | "agent" | "none";
export type HostKeyPolicy = "strict" | "accept_new" | "insecure";
export type GroupKind = "session" | "snippet";
export type CredentialKind = "password" | "keyboard_interactive" | "passphrase";
export type SavePolicy = "always" | "ask" | "never";

/**
 * 标签连接状态：
 * connecting   首次建连中
 * connected    已连接且通道可用
 * reconnecting 已断开，正在按退避策略自动重连
 * disconnected 已断开（等待手动重连 / 自动重连次数用尽）
 * error        连接失败（凭据、网络、主机密钥等）
 */
export type TabStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface SyncMeta {
  version: number;
  origin_device_id: string | null;
  dirty: boolean;
}

export interface Session {
  id: string;
  group_id: string | null;
  name: string;
  protocol: Protocol;
  host: string | null;
  port: number | null;
  username: string | null;
  auth_method: AuthMethod;
  credential_id: string | null;
  ssh_key_id: string | null;
  host_key_policy: HostKeyPolicy;
  proxy_jump_json: any | null;
  proxy_id: string | null;
  terminal_profile_id: string | null;
  encoding: string;
  startup_command: string | null;
  working_dir: string | null;
  keepalive_sec: number;
  keepalive_max_miss: number;
  auto_reconnect: boolean;
  reconnect_max: number;
  compression: boolean;
  agent_forwarding: boolean;
  x11_forwarding: boolean;
  tags_json: any | null;
  favorite: boolean;
  color: string | null;
  icon_key: string | null;
  notes: string | null;
  protocol_options_json: any | null;
  last_used_at: number | null;
  last_result: string | null;
  use_count: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface SessionInput {
  group_id?: string | null;
  name?: string | null;
  protocol?: Protocol;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  auth_method?: AuthMethod;
  credential_id?: string | null;
  ssh_key_id?: string | null;
  host_key_policy?: HostKeyPolicy;
  proxy_jump_json?: any | null;
  encoding?: string;
  favorite?: boolean;
  color?: string | null;
  notes?: string | null;
  keepalive_sec?: number;
  protocol_options_json?: any | null;
}

export interface SessionPatch {
  group_id?: string | null;
  name?: string;
  protocol?: Protocol;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  auth_method?: AuthMethod;
  credential_id?: string | null;
  ssh_key_id?: string | null;
  host_key_policy?: HostKeyPolicy;
  proxy_jump_json?: any | null;
  encoding?: string;
  favorite?: boolean;
  color?: string | null;
  notes?: string | null;
  keepalive_sec?: number;
  protocol_options_json?: any | null;
  /** 拖拽排序时使用（稀疏步进，1024 为间隔） */
  sort_order?: number;
}

export interface Group {
  id: string;
  parent_id: string | null;
  name: string;
  kind: GroupKind;
  sort_order: number;
  color: string | null;
  icon_key: string | null;
  expanded: boolean;
  notes: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  username: string | null;
  secret_id: string;
  hint: string | null;
  save_policy: SavePolicy;
  created_at: number;
}

export interface SshKey {
  id: string;
  name: string;
  algorithm: string;
  public_key: string;
  fingerprint_sha256: string;
  has_passphrase: boolean;
  comment: string | null;
  created_at: number;
}

export interface VaultStatus {
  state: "uninitialized" | "locked" | "unlocked";
  vault_id: string | null;
  auto_lock_minutes: number;
  keychain_enabled: boolean;
  last_opened_at: number | null;
}

export interface AppInfo {
  version: string;
  target: string;
  arch: string;
  data_dir: string;
  /** 本地数据库 schema 版本（低于程序支持版本表示处于「已恢复」状态）。 */
  schema_version: number;
  /** 迁移失败并已从快照恢复：前端显示恢复横幅。 */
  degraded: boolean;
  /** 便携运行（可执行文件旁存在 openshell.portable）。 */
  is_portable: boolean;
}

export interface ConnectSessionResult {
  connection_id: string;
  session_id: string;
}

export interface IpcError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  correlation_id: string;
}

// ==========================================
// SFTP & Filesystem
// ==========================================

export type FileEntryType = "regular" | "directory" | "symlink";

export interface SftpFileEntry {
  name: string;
  path: string;
  size: number;
  file_type: FileEntryType;
  permissions: number;
  modified_at: number;
  accessed_at: number;
  uid: number | null;
  gid: number | null;
}

export type TransferDirection = "upload" | "download";
export type TransferState = "queued" | "transferring" | "paused" | "completed" | "failed" | "cancelled";

export interface TransferTask {
  id: string;
  session_id: string;
  direction: TransferDirection;
  local_path: string;
  remote_path: string;
  total_bytes: number;
  transferred_bytes: number;
  speed_bps: number;
  state: TransferState;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

// ==========================================
// Monitor & Metrics
// ==========================================

export interface DiskMountMetrics {
  mount_point: string;
  filesystem: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  use_percent: number;
}

export interface ProcessMetrics {
  pid: number;
  user: string;
  cpu_percent: number;
  /** 后端字段名为 memory_percent（serde snake_case），历史前端误写成 mem_percent 导致渲染崩溃 */
  memory_percent: number;
  /** 进程短名（ps comm 列） */
  name: string;
  /** 完整命令行 */
  command: string;
}

export interface HostMetrics {
  session_id: string;
  timestamp_ms: number;
  cpu_percent: number;
  cpu_cores: number[];
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_cached_bytes: number;
  load_1: number;
  load_5: number;
  load_15: number;
  net_rx_bps: number;
  net_tx_bps: number;
  net_rx_total: number;
  net_tx_total: number;
  disk_mounts: DiskMountMetrics[];
  top_processes: ProcessMetrics[];
  uptime_seconds: number;
}

// ==========================================
// Port Forwarding
// ==========================================

export type PortForwardType = "local" | "remote" | "dynamic";
export type SocksAuth = "none" | "user_pass";

export interface PortForwardRule {
  id: string;
  session_id: string | null;
  name: string;
  rule_type: PortForwardType;
  bind_host: string;
  bind_port: number;
  dest_host: string | null;
  dest_port: number | null;
  auto_start: boolean;
  auto_reconnect: boolean;
  reconnect_max: number;
  socks_auth: SocksAuth;
  socks_username: string | null;
  socks_password_ref: string | null;
  expose_warning_ack: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PortForwardRuleInput {
  session_id?: string | null;
  name: string;
  rule_type?: PortForwardType;
  bind_host?: string;
  bind_port: number;
  dest_host?: string | null;
  dest_port?: number | null;
  auto_start?: boolean;
  auto_reconnect?: boolean;
  reconnect_max?: number;
  socks_auth?: SocksAuth;
  socks_username?: string | null;
  socks_password_ref?: string | null;
  expose_warning_ack?: boolean;
  sort_order?: number;
}

export type ForwardStatus =
  | { state: "Stopped" }
  | { state: "Listening"; details: { bound_addr: string } }
  | { state: "Error"; details: string };

// ==========================================
// Snippets & Quick Commands
// ==========================================

export type SnippetKind = "command" | "macro";
export type SendMode = "insert" | "execute";

export interface Snippet {
  id: string;
  group_id: string | null;
  name: string;
  kind: SnippetKind;
  command_template: string;
  description: string | null;
  shortcut: string | null;
  send_mode: SendMode;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface SnippetInput {
  group_id?: string | null;
  name: string;
  kind?: SnippetKind;
  command_template: string;
  description?: string | null;
  shortcut?: string | null;
  send_mode?: SendMode;
  sort_order?: number;
}

// ==========================================
// Importer & Exporter
// ==========================================

export type ConflictStrategy = "skip" | "overwrite" | "keep_both";
export type CandidateAction = "create" | "update" | "skip";

export interface ImportCandidate {
  input: SessionInput;
  action: CandidateAction;
  existing_session_id: string | null;
}

export interface ImportPreviewReport {
  total: number;
  new_count: number;
  update_count: number;
  skip_count: number;
  warnings: string[];
  candidates: ImportCandidate[];
}

// ==========================================
// Settings
// ==========================================

export interface SettingRecord {
  id: string;
  scope: string;
  scope_id: string | null;
  key: string;
  value_json: any;
  value_type: string;
  syncable: boolean;
  updated_at: number;
  version: number;
  origin_device_id: string | null;
  dirty: boolean;
}

// ==========================================
// Session Cards & Serial Subsystem
// ==========================================

export type CardMode = "command" | "view";
export type CardState = "connecting" | "connected" | "disconnected" | "reconnecting" | "closed";

export interface SessionCard {
  card_id: string;
  session_id: string;
  name: string;
  protocol: Protocol;
  current_mode: CardMode;
  state: CardState;
  connection_id: string | null;
  created_at: number;
  last_active_at: number;
}

export type SerialDataBits = "five" | "six" | "seven" | "eight";
export type SerialStopBits = "one" | "one_point_five" | "two";
export type SerialParity = "none" | "even" | "odd" | "mark" | "space";
export type SerialFlowControl = "none" | "software" | "hardware";
export type SerialNewlineMode = "none" | "cr" | "lf" | "crlf";
export type SerialOutputNewlineMode = "none" | "cr_to_crlf" | "lf_to_crlf" | "strip_cr";

export interface SerialProfileConfig {
  port_name: string;
  baud_rate: number;
  data_bits?: SerialDataBits;
  stop_bits?: SerialStopBits;
  parity?: SerialParity;
  flow_control?: SerialFlowControl;
  dtr_on_open?: boolean;
  rts_on_open?: boolean;
  input_newline?: SerialNewlineMode;
  output_newline?: SerialOutputNewlineMode;
  local_echo?: boolean;
  auto_reconnect?: boolean;
  reconnect_interval_ms?: number;
}

export interface SerialPortInfo {
  name: string;
  port_type: string;
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
  vid: number | null;
  pid: number | null;
}

export interface ModemStatus {
  cts: boolean;
  dsr: boolean;
  ri: boolean;
  cd: boolean;
}

export interface SerialStats {
  rx_bytes: number;
  tx_bytes: number;
  rx_bps: number;
  tx_bps: number;
}


