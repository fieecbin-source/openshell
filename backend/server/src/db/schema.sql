CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  token_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_sync_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS refresh_token (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault (
  vault_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  schema_version INTEGER NOT NULL,
  crypto_suite TEXT NOT NULL,
  kdf_json TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_check TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_slot (
  vault_id TEXT NOT NULL REFERENCES vault(vault_id),
  key_version INTEGER NOT NULL,
  kdf_json TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_check TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY(vault_id, key_version)
);

CREATE TABLE IF NOT EXISTS record (
  vault_id TEXT NOT NULL REFERENCES vault(vault_id),
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY(vault_id, record_id)
);

CREATE TABLE IF NOT EXISTS record_history (
  vault_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  valid_from_seq INTEGER NOT NULL,
  valid_to_seq INTEGER,
  PRIMARY KEY(vault_id, record_id, version)
);

CREATE TABLE IF NOT EXISTS commit_log (
  vault_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  change_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'normal',
  PRIMARY KEY(vault_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vault(vault_id),
  label TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  manifest_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_record (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  checksum TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY(snapshot_id, record_id)
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  account_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, method, path, key)
);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  device_id TEXT,
  type TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS update_manifest (
  target TEXT NOT NULL,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(target, channel, version)
);

CREATE TABLE IF NOT EXISTS relay_ticket (
  ticket_id TEXT PRIMARY KEY,
  ticket TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  dest_host TEXT NOT NULL,
  dest_port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  bytes_limit INTEGER NOT NULL,
  max_idle_sec INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_account ON device(account_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_record_vault_seq ON record_history(vault_id, seq);
CREATE INDEX IF NOT EXISTS idx_commit_log_vault_seq ON commit_log(vault_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_event_account ON audit_event(account_id, at);
CREATE INDEX IF NOT EXISTS idx_update_manifest_target_channel ON update_manifest(target, channel);
