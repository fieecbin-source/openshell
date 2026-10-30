//! AI 模型档案与本地命令历史仓储。
//!
//! 安全约束：`ai_profile` / `command_history` 均不包含任何密钥列，
//! API Key 只写入系统凭据库或保险库加密文件。

use crate::models::map_sql_error;
use crate::Store;
use openshell_core_domain::{
    now_ms, AiProfile, AiWireKind, ApprovalPolicy, CommandHistoryEntry, DomainError, DomainResult,
};
use rusqlite::types::Type;
use rusqlite::{params, Error as SqlError, OptionalExtension, Row, TransactionBehavior};

/// 每个标签页保留的最大历史条数。
const HISTORY_LIMIT_PER_TAB: i64 = 200;

const PROFILE_COLUMNS: &str = "id, provider, label, base_url, model_id, wire, default_policy, \
    logo_key, verified_at, created_at, updated_at";

const HISTORY_COLUMNS: &str = "id, tab_id, command, exit_code, executed_at";

fn bad_value(col: usize, what: &'static str) -> SqlError {
    SqlError::FromSqlConversionFailure(
        col,
        Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, what)),
    )
}

/// 校验档案/历史标识为合法 ULID。
fn ensure_ulid(id: &str, what: &'static str) -> DomainResult<()> {
    ulid::Ulid::from_string(id)
        .map(|_| ())
        .map_err(|_| DomainError::validation(format!("invalid {what} id")))
}

fn profile_from_row(row: &Row<'_>) -> rusqlite::Result<AiProfile> {
    let wire_raw: String = row.get(5)?;
    let policy_raw: String = row.get(6)?;
    let wire = AiWireKind::parse(&wire_raw).ok_or_else(|| bad_value(5, "invalid ai wire"))?;
    let default_policy = ApprovalPolicy::parse(&policy_raw)
        .ok_or_else(|| bad_value(6, "invalid approval policy"))?;

    Ok(AiProfile {
        id: row.get(0)?,
        provider: row.get(1)?,
        label: row.get(2)?,
        base_url: row.get(3)?,
        model_id: row.get(4)?,
        wire,
        default_policy,
        logo_key: row.get(7)?,
        verified_at: row.get(8)?,
        // 是否已有密钥由凭据后端决定，不落库。
        has_api_key: false,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn history_from_row(row: &Row<'_>) -> rusqlite::Result<CommandHistoryEntry> {
    Ok(CommandHistoryEntry {
        id: row.get(0)?,
        tab_id: row.get(1)?,
        command: row.get(2)?,
        exit_code: row.get(3)?,
        executed_at: row.get(4)?,
    })
}

/// AI 模型档案仓储。
pub struct AiProfileRepo {
    store: Store,
}

impl AiProfileRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// 按创建时间倒序列出全部档案。
    pub fn list(&self) -> DomainResult<Vec<AiProfile>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {PROFILE_COLUMNS} FROM ai_profile ORDER BY created_at ASC, id ASC"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map([], profile_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    /// 按标识读取档案。
    pub fn get(&self, id: &str) -> DomainResult<Option<AiProfile>> {
        ensure_ulid(id, "ai profile")?;
        self.store.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {PROFILE_COLUMNS} FROM ai_profile WHERE id = ?1"),
                params![id],
                profile_from_row,
            )
            .optional()
            .map_err(map_sql_error)
        })
    }

    /// 新建档案。
    pub fn create(&self, profile: &AiProfile) -> DomainResult<()> {
        ensure_ulid(&profile.id, "ai profile")?;
        if profile.provider.trim().is_empty() || profile.label.trim().is_empty() {
            return Err(DomainError::validation(
                "ai profile provider and label cannot be empty",
            ));
        }
        self.store.with_conn(|conn| {
            conn.execute(
                &format!(
                    "INSERT INTO ai_profile({PROFILE_COLUMNS}) \
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
                ),
                params![
                    profile.id,
                    profile.provider,
                    profile.label,
                    profile.base_url,
                    profile.model_id,
                    profile.wire.as_str(),
                    profile.default_policy.as_str(),
                    profile.logo_key,
                    profile.verified_at,
                    profile.created_at,
                    profile.updated_at,
                ],
            )
            .map_err(map_sql_error)?;
            Ok(())
        })
    }

    /// 更新档案（不含 `has_api_key` 等派生字段）。
    pub fn update(&self, profile: &AiProfile) -> DomainResult<()> {
        ensure_ulid(&profile.id, "ai profile")?;
        if profile.provider.trim().is_empty() || profile.label.trim().is_empty() {
            return Err(DomainError::validation(
                "ai profile provider and label cannot be empty",
            ));
        }
        self.store.with_conn(|conn| {
            let affected = conn
                .execute(
                    "UPDATE ai_profile SET provider = ?1, label = ?2, base_url = ?3, \
                     model_id = ?4, wire = ?5, default_policy = ?6, logo_key = ?7, \
                     verified_at = ?8, created_at = ?9, updated_at = ?10 WHERE id = ?11",
                    params![
                        profile.provider,
                        profile.label,
                        profile.base_url,
                        profile.model_id,
                        profile.wire.as_str(),
                        profile.default_policy.as_str(),
                        profile.logo_key,
                        profile.verified_at,
                        profile.created_at,
                        profile.updated_at,
                        profile.id,
                    ],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("ai profile not found"));
            }
            Ok(())
        })
    }

    /// 删除档案。
    pub fn delete(&self, id: &str) -> DomainResult<()> {
        ensure_ulid(id, "ai profile")?;
        self.store.with_conn(|conn| {
            let affected = conn
                .execute("DELETE FROM ai_profile WHERE id = ?1", params![id])
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("ai profile not found"));
            }
            Ok(())
        })
    }

    /// 记录最近一次联通测试成功时间（Unix 毫秒）。
    pub fn set_verified_at(&self, id: &str, at: i64) -> DomainResult<()> {
        ensure_ulid(id, "ai profile")?;
        self.store.with_conn(|conn| {
            let affected = conn
                .execute(
                    "UPDATE ai_profile SET verified_at = ?1 WHERE id = ?2",
                    params![at, id],
                )
                .map_err(map_sql_error)?;
            if affected == 0 {
                return Err(DomainError::not_found("ai profile not found"));
            }
            Ok(())
        })
    }
}

