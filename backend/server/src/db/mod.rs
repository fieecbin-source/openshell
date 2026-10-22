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
