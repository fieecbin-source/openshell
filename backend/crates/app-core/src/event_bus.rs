use openshell_core_domain::AppEvent;
use tokio::sync::broadcast;

pub struct EventBus {
    sender: broadcast::Sender<AppEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn emit(&self, event: AppEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

/// 把事件总线里的事件转发给外部消费者（桌面端即 Tauri 前端窗口）。
///
/// 关键点：`broadcast` 在消费端落后时会返回 `Lagged`，它**不是**终止条件——
/// 只丢弃已经丢失的旧事件并继续消费即可，否则一次卡顿（例如批量终端输出）
/// 之后所有连接状态与终端通知都会永久到不了前端，界面会停留在「已连接」的假状态。
/// 只有通道真正关闭（`Closed`）才退出循环。
///
/// 返回值是累计因落后而丢弃的事件数，便于调用方记录指标。
pub async fn forward_events<F, Fut>(mut rx: broadcast::Receiver<AppEvent>, mut emit: F) -> u64
where
    F: FnMut(AppEvent) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut lagged_total: u64 = 0;
    loop {
        match rx.recv().await {
            Ok(event) => emit(event).await,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                lagged_total = lagged_total.saturating_add(skipped);
                tracing::warn!(
                    skipped,
                    lagged_total,
                    "event forwarder lagged behind, dropped stale events but kept forwarding"
                );
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    lagged_total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn toast(msg: &str) -> AppEvent {
        AppEvent::Toast {
            level: "info".to_string(),
            message: msg.to_string(),
        }
    }

    /// 回归用例：消费端落后（Lagged）之后，转发循环必须继续工作。
    ///
    /// 历史实现用 `while let Ok(event) = rx.recv().await`，第一次 Lagged 就直接结束循环，
    /// 导致此后 ConnectionState / TerminalNotice 全部丢失。
    #[tokio::test]
    async fn forwarder_keeps_working_after_lag() {
        // 容量刻意设小，便于制造落后
        let bus = EventBus::new(4);
        let rx = bus.subscribe();

        // 在没有任何消费者时灌入远超容量的事件，使下一次 recv 必然返回 Lagged
        for i in 0..64 {
            bus.emit(toast(&format!("burst-{i}")));
        }

        let (tx, mut out) = tokio::sync::mpsc::unbounded_channel();
        let forwarder = tokio::spawn(forward_events(rx, move |event| {
            let tx = tx.clone();
            async move {
                let _ = tx.send(event);
            }
        }));

        bus.emit(toast("after-lag"));

        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut saw_marker = false;
        while !saw_marker {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, out.recv()).await {
                Ok(Some(AppEvent::Toast { message, .. })) if message == "after-lag" => {
                    saw_marker = true;
                }
                Ok(Some(_)) => continue,
                Ok(None) => panic!("forwarder stopped delivering events"),
                Err(_) => panic!("event emitted after lag was never forwarded"),
            }
        }

        forwarder.abort();
    }
}
