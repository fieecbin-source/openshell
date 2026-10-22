//! `Store`：连接管理、Pragma 配置与事务入口。

use crate::models::map_sql_error;
use openshell_core_domain::{DomainError, DomainResult};
use parking_lot::{Mutex, MutexGuard};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// SQLite 本地存储句柄。
///
/// 内部为单连接 + 互斥锁，所有仓储共享同一写连接；`Clone` 仅复制句柄。
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    /// 打开（或创建）指定路径的数据库，并创建父目录。
    pub fn open(path: &Path) -> DomainResult<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(DomainError::from)?;
            }
        }
        let conn = Connection::open(path).map_err(map_sql_error)?;
        configure(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// 打开内存数据库（测试用）。内存库必须复用同一连接。
    pub fn open_in_memory() -> DomainResult<Self> {
        let conn = Connection::open_in_memory().map_err(map_sql_error)?;
        configure(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// 在持锁状态下访问连接。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> DomainResult<T>,
    ) -> DomainResult<T> {
        let mut guard = self.conn.lock();
        f(&mut guard)
    }

    /// 获取底层连接锁；调用方负责尽快释放。
    pub fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock()
    }
}

fn configure(conn: &Connection) -> DomainResult<()> {
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(map_sql_error)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\
         PRAGMA foreign_keys=ON;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA temp_store=MEMORY;",
    )
    .map_err(map_sql_error)?;
    Ok(())
}
