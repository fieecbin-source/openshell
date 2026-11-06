//! 监控采样调度引擎。

use crate::history::MetricHistoryManager;
use crate::parser::{parse_sample, PrevSampleState};
use openshell_core_domain::{now_ms, DomainError, DomainResult, ErrorCode, HostMetrics, SessionId};
use openshell_ssh::SshConnection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;

const DEFAULT_COMMAND: &str = r#"echo "===STAT==="; cat /proc/stat 2>/dev/null; echo "===MEM==="; cat /proc/meminfo 2>/dev/null; echo "===NET==="; cat /proc/net/dev 2>/dev/null; echo "===DF==="; df -kP 2>/dev/null; echo "===LOAD==="; cat /proc/loadavg 2>/dev/null || uptime; echo "===PS==="; ( ps -eo pid,user,pcpu,pmem,comm,args --sort=-pcpu 2>/dev/null || ps -eo pid,user,pcpu,pmem,comm,args 2>/dev/null || ps aux 2>/dev/null || ps -ef 2>/dev/null || ps 2>/dev/null ) | head -n 40; echo "===UPTIME==="; cat /proc/uptime 2>/dev/null"#;

/// 监控引擎。
#[derive(Clone)]
pub struct MonitorEngine {
    history: MetricHistoryManager,
    running_tasks: Arc<RwLock<HashMap<SessionId, JoinHandle<()>>>>,
    event_tx: broadcast::Sender<HostMetrics>,
    latest: Arc<RwLock<HashMap<SessionId, DomainResult<HostMetrics>>>>,
}

