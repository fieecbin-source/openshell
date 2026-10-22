use crate::config::Config;
use crate::db::DbPool;
use std::time::Instant;

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub config: Config,
    pub start_time: Instant,
}

impl AppState {
    pub fn new(db: DbPool, config: Config) -> Self {
        Self {
            db,
            config,
            start_time: Instant::now(),
        }
    }
}
