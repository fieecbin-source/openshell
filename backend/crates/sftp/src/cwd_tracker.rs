//! 终端工作目录跟踪（OSC 7 与降级解析）。

use openshell_core_domain::SessionId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// CWD 跟踪器。
#[derive(Clone, Default)]
pub struct CwdTracker {
    cwds: Arc<RwLock<HashMap<SessionId, String>>>,
}

impl CwdTracker {
    pub fn new() -> Self {
        Self {
            cwds: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 获取某会话当前记录的工作目录。
    pub async fn get_cwd(&self, session_id: &SessionId) -> Option<String> {
        let cwds = self.cwds.read().await;
        cwds.get(session_id).cloned()
    }

    /// 设置某会话的工作目录。
    pub async fn set_cwd(&self, session_id: SessionId, cwd: String) {
        let mut cwds = self.cwds.write().await;
        cwds.insert(session_id, cwd);
    }

    /// 从终端数据片段中提取 OSC 7 报告的目录。
    /// 格式示例：`\x1b]7;file://hostname/var/log\x07` 或 `\x1b]7;file:///var/log\x1b\\`
    pub fn parse_osc7(data: &[u8]) -> Option<String> {
        let s = String::from_utf8_lossy(data);
        if let Some(pos) = s.find("\x1b]7;") {
            let rest = &s[pos + 4..];
            // 结束符可以是 \x07 (BEL) 或 \x1b\ (ST)
            let end_pos = rest.find('\x07').or_else(|| rest.find("\x1b\\"));
            if let Some(end) = end_pos {
                let uri = &rest[..end];
                // 解析 file://[host]/path
                if let Some(path_start) = uri.strip_prefix("file://") {
                    if let Some(slash_idx) = path_start.find('/') {
                        let path = &path_start[slash_idx..];
                        if !path.is_empty() {
                            return Some(path.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// 针对终端输出字节流进行监听，检测到 OSC 7 自动更新。
    pub async fn ingest_terminal_output(&self, session_id: &SessionId, chunk: &[u8]) {
        if let Some(cwd) = Self::parse_osc7(chunk) {
            self.set_cwd(session_id.clone(), cwd).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_osc7_bel() {
        let sample = b"some output \x1b]7;file://myserver/home/ops/work\x07 more text";
        assert_eq!(
            CwdTracker::parse_osc7(sample),
            Some("/home/ops/work".to_string())
        );
    }

    #[test]
    fn test_parse_osc7_st() {
        let sample = b"\x1b]7;file://localhost/etc/nginx\x1b\\prompt> ";
        assert_eq!(
            CwdTracker::parse_osc7(sample),
            Some("/etc/nginx".to_string())
        );
    }
}
