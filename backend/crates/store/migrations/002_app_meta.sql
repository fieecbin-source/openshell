-- 002: 应用级元数据表。
--
-- 只增不删：新增独立表，不修改 001 中任何已有表/列/索引。
-- 用途：
--   * last_app_version —— 上一次成功启动的客户端版本，用于识别「升级后首次启动」；
--   * last_migration_at —— 最近一次 schema 迁移完成时间；
--   * last_recovery_at / last_recovery_backup —— 最近一次迁移失败并从快照恢复的记录，
--     供前端启动横幅提示用户「数据已从备份恢复」。
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
