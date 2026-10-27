//! 下载与安装的互斥/幂等门闩。
//!
//! 这里的逻辑刻意不依赖 Tauri：IPC 层只负责把命令参数转成调用，
//! 真正的「同一时刻只跑一个任务」「重复点击不重复安装」「安装完是否退出」
//! 全部放在这里，从而可以在任何平台上离线单测。

use crate::error::{UpdaterError, UpdaterErrorKind};
use crate::install::InstallOutcome;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 单飞（single-flight）门闩：同一时刻只允许一个任务持有令牌。
///
/// 语义：
/// * `start()` 会**取消并取代**仍在进行的上一个任务（下载场景：新任务应覆盖旧的 `.part`）；
/// * `finish(token)` 只释放自己的令牌 —— 旧任务的收尾不会误清新任务（stale token 保护）；
/// * `cancel()` 只置位令牌，是否真正停止由执行方轮询决定。
#[derive(Default)]
pub struct SingleFlight {
    current: Mutex<Option<Arc<AtomicBool>>>,
}

impl SingleFlight {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// 开始新任务并拿到自己的取消令牌；若已有任务在跑，先把它标记为取消。
    pub fn start(&self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        let mut guard = self.lock();
        if let Some(previous) = guard.replace(token.clone()) {
            previous.store(true, Ordering::SeqCst);
        }
        token
    }

    /// 取消当前任务；返回是否确实存在一个任务。
    pub fn cancel(&self) -> bool {
        match self.lock().as_ref() {
            Some(token) => {
                token.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// 任务收尾：仅当令牌仍是「当前令牌」时才清除。
    ///
    /// 返回 `true` 表示确实由本次调用清除了当前令牌；`false` 说明令牌已过期
    /// （期间被新的 `start()` 取代），此时绝不能动新任务的状态。
    pub fn finish(&self, token: &Arc<AtomicBool>) -> bool {
        let mut guard = self.lock();
        let is_current = guard
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, token));
        if is_current {
            guard.take();
        }
        is_current
    }

    /// 当前是否存在未被取消的任务。
    pub fn is_running(&self) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|token| !token.load(Ordering::SeqCst))
    }

    /// 当前令牌（测试与诊断用）。
    pub fn current_token(&self) -> Option<Arc<AtomicBool>> {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<AtomicBool>>> {
        // 令牌操作不会在持锁期间 panic，中毒时按空状态继续，避免把更新功能整体拖死
        self.current.lock().unwrap_or_else(|err| err.into_inner())
    }
}

/// 安装闸门：防止并发或重复安装（用户连点两次「立即安装」）。
///
/// 持锁期间再次进入会得到 [`UpdaterErrorKind::Install`] 错误；
/// 释放 [`InstallPermit`] 即解锁（异常路径同样生效，不会把应用锁死）。
#[derive(Debug, Default)]
pub struct InstallGate {
    busy: AtomicBool,
}

impl InstallGate {
    pub fn new() -> Self {
        Self {
            busy: AtomicBool::new(false),
        }
    }

    /// 进入安装临界区。已在安装中则返回错误。
    pub fn try_enter(&self) -> Result<InstallPermit<'_>, UpdaterError> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(UpdaterError::new(
                UpdaterErrorKind::Install,
                "an installation is already in progress",
            )
            .with_retryable(false));
        }
        Ok(InstallPermit { gate: self })
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// 安装临界区凭证，`Drop` 时自动释放。
#[derive(Debug)]
pub struct InstallPermit<'a> {
    gate: &'a InstallGate,
}

impl Drop for InstallPermit<'_> {
    fn drop(&mut self) {
        self.gate.busy.store(false, Ordering::SeqCst);
    }
}

/// 安装结束后应用该怎么收尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// 安装器已拉起：延迟一段时间（把 IPC 结果送回前端）后退出进程。
    ExitApp { delay_ms: u64 },
    /// 没有拉起安装器（需要用户手动完成）：保持运行。
    StayOpen,
}

impl ExitDecision {
    /// 退出前的延迟：足够前端渲染「正在安装」并收到返回值。
    pub const EXIT_DELAY_MS: u64 = 800;

    pub fn for_outcome(outcome: &InstallOutcome) -> Self {
        if outcome.launched {
            Self::ExitApp {
                delay_ms: Self::EXIT_DELAY_MS,
            }
        } else {
            Self::StayOpen
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::StrategyKind;

    fn outcome(launched: bool) -> InstallOutcome {
        InstallOutcome {
            strategy: StrategyKind::SelfInstall,
            launched,
            manual_hint: None,
            backup_path: None,
        }
    }

    #[test]
    fn starting_again_cancels_the_previous_flight() {
        let flight = SingleFlight::new();
        let first = flight.start();
        assert!(!first.load(Ordering::SeqCst));
        assert!(flight.is_running());

        let second = flight.start();
        // 旧令牌被置位取消，新令牌不受影响
        assert!(
            first.load(Ordering::SeqCst),
            "previous flight must be cancelled"
        );
        assert!(!second.load(Ordering::SeqCst));
        assert!(flight.is_running());
    }

    #[test]
    fn stale_token_does_not_clear_the_new_flight() {
        let flight = SingleFlight::new();
        let stale = flight.start();
        let current = flight.start();

        // 旧任务收尾：不能把新任务的令牌清掉
        assert!(!flight.finish(&stale));
        assert!(flight.is_running());
        assert!(flight.current_token().is_some());

        // 新任务收尾：正常清除
        assert!(flight.finish(&current));
        assert!(!flight.is_running());
        assert!(flight.current_token().is_none());
    }

    #[test]
    fn cancel_reports_whether_something_was_running() {
        let flight = SingleFlight::new();
        assert!(
            !flight.cancel(),
            "idle flight must report nothing to cancel"
        );

        let token = flight.start();
        assert!(flight.cancel());
        assert!(token.load(Ordering::SeqCst));
        assert!(
            !flight.is_running(),
            "cancelled flight is no longer running"
        );

        // 取消后仍可重新开始（取消不应把门闩焊死）
        let next = flight.start();
        assert!(!next.load(Ordering::SeqCst));
        assert!(flight.is_running());
    }

    #[test]
    fn finishing_twice_is_harmless() {
        let flight = SingleFlight::new();
        let token = flight.start();
        assert!(flight.finish(&token));
        assert!(!flight.finish(&token));
        assert!(!flight.is_running());
    }

    #[test]
    fn install_gate_rejects_concurrent_install_and_recovers() {
        let gate = InstallGate::new();
        let permit = gate.try_enter().expect("first enter");
        assert!(gate.is_busy());

        let err = gate.try_enter().expect_err("second enter must fail");
        assert_eq!(err.kind, UpdaterErrorKind::Install);
        assert!(!err.retryable);

        drop(permit);
        assert!(!gate.is_busy());
        let _again = gate.try_enter().expect("recover after release");
    }

    #[test]
    fn exit_decision_follows_launch_result() {
        assert_eq!(
            ExitDecision::for_outcome(&outcome(true)),
            ExitDecision::ExitApp {
                delay_ms: ExitDecision::EXIT_DELAY_MS
            }
        );
        assert_eq!(
            ExitDecision::for_outcome(&outcome(false)),
            ExitDecision::StayOpen
        );
    }
}
