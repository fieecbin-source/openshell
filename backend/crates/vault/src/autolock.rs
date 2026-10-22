//! 自动锁定策略（纯函数，暂不接系统事件）。

use serde::{Deserialize, Serialize};

/// 自动锁定配置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoLockPolicy {
    /// 空闲分钟数；0 表示不按空闲锁定。
    pub idle_minutes: u32,
    /// 系统休眠/锁屏时是否立即锁定。
    pub lock_on_suspend: bool,
}

impl Default for AutoLockPolicy {
    fn default() -> Self {
        Self {
            idle_minutes: 15,
            lock_on_suspend: true,
        }
    }
}

impl AutoLockPolicy {
    /// 根据最后活动时间判断是否应锁定。
    pub fn should_lock(&self, last_activity_ms: i64, now_ms: i64) -> bool {
        if self.idle_minutes == 0 {
            return false;
        }
        let idle_ms = now_ms.saturating_sub(last_activity_ms);
        idle_ms >= i64::from(self.idle_minutes) * 60_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_locks_after_15_minutes() {
        let policy = AutoLockPolicy::default();
        assert!(!policy.should_lock(0, 15 * 60_000 - 1));
        assert!(policy.should_lock(0, 15 * 60_000));
        assert!(policy.should_lock(1_000, 1_000 + 16 * 60_000));
    }

    #[test]
    fn zero_idle_never_locks() {
        let policy = AutoLockPolicy {
            idle_minutes: 0,
            lock_on_suspend: false,
        };
        assert!(!policy.should_lock(0, i64::MAX));
    }
}
