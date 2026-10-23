//! 操作注册表：以 request_id 注册与协同取消异步操作。

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

/// 协同式取消令牌。
#[derive(Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// 触发取消。
    pub fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::SeqCst) {
            self.notify.notify_waiters();
        }
    }

    /// 是否已被取消。
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// 异步等待取消信号。
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

/// 全局操作注册表。
pub struct OpRegistry {
    tokens: RwLock<HashMap<String, CancellationToken>>,
}

impl Default for OpRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl OpRegistry {
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(HashMap::new()),
        }
    }

    /// 为指定 `request_id` 注册取消令牌；若已存在则直接返回旧令牌。
    pub fn register(&self, request_id: &str) -> CancellationToken {
        let mut tokens = self.tokens.write();
        tokens.entry(request_id.to_string()).or_default().clone()
    }

    /// 触发指定 `request_id` 的取消信号。
    pub fn cancel(&self, request_id: &str) -> bool {
        if let Some(token) = self.tokens.read().get(request_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// 移除已完成的操作令牌。
    pub fn remove(&self, request_id: &str) {
        self.tokens.write().remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_op_registry_cancellation() {
        let registry = OpRegistry::new();
        let token = registry.register("req_001");
        assert!(!token.is_cancelled());

        let token_clone = token.clone();
        let task = tokio::spawn(async move {
            token_clone.cancelled().await;
            true
        });

        assert!(registry.cancel("req_001"));
        assert!(token.is_cancelled());
        let res = task.await.unwrap();
        assert!(res);

        registry.remove("req_001");
        assert!(!registry.cancel("req_001"));
    }
}
