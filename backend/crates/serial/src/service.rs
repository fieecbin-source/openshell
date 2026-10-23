//! 串口管理服务（SerialService）。

use crate::backend::SerialBackend;
use crate::error::{SerialError, SerialResult};
use crate::mock::MockSerialBackend;
use crate::native::NativeSerialBackend;
use crate::types::{ModemStatus, SerialProfileConfig, SerialStats};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

struct SessionEntry {
    backend: Box<dyn SerialBackend>,
    mock: Option<MockSerialBackend>,
    stats: SerialStats,
    last_speed_check: Instant,
    rx_since_last: u64,
    tx_since_last: u64,
}

#[derive(Clone, Default)]
pub struct SerialService {
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
}

impl SerialService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 打开指定卡片的串口连接
    pub async fn open(
        &self,
        card_id: &str,
        config: &SerialProfileConfig,
        use_mock: bool,
    ) -> SerialResult<()> {
        let (mut backend, mock): (Box<dyn SerialBackend>, Option<MockSerialBackend>) = if use_mock {
            let m = MockSerialBackend::new();
            (Box::new(m.clone()), Some(m))
        } else {
            (Box::new(NativeSerialBackend::new()), None)
        };

        backend.open(config).await?;

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            card_id.to_string(),
            SessionEntry {
                backend,
                mock,
                stats: SerialStats::default(),
                last_speed_check: Instant::now(),
                rx_since_last: 0,
                tx_since_last: 0,
            },
        );

        Ok(())
    }

    /// 读取数据并统计流量与速率
    pub async fn read(&self, card_id: &str, buf: &mut [u8]) -> SerialResult<usize> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(card_id).ok_or(SerialError::NotConnected)?;

        let n = entry.backend.read(buf).await?;
        if n > 0 {
            entry.stats.rx_bytes += n as u64;
            entry.rx_since_last += n as u64;
            let elapsed = entry.last_speed_check.elapsed().as_secs_f64();
            if elapsed >= 1.0 {
                entry.stats.rx_bps = (entry.rx_since_last as f64 / elapsed) as u64;
                entry.stats.tx_bps = (entry.tx_since_last as f64 / elapsed) as u64;
                entry.rx_since_last = 0;
                entry.tx_since_last = 0;
                entry.last_speed_check = Instant::now();
            }
        }
        Ok(n)
    }

    /// 写入数据并统计流量
    pub async fn write(&self, card_id: &str, data: &[u8]) -> SerialResult<usize> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(card_id).ok_or(SerialError::NotConnected)?;

        let n = entry.backend.write(data).await?;
        if n > 0 {
            entry.stats.tx_bytes += n as u64;
            entry.tx_since_last += n as u64;
        }
        Ok(n)
    }

    /// 设置 DTR / RTS 控制线
    pub async fn set_lines(
        &self,
        card_id: &str,
        dtr: Option<bool>,
        rts: Option<bool>,
    ) -> SerialResult<()> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(card_id).ok_or(SerialError::NotConnected)?;

        if let Some(level) = dtr {
            entry.backend.set_dtr(level).await?;
        }
        if let Some(level) = rts {
            entry.backend.set_rts(level).await?;
        }
        Ok(())
    }

    /// 读取 Modem 状态引脚
    pub async fn get_modem_status(&self, card_id: &str) -> SerialResult<ModemStatus> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(card_id).ok_or(SerialError::NotConnected)?;
        entry.backend.read_modem_status().await
    }

    /// 热修改波特率
    pub async fn set_baud_rate(&self, card_id: &str, baud_rate: u32) -> SerialResult<()> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(card_id).ok_or(SerialError::NotConnected)?;
        entry.backend.set_baud_rate(baud_rate).await
    }

    /// 获取流量统计数据
    pub async fn get_stats(&self, card_id: &str) -> Option<SerialStats> {
        let sessions = self.sessions.lock().await;
        sessions.get(card_id).map(|e| e.stats)
    }

    /// 关闭会话
    pub async fn close(&self, card_id: &str) -> SerialResult<()> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut entry) = sessions.remove(card_id) {
            entry.backend.close().await?;
        }
        Ok(())
    }

    /// 获取绑定的 Mock 实例（仅用于单元测试注入与断言）
    pub async fn get_mock(&self, card_id: &str) -> Option<MockSerialBackend> {
        let sessions = self.sessions.lock().await;
        sessions.get(card_id).and_then(|e| e.mock.clone())
    }

    /// 检查指定卡片串口是否活跃
    pub async fn is_open(&self, card_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions
            .get(card_id)
            .map(|e| e.backend.is_open())
            .unwrap_or(false)
    }
}