/// 本地命令历史仓储（按标签页去重，上限 200 条）。
pub struct CommandHistoryRepo {
    store: Store,
}

impl CommandHistoryRepo {
    /// 绑定到指定存储句柄。
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    /// 记录一次命令执行；空命令直接忽略。
    ///
    /// 同一 `tab_id + command`（大小写不敏感）只保留一条，仅刷新时间与退出码。
    pub fn record(&self, tab_id: &str, command: &str, exit_code: Option<i32>) -> DomainResult<()> {
        let command = command.trim();
        if tab_id.trim().is_empty() || command.is_empty() {
            return Ok(());
        }
        let now = now_ms();

        self.store.with_conn(|conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sql_error)?;

            let existing: Option<(String, i64)> = tx
                .query_row(
                    "SELECT id, executed_at FROM command_history \
                     WHERE tab_id = ?1 AND command = ?2 COLLATE NOCASE \
                     ORDER BY executed_at DESC, rowid DESC LIMIT 1",
                    params![tab_id, command],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(map_sql_error)?;

            match existing {
                Some((id, _)) => {
                    tx.execute(
                        "UPDATE command_history SET exit_code = ?1, executed_at = ?2 WHERE id = ?3",
                        params![exit_code, now, id],
                    )
                    .map_err(map_sql_error)?;
                }
                None => {
                    let id = ulid::Ulid::new().to_string();
                    tx.execute(
                        "INSERT INTO command_history(id, tab_id, command, exit_code, executed_at) \
                         VALUES(?1, ?2, ?3, ?4, ?5)",
                        params![id, tab_id, command, exit_code, now],
                    )
                    .map_err(map_sql_error)?;
                }
            }

            // 每个标签页仅保留最近 N 条，超出部分删除最旧。
            tx.execute(
                "DELETE FROM command_history WHERE tab_id = ?1 AND id NOT IN (\
                 SELECT id FROM command_history WHERE tab_id = ?1 \
                 ORDER BY executed_at DESC, rowid DESC LIMIT ?2)",
                params![tab_id, HISTORY_LIMIT_PER_TAB],
            )
            .map_err(map_sql_error)?;

            tx.commit().map_err(map_sql_error)
        })
    }

    /// 列出全局最近命令。
    pub fn list(&self, limit: usize) -> DomainResult<Vec<CommandHistoryEntry>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {HISTORY_COLUMNS} FROM command_history \
                     ORDER BY executed_at DESC, rowid DESC LIMIT ?1"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map(params![limit_to_i64(limit)], history_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    /// 列出指定标签页的最近命令。
    pub fn list_for_tab(
        &self,
        tab_id: &str,
        limit: usize,
    ) -> DomainResult<Vec<CommandHistoryEntry>> {
        self.store.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {HISTORY_COLUMNS} FROM command_history WHERE tab_id = ?1 \
                     ORDER BY executed_at DESC, rowid DESC LIMIT ?2"
                ))
                .map_err(map_sql_error)?;
            let rows = stmt
                .query_map(params![tab_id, limit_to_i64(limit)], history_from_row)
                .map_err(map_sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sql_error)
        })
    }

    /// 清空指定标签页的历史。
    pub fn clear_tab(&self, tab_id: &str) -> DomainResult<()> {
        self.store.with_conn(|conn| {
            conn.execute(
                "DELETE FROM command_history WHERE tab_id = ?1",
                params![tab_id],
            )
            .map_err(map_sql_error)?;
            Ok(())
        })
    }
}

