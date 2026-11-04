use crate::config::Config;
use crate::db::DbPool;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_LOCK_BASE_SECS: u64 = 30;
const LOGIN_LOCK_MAX_SECS: u64 = 900;
const LOGIN_ATTEMPT_TTL_SECS: u64 = 3600;
const LOGIN_ATTEMPT_MAX_ENTRIES: usize = 8192;

#[derive(Debug, Clone, Copy)]
struct LoginAttempt {
    failures: u32,
    locked_until: Option<Instant>,
    last_failure: Instant,
}

/// 登录失败计数与锁定（账号 + 客户端 IP）。
///
/// 进程内状态：重启后清零，但攻击者仍无法在单个进程生命周期内无限试错。
#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<HashMap<String, LoginAttempt>>,
    total_failures: AtomicU64,
}

impl LoginLimiter {
    /// 返回剩余锁定时间；有值表示当前应拒绝登录。
    pub fn lock_remaining(&self, key: &str) -> Option<Duration> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock();
        if attempts.len() >= LOGIN_ATTEMPT_MAX_ENTRIES {
            attempts.retain(|_, entry| {
                now.saturating_duration_since(entry.last_failure)
                    < Duration::from_secs(LOGIN_ATTEMPT_TTL_SECS)
            });
            // 饱和时拒绝新键，不能驱逐仍被锁定的账号让攻击者绕过限流。
            if attempts.len() >= LOGIN_ATTEMPT_MAX_ENTRIES && !attempts.contains_key(key) {
                return Some(Duration::from_secs(LOGIN_LOCK_BASE_SECS));
            }
        }
        if attempts.get(key).is_some_and(|entry| {
            now.saturating_duration_since(entry.last_failure)
                >= Duration::from_secs(LOGIN_ATTEMPT_TTL_SECS)
        }) {
            attempts.remove(key);
        }
        if let Some(entry) = attempts.get_mut(key) {
            if let Some(until) = entry.locked_until {
                if until > now {
                    return Some(until - now);
                }
                entry.locked_until = None;
            }
        }
        None
    }

    pub fn record_failure(&self, key: &str) {
        let now = Instant::now();
        let mut attempts = self.attempts.lock();

        if attempts.len() >= LOGIN_ATTEMPT_MAX_ENTRIES {
            attempts.retain(|_, entry| {
                now.saturating_duration_since(entry.last_failure)
                    < Duration::from_secs(LOGIN_ATTEMPT_TTL_SECS)
            });
            if attempts.len() >= LOGIN_ATTEMPT_MAX_ENTRIES && !attempts.contains_key(key) {
                self.total_failures.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }

        let entry = attempts.entry(key.to_string()).or_insert(LoginAttempt {
            failures: 0,
            locked_until: None,
            last_failure: now,
        });

        entry.failures = entry.failures.saturating_add(1);
        entry.last_failure = now;

        if entry.failures >= LOGIN_MAX_FAILURES {
            let exponent = (entry.failures - LOGIN_MAX_FAILURES).min(5);
            let secs = LOGIN_LOCK_BASE_SECS
                .saturating_mul(1u64 << exponent)
                .min(LOGIN_LOCK_MAX_SECS);
            entry.locked_until = Some(now + Duration::from_secs(secs));
        }

        self.total_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn clear(&self, key: &str) {
        self.attempts.lock().remove(key);
    }

    pub fn total_failures(&self) -> u64 {
        self.total_failures.load(Ordering::Relaxed)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub config: Config,
    pub start_time: Instant,
    pub login_limiter: Arc<LoginLimiter>,
}

impl AppState {
    pub fn new(db: DbPool, config: Config) -> Self {
        Self {
            db,
            config,
            start_time: Instant::now(),
            login_limiter: Arc::new(LoginLimiter::default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_stays_bounded_and_preserves_existing_locks() {
        let limiter = LoginLimiter::default();
        for _ in 0..LOGIN_MAX_FAILURES {
            limiter.record_failure("locked");
        }
        for index in 0..LOGIN_ATTEMPT_MAX_ENTRIES {
            limiter.record_failure(&index.to_string());
        }
        assert_eq!(limiter.attempts.lock().len(), LOGIN_ATTEMPT_MAX_ENTRIES);
        assert!(limiter.lock_remaining("locked").is_some());
        assert!(limiter.lock_remaining("new-user").is_some());
        limiter.attempts.lock().get_mut("0").unwrap().last_failure =
            Instant::now() - Duration::from_secs(LOGIN_ATTEMPT_TTL_SECS + 1);
        assert!(limiter.lock_remaining("new-user").is_none());
    }

    #[test]
    fn expired_lock_keeps_backoff_until_attempts_expire() {
        let limiter = LoginLimiter::default();
        for _ in 0..LOGIN_MAX_FAILURES {
            limiter.record_failure("user");
        }
        limiter
            .attempts
            .lock()
            .get_mut("user")
            .unwrap()
            .locked_until = Some(Instant::now());
        assert!(limiter.lock_remaining("user").is_none());
        limiter.record_failure("user");
        assert!(limiter.lock_remaining("user").unwrap() > Duration::from_secs(50));
        limiter
            .attempts
            .lock()
            .get_mut("user")
            .unwrap()
            .last_failure = Instant::now() - Duration::from_secs(LOGIN_ATTEMPT_TTL_SECS + 1);
        assert!(limiter.lock_remaining("user").is_none());
    }
}
