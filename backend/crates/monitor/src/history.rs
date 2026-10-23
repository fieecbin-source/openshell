//! 监控指标历史环形缓冲区。

use openshell_core_domain::{HostMetrics, SessionId};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::RwLock;

const MAX_HISTORY_POINTS: usize = 600;

#[derive(Clone, Default)]
pub struct MetricHistoryManager {
    histories: Arc<RwLock<HashMap<SessionId, VecDeque<HostMetrics>>>>,
}

impl MetricHistoryManager {
    pub fn new() -> Self {
        Self {
            histories: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 记录一次采样数据。
    pub async fn push(&self, metrics: HostMetrics) {
        let mut map = self.histories.write().await;
        let deque = map
            .entry(metrics.session_id.clone())
            .or_insert_with(VecDeque::new);
        deque.push_back(metrics);
        if deque.len() > MAX_HISTORY_POINTS {
            deque.pop_front();
        }
    }

    /// 获取最近一次采样数据。
    pub async fn get_latest(&self, session_id: &SessionId) -> Option<HostMetrics> {
        let map = self.histories.read().await;
        map.get(session_id).and_then(|d| d.back().cloned())
    }

    /// 获取某时间范围内的历史点列表。
    /// `window_sec`: 如 300（5 分钟）或 3600（1 小时）。
    pub async fn get_history(&self, session_id: &SessionId, window_sec: u64) -> Vec<HostMetrics> {
        let map = self.histories.read().await;
        if let Some(deque) = map.get(session_id) {
            let cutoff = openshell_core_domain::now_ms() - (window_sec as i64 * 1000);
            deque
                .iter()
                .filter(|m| m.timestamp_ms >= cutoff)
                .cloned()
                .collect()
        } else {
            Vec::new()
        }
    }

    /// 清空某会话的历史记录。
    pub async fn clear(&self, session_id: &SessionId) {
        let mut map = self.histories.write().await;
        map.remove(session_id);
    }
}
