-- M2 首版 schema，字段与 spec/data-model.md §5 对齐。
-- 时间统一为 Unix 毫秒；布尔使用 INTEGER 0/1；JSON 列使用 TEXT。

CREATE TABLE vault (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  crypto_suite TEXT NOT NULL,
  kdf_alg TEXT NOT NULL,
  kdf_mem_kib INTEGER NOT NULL,
  kdf_time INTEGER NOT NULL,
  kdf_parallelism INTEGER NOT NULL,
  kdf_salt BLOB NOT NULL,
  wrapped_vault_key BLOB NOT NULL,
  key_check BLOB NOT NULL,
  keychain_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  account_id TEXT,
  quota_bytes INTEGER
);

CREATE TABLE session_group (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES session_group(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'session',
  sort_order INTEGER NOT NULL DEFAULT 1024,
  color TEXT,
  icon_key TEXT,
  expanded INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES session_group(id),
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  username TEXT,
  auth_method TEXT,
  credential_id TEXT REFERENCES credential(id),
  ssh_key_id TEXT REFERENCES ssh_key(id),
  host_key_policy TEXT NOT NULL DEFAULT 'strict',
  proxy_jump_json JSON,
  proxy_id TEXT,
  terminal_profile_id TEXT,
  encoding TEXT NOT NULL DEFAULT 'UTF-8',
  startup_command TEXT,
  working_dir TEXT,
  keepalive_sec INTEGER NOT NULL DEFAULT 30,
  keepalive_max_miss INTEGER NOT NULL DEFAULT 3,
  auto_reconnect INTEGER NOT NULL DEFAULT 0,
  reconnect_max INTEGER NOT NULL DEFAULT 7,
  compression INTEGER NOT NULL DEFAULT 0,
  agent_forwarding INTEGER NOT NULL DEFAULT 0,
  x11_forwarding INTEGER NOT NULL DEFAULT 0,
  tags_json JSON NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  icon_key TEXT,
  notes TEXT,
  protocol_options_json JSON,
  last_used_at INTEGER,
  last_result TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  username TEXT,
  secret_id TEXT NOT NULL,
  hint TEXT,
  save_policy TEXT NOT NULL DEFAULT 'ask',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE secret (
  id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  aad BLOB NOT NULL,
  crypto_suite TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ssh_key (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_size INTEGER,
  public_key TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL UNIQUE,
  secret_id TEXT NOT NULL,
  passphrase_credential_id TEXT REFERENCES credential(id),
  has_passphrase INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE known_host (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trusted',
  previous_fingerprint TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  changed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'prompt',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  UNIQUE(host, port, key_type)
);

CREATE TABLE snippet (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES session_group(id),
  kind TEXT NOT NULL DEFAULT 'snippet',
  name TEXT NOT NULL,
  body TEXT,
  variables_json JSON NOT NULL DEFAULT '[]',
  macro_steps_json JSON,
  send_mode TEXT NOT NULL DEFAULT 'insert',
  shortcut TEXT,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  tags_json JSON NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE port_forward (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL,
  dest_host TEXT,
  dest_port INTEGER,
  auto_start INTEGER NOT NULL DEFAULT 0,
  auto_reconnect INTEGER NOT NULL DEFAULT 1,
  reconnect_max INTEGER NOT NULL DEFAULT 7,
  socks_auth TEXT NOT NULL DEFAULT 'none',
  socks_username TEXT,
  socks_password_ref TEXT,
  expose_warning_ack INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1024,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE setting (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  key TEXT NOT NULL,
  value_json JSON NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'json',
  syncable INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  origin_device_id TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, scope_id, key)
);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT
);

CREATE TABLE sync_meta (
  vault_id TEXT PRIMARY KEY,
  server_url TEXT,
  account_id TEXT,
  device_id TEXT,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  last_push_at INTEGER,
  last_pull_at INTEGER,
  last_error_code TEXT,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'idle'
);

CREATE TABLE sync_record (
  record_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  base_version INTEGER NOT NULL DEFAULT 0,
  local_rev INTEGER NOT NULL DEFAULT 0,
  server_checksum TEXT,
  sync_state TEXT NOT NULL DEFAULT 'clean',
  conflict_json JSON,
  updated_at INTEGER NOT NULL
);

-- 唯一约束：软删除后允许复用同一名称（部分索引）。
-- 使用 COALESCE 让根级（parent_id/group_id 为 NULL）同样受唯一性约束。
CREATE UNIQUE INDEX idx_group_parent_name
  ON session_group(COALESCE(parent_id, ''), name COLLATE NOCASE)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_session_group_name
  ON session(COALESCE(group_id, ''), name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_group_parent ON session_group(parent_id, sort_order);
CREATE INDEX idx_group_kind ON session_group(kind);
CREATE INDEX idx_session_group ON session(group_id, sort_order);
CREATE INDEX idx_session_recent ON session(last_used_at DESC);
CREATE INDEX idx_session_favorite ON session(favorite, sort_order);
CREATE INDEX idx_session_dirty ON session(dirty, updated_at);
CREATE INDEX idx_session_deleted ON session(deleted_at);
CREATE INDEX idx_credential_name ON credential(name COLLATE NOCASE);
CREATE INDEX idx_credential_dirty ON credential(dirty, updated_at);
CREATE INDEX idx_sshkey_name ON ssh_key(name COLLATE NOCASE);
CREATE INDEX idx_knownhost_status ON known_host(status);
CREATE INDEX idx_secret_type ON secret(record_type);
CREATE INDEX idx_snippet_group ON snippet(group_id, sort_order);
CREATE INDEX idx_snippet_kind ON snippet(kind);
CREATE INDEX idx_forward_session ON port_forward(session_id, sort_order);
CREATE UNIQUE INDEX idx_forward_bind
  ON port_forward(session_id, bind_host, bind_port)
  WHERE bind_port > 0 AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_setting_scope_key ON setting(scope, COALESCE(scope_id, ''), key);
CREATE INDEX idx_setting_lookup ON setting(scope, scope_id, key);
CREATE INDEX idx_setting_dirty ON setting(dirty);
CREATE INDEX idx_vault_name ON vault(name);
CREATE INDEX idx_vault_sync ON vault(sync_enabled);
CREATE INDEX idx_sync_state ON sync_record(sync_state, updated_at);
