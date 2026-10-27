//! 监控采样调度引擎。

use crate::history::MetricHistoryManager;
use crate::parser::{parse_host_metrics, PrevSampleState};
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
        }
    }

    pub fn history(&self) -> &MetricHistoryManager {
        &self.history
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostMetrics> {
        self.event_tx.subscribe()
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

        let history_clone = self.history.clone();
        let event_tx_clone = self.event_tx.clone();
        let session_id_clone = session_id.clone();
        let interval_sec = interval_sec.clamp(1, 30);

        let handle = tokio::spawn(async move {
            let mut prev_state = PrevSampleState::default();
            let mut consecutive_failures = 0;
            let mut current_interval = interval_sec;

            loop {
                // 先采样再休眠：首屏（CPU / 进程面板）立即有数据，
                // 否则前端要等到第一个间隔（默认 3s）之后才能拿到快照。
                let output = conn.open_exec(DEFAULT_COMMAND).await;
                match output {
                    Ok(out) => {
                        consecutive_failures = 0;
                        current_interval = interval_sec; // 恢复设定周期

                        let raw_str = String::from_utf8_lossy(&out.stdout);
                        let now = now_ms();
                        let metrics = parse_host_metrics(
                            session_id_clone.clone(),
                            now,
                            &raw_str,
                            &mut prev_state,
                        );

                        history_clone.push(metrics.clone()).await;
                        let _ = event_tx_clone.send(metrics);
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        tracing::warn!(
                            session_id = %session_id_clone,
                            failures = consecutive_failures,
                            error = %e,
                            "monitor sampling exec failed"
                        );
                        // 连续 3 次失败退避到 30 秒（对齐 MON-003）
                        if consecutive_failures >= 3 {
                            current_interval = 30;
                        }
                    }
                }

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
        }
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
