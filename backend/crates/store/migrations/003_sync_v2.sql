-- 同步协议 v2 的本地元数据。
-- 只追加列和表，不重写现有业务数据；旧 sync_record 行保留 v1 默认值。

ALTER TABLE sync_record ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_record ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_record ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_record ADD COLUMN device_id TEXT;
ALTER TABLE sync_record ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_record ADD COLUMN remote_ciphertext_b64 TEXT;

CREATE TABLE sync_conflict (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  local_snapshot_json JSON,
  remote_ciphertext_b64 TEXT NOT NULL,
  remote_checksum TEXT NOT NULL,
  remote_revision INTEGER NOT NULL,
  remote_device_id TEXT,
  remote_deleted INTEGER NOT NULL DEFAULT 0,
  remote_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX idx_sync_conflict_unresolved
  ON sync_conflict(resolved_at, created_at DESC);
CREATE INDEX idx_sync_conflict_record
  ON sync_conflict(record_type, record_id, created_at DESC);

-- 只把跨设备仍有意义的偏好纳入同步。渲染器、日志、壁纸、本地路径、
-- 更新与同步凭据继续保持设备私有。
UPDATE setting
SET syncable = 1,
    dirty = 1
WHERE scope = 'user'
  AND key IN (
    'terminal.theme',
    'terminal.font_size',
    'terminal.font_family',
    'terminal.cursor_blink',
    'terminal.cursor_style',
    'terminal.scrollback',
    'terminal.keepalive_default_sec'
  );
