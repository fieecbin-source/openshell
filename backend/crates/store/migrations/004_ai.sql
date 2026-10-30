-- AI 模型档案与本地命令历史（SCHEMA_VERSION 4）。
-- 幂等：所有语句使用 IF NOT EXISTS；不修改 001_init.sql 中的既有表。
-- 安全：本文件不含任何密钥列，API Key 只写入系统凭据库或保险库加密文件。

-- 早期未发布的 AI 版本曾占用版本 2；为其补齐正式版本 2 的元数据表。
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_profile (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  wire TEXT NOT NULL,
  default_policy TEXT NOT NULL DEFAULT 'manual',
  logo_key TEXT NOT NULL DEFAULT 'ai-core',
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_profile_created ON ai_profile(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_profile_provider ON ai_profile(provider);

-- 命令历史：按标签页去重（同一命令仅保留最近一次执行时间），供阶段 2 补全使用。
CREATE TABLE IF NOT EXISTS command_history (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  executed_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_command_history_tab_command
  ON command_history(tab_id, command COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_command_history_recent
  ON command_history(executed_at DESC);