impl Default for MonitorEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl MonitorEngine {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(128);
        Self {
            history: MetricHistoryManager::new(),
            running_tasks: Arc::new(RwLock::new(HashMap::new())),
            event_tx: tx,
            latest: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn history(&self) -> &MetricHistoryManager {
        &self.history
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostMetrics> {
        self.event_tx.subscribe()
    }

    pub async fn get_latest(&self, session_id: &SessionId) -> DomainResult<Option<HostMetrics>> {
        self.latest
            .read()
            .await
            .get(session_id)
            .cloned()
            .transpose()
    }

    async fn record_sample(&self, session_id: SessionId, result: DomainResult<HostMetrics>) {
        let mut latest = self.latest.write().await;
        if let Ok(metrics) = &result {
            self.history.push(metrics.clone()).await;
            let _ = self.event_tx.send(metrics.clone());
        }
        latest.insert(session_id, result);
    }

    /// 开启对某 SSH 连接的周期性监控采集。
    pub async fn start_monitoring(
        &self,
        session_id: SessionId,
        conn: Arc<SshConnection>,
        interval_sec: u64,
    ) -> DomainResult<()> {
        let mut tasks = self.running_tasks.write().await;
        if tasks.contains_key(&session_id) {
            return Ok(()); // 已在采集中
        }

        self.latest.write().await.remove(&session_id);
        let engine = self.clone();
        let session_id_clone = session_id.clone();
        let interval_sec = interval_sec.clamp(1, 30);

        let handle = tokio::spawn(async move {
            let mut prev_state = PrevSampleState::default();
            let mut consecutive_failures = 0;
            let mut current_interval = interval_sec;

            loop {
                // 先采样再休眠：首屏（CPU / 进程面板）立即有数据，
                // 否则前端要等到第一个间隔（默认 3s）之后才能拿到快照。
                let result = match conn.open_exec(DEFAULT_COMMAND).await {
                    Ok(out) => parse_sample(
                        session_id_clone.clone(),
                        now_ms(),
                        &String::from_utf8_lossy(&out.stdout),
                        out.exit_code,
                        &mut prev_state,
                    ),
                    Err(error) => Err(error),
                };
                match &result {
                    Ok(_) => {
                        consecutive_failures = 0;
                        current_interval = interval_sec;
                    }
                    Err(error) => {
                        consecutive_failures += 1;
                        tracing::warn!(
                            session_id = %session_id_clone,
                            failures = consecutive_failures,
                            error = %error,
                            "monitor sampling failed"
                        );
                        if consecutive_failures >= 3 {
                            current_interval = 30;
                        }
                    }
                }
                engine.record_sample(session_id_clone.clone(), result).await;

                tokio::time::sleep(tokio::time::Duration::from_secs(current_interval)).await;
            }
        });

        tasks.insert(session_id, handle);
        Ok(())
    }

    /// 停止对某会话的监控。
    pub async fn stop_monitoring(&self, session_id: &SessionId) {
        let mut tasks = self.running_tasks.write().await;
        if let Some(handle) = tasks.remove(session_id) {
            handle.abort();
            let _ = handle.await;
        }
        self.latest.write().await.remove(session_id);
    }

    /// 结束远端进程（SIGTERM 15 或 SIGKILL 9，对齐 MON-006）。
    pub async fn kill_process(
        &self,
        conn: &SshConnection,
        pid: u32,
        signal: u32,
    ) -> DomainResult<()> {
        let sig = if signal == 9 { 9 } else { 15 };
        let cmd = format!("kill -{} {}", sig, pid);
        let res = conn.open_exec(&cmd).await?;
        if let Some(code) = res.exit_code {
            if code != 0 {
                let err_msg = String::from_utf8_lossy(&res.stderr);
                return Err(DomainError::new(
                    ErrorCode::Permission,
                    format!("failed to kill process {}: {}", pid, err_msg.trim()),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::tests::VALID_SAMPLE;

    #[tokio::test]
    async fn stop_waits_for_the_old_sampler_to_release() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct ReleaseGuard(Arc<AtomicBool>);
        impl Drop for ReleaseGuard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let engine = MonitorEngine::new();
        let session = SessionId::new();
        let released = Arc::new(AtomicBool::new(false));
        let flag = released.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = ReleaseGuard(flag);
            ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready_rx.await.unwrap();
        engine
            .running_tasks
            .write()
            .await
            .insert(session.clone(), task);
        engine.stop_monitoring(&session).await;
        assert!(
            released.load(Ordering::SeqCst),
            "stop returned while the old sampler was alive"
        );
        assert!(engine.get_latest(&session).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn latest_distinguishes_no_sample_failure_history_and_recovery() {
        let engine = MonitorEngine::new();
        let session = SessionId::new();
        let mut events = engine.subscribe();
        assert!(engine.get_latest(&session).await.unwrap().is_none());
        engine
            .record_sample(
                session.clone(),
                Err(DomainError::new(ErrorCode::Network, "sample failed")),
            )
            .await;
        assert_eq!(
            engine.get_latest(&session).await.unwrap_err().code,
            ErrorCode::Network
        );
        assert!(engine.history().get_latest(&session).await.is_none());
        assert!(events.try_recv().is_err());

        let mut previous = PrevSampleState::default();
        let first =
            parse_sample(session.clone(), 100, VALID_SAMPLE, Some(0), &mut previous).unwrap();
        engine.record_sample(session.clone(), Ok(first)).await;
        assert_eq!(
            engine
                .get_latest(&session)
                .await
                .unwrap()
                .unwrap()
                .timestamp_ms,
            100
        );
        assert_eq!(events.try_recv().unwrap().timestamp_ms, 100);
        let failure = parse_sample(session.clone(), 200, "", Some(0), &mut previous);
        engine.record_sample(session.clone(), failure).await;
        assert!(engine.get_latest(&session).await.is_err());
        assert_eq!(
            engine
                .history()
                .get_latest(&session)
                .await
                .unwrap()
                .timestamp_ms,
            100
        );
        assert_eq!(previous.timestamp_ms, 100);
        assert!(events.try_recv().is_err());

        let recovered =
            parse_sample(session.clone(), 300, VALID_SAMPLE, Some(0), &mut previous).unwrap();
        engine.record_sample(session.clone(), Ok(recovered)).await;
        assert_eq!(
            engine
                .get_latest(&session)
                .await
                .unwrap()
                .unwrap()
                .timestamp_ms,
            300
        );
        assert_eq!(events.try_recv().unwrap().timestamp_ms, 300);
        engine.stop_monitoring(&session).await;
        assert!(engine.get_latest(&session).await.unwrap().is_none());
        assert_eq!(
            engine
                .history()
                .get_latest(&session)
                .await
                .unwrap()
                .timestamp_ms,
            300
        );
    }
}