fn limit_to_i64(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core_domain::new_id;

    fn migrated_store() -> Store {
        let store = Store::open_in_memory().expect("open in-memory db");
        assert_eq!(store.migrate().expect("migrate"), crate::migrator::SCHEMA_VERSION);
        store
    }

    fn table_exists(store: &Store, name: &str) -> bool {
        store
            .with_conn(|conn| {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        params![name],
                        |r| r.get(0),
                    )
                    .map_err(map_sql_error)?;
                Ok(count > 0)
            })
            .expect("query sqlite_master")
    }

    fn sample_profile(id: &str, now: i64) -> AiProfile {
        AiProfile {
            id: id.to_string(),
            provider: "deepseek".into(),
            label: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model_id: "deepseek-chat".into(),
            wire: AiWireKind::OpenAiChat,
            default_policy: ApprovalPolicy::Manual,
            logo_key: "ai-deepseek".into(),
            verified_at: None,
            has_api_key: false,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn ai_migration_on_empty_db_creates_tables() {
        let store = Store::open_in_memory().expect("open in-memory db");
        assert_eq!(store.migrate().expect("migrate"), crate::migrator::SCHEMA_VERSION);
        assert!(table_exists(&store, "ai_profile"));
        assert!(table_exists(&store, "command_history"));
    }

    #[test]
    fn ai_migration_from_v1_to_v2_is_idempotent() {
        let store = Store::open_in_memory().expect("open in-memory db");
        store
            .with_conn(|conn| {
                conn.execute_batch(include_str!("../../migrations/001_init.sql"))
                    .map_err(map_sql_error)?;
                conn.pragma_update(None, "user_version", 1i64)
                    .map_err(map_sql_error)?;
                Ok(())
            })
            .expect("seed v1 schema");

        let version: i64 = store
            .with_conn(|conn| {
                conn.pragma_query_value(None, "user_version", |r| r.get(0))
                    .map_err(map_sql_error)
            })
            .expect("read user_version");
        assert_eq!(version, 1);
        assert!(!table_exists(&store, "ai_profile"));

        assert_eq!(store.migrate().expect("migrate v1 -> v2"), crate::migrator::SCHEMA_VERSION);
        assert!(table_exists(&store, "ai_profile"));
        assert!(table_exists(&store, "command_history"));

        // 再次迁移幂等。
        assert_eq!(store.migrate().expect("migrate again"), crate::migrator::SCHEMA_VERSION);
        assert!(table_exists(&store, "ai_profile"));
    }

    #[test]
    fn ai_profile_crud_roundtrip() {
        let store = migrated_store();
        let repo = AiProfileRepo::new(store.clone());
        let id = new_id();
        let now = now_ms();
        let mut profile = sample_profile(&id, now);

        repo.create(&profile).expect("create profile");
        assert_eq!(repo.list().expect("list").len(), 1);
        let loaded = repo.get(&id).expect("get").expect("exists");
        assert_eq!(loaded, profile);
        assert!(!loaded.has_api_key);

        profile.label = "DeepSeek V3".into();
        profile.wire = AiWireKind::AnthropicMessages;
        profile.default_policy = ApprovalPolicy::FullAuto;
        profile.updated_at = now + 10;
        repo.update(&profile).expect("update");
        let loaded = repo.get(&id).expect("get").expect("exists");
        assert_eq!(loaded.label, "DeepSeek V3");
        assert_eq!(loaded.wire, AiWireKind::AnthropicMessages);
        assert_eq!(loaded.default_policy, ApprovalPolicy::FullAuto);

        repo.set_verified_at(&id, now + 20).expect("verify");
        assert_eq!(
            repo.get(&id).expect("get").expect("exists").verified_at,
            Some(now + 20)
        );

        repo.delete(&id).expect("delete");
        assert!(repo.get(&id).expect("get").is_none());
        assert!(repo.delete(&id).is_err());
    }

    #[test]
    fn ai_profile_rejects_invalid_id_and_wire() {
        let store = migrated_store();
        let repo = AiProfileRepo::new(store.clone());
        let mut profile = sample_profile("not-a-ulid", now_ms());
        let err = repo.create(&profile).expect_err("invalid id");
        assert_eq!(err.code, openshell_core_domain::ErrorCode::Validation);

        // 非法 wire 落库后读取返回内部错误而不是 panic。
        let id = new_id();
        profile = sample_profile(&id, now_ms());
        repo.create(&profile).expect("create");
        store
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE ai_profile SET wire = 'bogus' WHERE id = ?1",
                    params![id],
                )
                .map_err(map_sql_error)
            })
            .expect("corrupt wire");
        let err = repo.get(&id).expect_err("invalid wire");
        assert_eq!(err.code, openshell_core_domain::ErrorCode::Internal);
    }

    #[test]
    fn ai_command_history_dedup_and_limit() {
        let store = migrated_store();
        let repo = CommandHistoryRepo::new(store);
        let tab = new_id();

        repo.record(&tab, "  ", Some(0)).expect("ignore empty");
        assert!(repo.list(10).expect("list").is_empty());

        repo.record(&tab, "ls -la", Some(0)).expect("first");
        repo.record(&tab, "LS -LA", Some(1))
            .expect("dedup case-insensitive");
        let entries = repo.list_for_tab(&tab, 10).expect("list tab");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "ls -la");
        assert_eq!(entries[0].exit_code, Some(1));

        repo.clear_tab(&tab).expect("clear");
        assert!(repo.list_for_tab(&tab, 10).expect("list tab").is_empty());

        for i in 0..205 {
            repo.record(&tab, &format!("cmd-{i}"), Some(0))
                .expect("record");
        }
        let entries = repo.list_for_tab(&tab, 1000).expect("list tab");
        assert_eq!(entries.len(), 200);
        let commands: Vec<&str> = entries.iter().map(|e| e.command.as_str()).collect();
        assert!(commands.contains(&"cmd-204"));
        assert!(!commands.contains(&"cmd-0"));
        assert!(!commands.contains(&"cmd-4"));
        assert!(commands.contains(&"cmd-5"));
    }

    #[test]
    fn ai_command_history_is_per_tab() {
        let store = migrated_store();
        let repo = CommandHistoryRepo::new(store);
        let tab_a = new_id();
        let tab_b = new_id();
        repo.record(&tab_a, "pwd", Some(0)).expect("a");
        repo.record(&tab_b, "pwd", Some(0)).expect("b");
        assert_eq!(repo.list_for_tab(&tab_a, 10).expect("a").len(), 1);
        assert_eq!(repo.list_for_tab(&tab_b, 10).expect("b").len(), 1);
        repo.clear_tab(&tab_a).expect("clear a");
        assert!(repo.list_for_tab(&tab_a, 10).expect("a").is_empty());
        assert_eq!(repo.list_for_tab(&tab_b, 10).expect("b").len(), 1);
        assert_eq!(repo.list(10).expect("global").len(), 1);
    }
}
