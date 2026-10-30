mod migrations;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use tracing::info;

const SCHEMA_SQL: &str = include_str!("schema.sql");

#[derive(Clone)]
pub struct DbPool {
    conn: Arc<Mutex<Connection>>,
}

impl DbPool {
    pub fn open(path_or_url: &str) -> Result<Self, rusqlite::Error> {
        let conn = if path_or_url == ":memory:" || path_or_url.is_empty() {
            Connection::open_in_memory()?
        } else {
            let path = Path::new(path_or_url);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
            Connection::open(path)?
        };

        // Enable WAL mode, busy timeout, and foreign keys
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let pool = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        pool.migrate()?;
        Ok(pool)
    }

    pub fn migrate(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock();
        conn.execute_batch(SCHEMA_SQL)?;
        migrations::apply_sync_v2(&conn)?;
        info!("Server database migrations applied successfully");
        Ok(())
    }

    pub fn with_conn<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut Connection) -> R,
    {
        let mut conn = self.conn.lock();
        f(&mut conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_legacy_database_applies_sync_v2_before_v2_indexes_and_triggers() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let database = temp_dir.path().join("legacy.db");
        let conn = Connection::open(&database).expect("open legacy database");
        conn.execute_batch(
            "
            CREATE TABLE record (
              vault_id TEXT NOT NULL,
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
            CREATE TABLE record_history (
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
            INSERT INTO record VALUES (
              'vault', 'legacy-record', 3, 'cipher', 'checksum', 6, 0, NULL,
              '2026-10-29T00:00:00Z', 'legacy-device'
            );
            ",
        )
        .expect("create legacy schema");
        drop(conn);

        let pool = DbPool::open(database.to_str().expect("database path"))
            .expect("migrate legacy database");
        pool.with_conn(|conn| {
            let metadata: (u64, String) = conn
                .query_row(
                    "SELECT revision, client_updated_at FROM record WHERE record_id = 'legacy-record'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read migrated record");
            assert_eq!(metadata.0, 3);
            assert_eq!(metadata.1, "2026-10-29T00:00:00Z");
        });
    }
}
