//! 端口转发运行时管理器。

use crate::socks5::handle_socks5_handshake;
use openshell_core_domain::{
    DomainError, DomainResult, ErrorCode, PortForwardId, PortForwardRule, PortForwardType,
    SocksAuth,
};
use openshell_ssh::SshConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "details")]
pub enum ForwardStatus {
    Stopped,
    Listening { bound_addr: String },
    Error(String),
}

struct RunningForward {
    #[allow(dead_code)]
    rule: PortForwardRule,
    /// 监听任务可能在运行期间失败（监听 socket 被系统回收、句柄耗尽等），
    /// 因此状态必须与任务共享，而不是只在启动成功时写一次。
    status: Arc<StdMutex<ForwardStatus>>,
    handle: JoinHandle<()>,
}

fn lock_status(status: &StdMutex<ForwardStatus>) -> std::sync::MutexGuard<'_, ForwardStatus> {
    // 状态只是简单枚举，中毒后取回内部值继续使用是安全的
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_status(status: &StdMutex<ForwardStatus>, value: ForwardStatus) {
    *lock_status(status) = value;
}

/// 判断监听地址是否仅限本机回环。
fn is_loopback_bind(host: &str) -> bool {
    let host = host.trim();
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// 启动前的静态校验（不依赖真实连接，便于单测）。
///
/// 返回动态转发需要使用的 SOCKS5 口令（未启用认证时为 `None`）。
fn validate_rule(rule: &PortForwardRule) -> DomainResult<Option<String>> {
    // 远端反向转发（-R）目前没有真实实现。旧代码只打一条 info 日志就返回成功，
    // 前端会一直显示「监听中」，属于会误导用户的假功能——这里改为明确报错。
    if matches!(rule.rule_type, PortForwardType::Remote) {
        return Err(DomainError::new(
            ErrorCode::ForwardBind,
            "远端反向端口转发（Remote / -R）尚未实现，请改用本地转发（Local）或动态 SOCKS5 代理（Dynamic）",
        ));
    }

    // 监听非回环地址会把内网服务暴露给局域网/公网，必须由用户显式确认风险。
    if !is_loopback_bind(&rule.bind_host) && !rule.expose_warning_ack {
        return Err(DomainError::new(
            ErrorCode::ForwardBind,
            format!(
                "监听地址 {} 会向本机以外的网络暴露该端口，请先确认安全风险后再启动",
                rule.bind_host
            ),
        ));
    }

    // SOCKS5 用户名口令认证：缺少口令时必须拒绝启动。
    //
    // 历史实现把期望口令写死为 `None`，而握手侧在缺少期望口令时一律放行，
    // 等于「配置了认证但任何凭据都能通过」；若同时监听 0.0.0.0 就是开放代理。
    if matches!(rule.rule_type, PortForwardType::Dynamic)
        && matches!(rule.socks_auth, SocksAuth::Userpass)
    {
        let user = rule.socks_username.as_deref().unwrap_or("").trim();
        let pass = rule.socks_password_ref.as_deref().unwrap_or("").trim();
        if user.is_empty() || pass.is_empty() {
            return Err(DomainError::new(
                ErrorCode::ForwardBind,
                "动态转发已选择「用户名口令」认证，但用户名或口令为空；请补全后再启动（不会在缺少口令时以无认证模式运行）",
            ));
        }
        return Ok(Some(pass.to_string()));
    }

    Ok(None)
}

#[derive(Clone, Default)]
pub struct ForwardManager {
    running: Arc<RwLock<HashMap<PortForwardId, RunningForward>>>,
}

impl ForwardManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 获取某规则的运行状态。
    pub async fn get_status(&self, id: &PortForwardId) -> ForwardStatus {
        let running = self.running.read().await;
        match running.get(id) {
            Some(r) => lock_status(&r.status).clone(),
            None => ForwardStatus::Stopped,
        }
    }

    /// 列出所有活跃规则状态映射。
    pub async fn list_statuses(&self) -> HashMap<PortForwardId, ForwardStatus> {
        let running = self.running.read().await;
        running
            .iter()
            .map(|(id, r)| (id.clone(), lock_status(&r.status).clone()))
            .collect()
    }

    /// 启动转发规则。
    pub async fn start_rule(
        &self,
        rule: PortForwardRule,
        conn: Arc<SshConnection>,
    ) -> DomainResult<()> {
        let id = rule.id.clone();
        self.stop_rule(&id).await;

        let socks_password = validate_rule(&rule)?;

        let bind_addr = format!("{}:{}", rule.bind_host, rule.bind_port);
        let listener = TcpListener::bind(&bind_addr).await.map_err(|e| {
            DomainError::new(
                ErrorCode::ForwardBind,
                format!("failed to bind {}: {}", bind_addr, e),
            )
        })?;

        let actual_addr = listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| bind_addr.clone());

        let status = Arc::new(StdMutex::new(ForwardStatus::Listening {
            bound_addr: actual_addr,
        }));

        let rule_clone = rule.clone();
        let status_for_task = Arc::clone(&status);
        let id_for_log = id.to_string();
        let bind_for_log = bind_addr.clone();
        let handle = tokio::spawn(async move {
            // 监听循环一旦出错就写回 Error 状态，避免前端一直显示「监听中」。
            let result: Result<(), String> = async move {
                match rule_clone.rule_type {
                    PortForwardType::Local => {
                        let dest_host = rule_clone.dest_host.unwrap_or_default();
                        let dest_port = rule_clone.dest_port.unwrap_or(80);
                        loop {
                            let (mut local_stream, _peer) = listener
                                .accept()
                                .await
                                .map_err(|e| format!("accept on {bind_for_log} failed: {e}"))?;
                            let conn_clone = Arc::clone(&conn);
                            let d_host = dest_host.clone();
                            tokio::spawn(async move {
                                match conn_clone.open_direct_tcpip(&d_host, dest_port).await {
                                    Ok(mut ssh_stream) => {
                                        let _ = tokio::io::copy_bidirectional(
                                            &mut local_stream,
                                            &mut ssh_stream,
                                        )
                                        .await;
                                    }
                                    Err(err) => {
                                        tracing::warn!(
                                            dest = %d_host,
                                            port = dest_port,
                                            error = %err,
                                            "port forward: open remote channel failed"
                                        );
                                    }
                                }
                            });
                        }
                    }
                    PortForwardType::Dynamic => {
                        let auth_mode = rule_clone.socks_auth;
                        let username = rule_clone.socks_username.clone();
                        let password = socks_password.clone();
                        loop {
                            let (mut local_stream, _peer) = listener
                                .accept()
                                .await
                                .map_err(|e| format!("accept on {bind_for_log} failed: {e}"))?;
                            let conn_clone = Arc::clone(&conn);
                            let u_opt = username.clone();
                            let p_opt = password.clone();
                            tokio::spawn(async move {
                                let handshake_res = handle_socks5_handshake(
                                    &mut local_stream,
                                    auth_mode,
                                    u_opt.as_deref(),
                                    p_opt.as_deref(),
                                )
                                .await;

                                let (target_host, target_port) = match handshake_res {
                                    Ok(v) => v,
                                    Err(err) => {
                                        tracing::debug!(error = %err, "socks5 handshake rejected");
                                        return;
                                    }
                                };

                                match conn_clone
                                    .open_direct_tcpip(&target_host, target_port)
                                    .await
                                {
                                    Ok(mut ssh_stream) => {
                                        let _ = tokio::io::copy_bidirectional(
                                            &mut local_stream,
                                            &mut ssh_stream,
                                        )
                                        .await;
                                    }
                                    Err(err) => {
                                        tracing::warn!(
                                            target = %target_host,
                                            port = target_port,
                                            error = %err,
                                            "socks5: open remote channel failed"
                                        );
                                    }
                                }
                            });
                        }
                    }
                    // 已在上面拦截，不会走到这里
                    PortForwardType::Remote => Ok(()),
                }
            }
            .await;

            if let Err(err) = result {
                tracing::error!(rule_id = %id_for_log, error = %err, "port forward listener stopped");
                set_status(&status_for_task, ForwardStatus::Error(err));
            }
        });

        let mut running = self.running.write().await;
        running.insert(
            id,
            RunningForward {
                rule,
                status,
                handle,
            },
        );

        Ok(())
    }

    /// 停止转发规则。
    pub async fn stop_rule(&self, id: &PortForwardId) {
        let mut running = self.running.write().await;
        if let Some(rf) = running.remove(id) {
            rf.handle.abort();
        }
    }

    /// 停止所有活跃转发规则。
    pub async fn stop_all(&self) {
        let mut running = self.running.write().await;
        for (_, rf) in running.drain() {
            rf.handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_bind("127.0.0.1"));
        assert!(is_loopback_bind("localhost"));
        assert!(is_loopback_bind("::1"));
        assert!(!is_loopback_bind("0.0.0.0"));
        assert!(!is_loopback_bind("192.168.1.10"));
        assert!(!is_loopback_bind(""));
    }

    fn rule(kind: PortForwardType) -> PortForwardRule {
        PortForwardRule {
            id: PortForwardId::new(),
            session_id: None,
            name: "test".to_string(),
            rule_type: kind,
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            dest_host: Some("127.0.0.1".to_string()),
            dest_port: Some(80),
            auto_start: false,
            auto_reconnect: false,
            reconnect_max: 3,
            socks_auth: SocksAuth::None,
            socks_username: None,
            socks_password_ref: None,
            expose_warning_ack: false,
            sort_order: 1024,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
            sync: openshell_core_domain::SyncMeta::default(),
        }
    }

    /// 未确认风险时禁止监听非回环地址（避免把内网端口暴露出去）。
    #[test]
    fn rejects_non_loopback_bind_without_ack() {
        let mut r = rule(PortForwardType::Local);
        r.bind_host = "0.0.0.0".to_string();
        let err = validate_rule(&r).unwrap_err();
        assert_eq!(err.code, ErrorCode::ForwardBind);
        assert!(err.message.contains("暴露"));

        // 用户显式确认后允许
        r.expose_warning_ack = true;
        assert!(validate_rule(&r).is_ok());
    }

    /// SOCKS5 选择了用户名口令认证但未配置口令时必须拒绝启动。
    #[test]
    fn rejects_dynamic_userpass_without_password() {
        let mut r = rule(PortForwardType::Dynamic);
        r.socks_auth = SocksAuth::Userpass;
        r.socks_username = Some("user".to_string());
        assert!(validate_rule(&r).is_err());

        r.socks_password_ref = Some("s3cret".to_string());
        let pass = validate_rule(&r).expect("should pass");
        assert_eq!(pass.as_deref(), Some("s3cret"));
    }

    /// 远端反向转发未实现，必须明确报错而不是假装成功。
    #[test]
    fn rejects_remote_forward_as_unimplemented() {
        let r = rule(PortForwardType::Remote);
        let err = validate_rule(&r).unwrap_err();
        assert_eq!(err.code, ErrorCode::ForwardBind);
        assert!(err.message.contains("尚未实现"));
    }
}
