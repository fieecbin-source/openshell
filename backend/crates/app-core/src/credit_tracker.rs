//! 终端信用窗口流控与背压追踪器。
//!
//! 规格与架构要求（§6.5、§7.1、TERM-020）：
//! - 初始授予信用 256 KiB。
//! - 前端在 xterm 消费后调用 terminal_ack。
//! - 未确认未发字节数 > 512 KiB 时暂停读取通道（正常背压不丢字节）。
//! - 待发送字节 > 8 MiB 且持续 > 5 秒时，按最旧数据丢弃至 4 MiB，并发出 flow 截断通知。

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const INITIAL_CREDIT: i64 = 256 * 1024; // 256 KiB
pub const PAUSE_THRESHOLD: i64 = 512 * 1024; // 512 KiB
pub const RESUME_THRESHOLD: i64 = 256 * 1024; // 256 KiB
pub const HARD_DROP_THRESHOLD: i64 = 8 * 1024 * 1024; // 8 MiB
pub const DROP_TARGET: i64 = 4 * 1024 * 1024; // 4 MiB
pub const SUSTAINED_DURATION: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowAction {
    Normal,
    Paused,
    Resumed,
    DropOldest(u64),
}

pub struct CreditTracker {
    credit: AtomicI64,
    unacked_bytes: AtomicI64,
    is_paused: AtomicBool,
    notify: Arc<Notify>,
    high_watermark_start: Mutex<Option<Instant>>,
}

impl Default for CreditTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl CreditTracker {
    pub fn new() -> Self {
        Self {
            credit: AtomicI64::new(INITIAL_CREDIT),
            unacked_bytes: AtomicI64::new(0),
            is_paused: AtomicBool::new(false),
            notify: Arc::new(Notify::new()),
            high_watermark_start: Mutex::new(None),
        }
    }

    pub fn credit(&self) -> i64 {
        self.credit.load(Ordering::SeqCst)
    }

    pub fn unacked_bytes(&self) -> i64 {
        self.unacked_bytes.load(Ordering::SeqCst)
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    /// 等待直到信用窗口恢复（非暂停态）。
    ///
    /// 用短超时轮询兜底：`notify_waiters()` 不会留存许可，
    /// 若恢复信号恰好发生在「读到 is_paused == true」与「await notified()」之间，
    /// 单纯 await 会永久挂起，终端从此不再刷新。
    pub async fn wait_for_resume(&self) {
        while self.is_paused.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(Duration::from_millis(50), self.notify.notified()).await;
        }
    }

    /// 发送数据时记录已发字节并检查流控。
    pub fn on_send(&self, bytes: usize) -> FlowAction {
        let b = bytes as i64;
        self.credit.fetch_sub(b, Ordering::SeqCst);
        let unacked = self.unacked_bytes.fetch_add(b, Ordering::SeqCst) + b;

        // 检查硬上限 > 8 MiB
        if unacked > HARD_DROP_THRESHOLD {
            let mut hw = self.high_watermark_start.lock();
            let now = Instant::now();
            if let Some(start) = *hw {
                if now.duration_since(start) >= SUSTAINED_DURATION {
                    let to_drop = unacked - DROP_TARGET;
                    if to_drop > 0 {
                        self.unacked_bytes.fetch_sub(to_drop, Ordering::SeqCst);
                        *hw = Some(now);
                        return FlowAction::DropOldest(to_drop as u64);
                    }
                }
            } else {
                *hw = Some(now);
            }
        } else {
            let mut hw = self.high_watermark_start.lock();
            *hw = None;
        }

        // 检查是否超过 512 KiB 暂停阈值
        if unacked > PAUSE_THRESHOLD && !self.is_paused.swap(true, Ordering::SeqCst) {
            FlowAction::Paused
        } else {
            FlowAction::Normal
        }
    }

    /// 前端消费后确认已收字节数。
    pub fn on_ack(&self, bytes: usize) -> FlowAction {
        let b = bytes as i64;
        self.credit.fetch_add(b, Ordering::SeqCst);

        // 原子地扣减未确认字节：旧实现是 load + store，两个并发 ack 会互相覆盖，
        // 未确认字节被少扣，信用窗口越用越大，背压最终失效（大输出时内存暴涨）。
        // 这里用 compare_exchange 循环而非 fetch_update/try_update，
        // 既保证 MSRV 1.80 兼容，也避免新版 Rust 的弃用警告。
        let mut current = self.unacked_bytes.load(Ordering::SeqCst);
        let new_unacked = loop {
            let next = (current - b).max(0);
            match self.unacked_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break next,
                Err(actual) => current = actual,
            }
        };

        // 如果低于恢复阈值且当前处于暂停状态，恢复读取
        if new_unacked <= RESUME_THRESHOLD && self.is_paused.swap(false, Ordering::SeqCst) {
            self.notify.notify_waiters();
            FlowAction::Resumed
        } else {
            FlowAction::Normal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credit_tracker_pause_and_resume() {
        let tracker = CreditTracker::new();
        assert_eq!(tracker.credit(), INITIAL_CREDIT);
        assert_eq!(tracker.unacked_bytes(), 0);
        assert!(!tracker.is_paused());

        // 发送 500 KiB：正常
        let action = tracker.on_send(500 * 1024);
        assert_eq!(action, FlowAction::Normal);
        assert!(!tracker.is_paused());

        // 再发送 20 KiB（总计 520 KiB > 512 KiB）：触发暂停
        let action = tracker.on_send(20 * 1024);
        assert_eq!(action, FlowAction::Paused);
        assert!(tracker.is_paused());

        // 确认 300 KiB（剩余 220 KiB <= 256 KiB）：触发恢复
        let action = tracker.on_ack(300 * 1024);
        assert_eq!(action, FlowAction::Resumed);
        assert!(!tracker.is_paused());
    }
}
