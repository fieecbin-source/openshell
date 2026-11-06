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

impl SessionEntry {
    fn new(backend: Box<dyn SerialBackend>, mock: Option<MockSerialBackend>) -> Self {
        Self {
            backend,
            mock,
            stats: SerialStats::default(),
            last_speed_check: Instant::now(),
            rx_since_last: 0,
            tx_since_last: 0,
        }
    }
}

/// 串口会话管理服务。
///
/// 每张卡片有独立的锁：全局表锁只在取/放条目时短暂持有，后端 `await` 只在卡片自己的锁内进行。
/// 历史实现把所有卡片放在同一把锁下并在持锁期间 `await` 后端调用，一张卡的控制命令被阻塞
/// （例如读队列满导致 worker 卡在投递）就会连带阻塞其他卡片的 read/write/close。
#[derive(Clone, Default)]
pub struct SerialService {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SessionEntry>>>>>,
}

impl SerialService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 取指定卡片的独立锁；找不到会话时返回 `NotConnected`（不阻塞其他卡片）。
    async fn entry(&self, card_id: &str) -> SerialResult<Arc<Mutex<SessionEntry>>> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(card_id)
            .cloned()
            .ok_or(SerialError::NotConnected)
    }

    async fn insert(
        &self,
        card_id: &str,
        backend: Box<dyn SerialBackend>,
        mock: Option<MockSerialBackend>,
    ) {
        self.sessions
            .lock()
            .await
            .insert(card_id.to_string(), Arc::new(Mutex::new(SessionEntry::new(backend, mock))));
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
        self.insert(card_id, backend, mock).await;
        Ok(())
    }

    /// 仅供测试：注入自定义后端，用于验证「一张卡卡住不影响其他卡」的隔离性。
    ///
    /// 生产路径固定是 mock/native 两种实现（由 [`SerialService::open`] 的 `use_mock` 选择）。
    #[doc(hidden)]
    pub async fn open_with_backend(
        &self,
        card_id: &str,
        backend: Box<dyn SerialBackend>,
    ) -> SerialResult<()> {
        self.insert(card_id, backend, None).await;
        Ok(())
    }

    /// 读取数据并统计流量与速率
    pub async fn read(&self, card_id: &str, buf: &mut [u8]) -> SerialResult<usize> {
        let entry = self.entry(card_id).await?;
        let mut entry = entry.lock().await;

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
        let entry = self.entry(card_id).await?;
        let mut entry = entry.lock().await;

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
        let entry = self.entry(card_id).await?;
        let mut entry = entry.lock().await;

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
        let entry = self.entry(card_id).await?;
        let mut entry = entry.lock().await;
        entry.backend.read_modem_status().await
    }

    /// 热修改波特率
    pub async fn set_baud_rate(&self, card_id: &str, baud_rate: u32) -> SerialResult<()> {
        let entry = self.entry(card_id).await?;
        let mut entry = entry.lock().await;
        entry.backend.set_baud_rate(baud_rate).await
    }

    /// 获取流量统计数据
    pub async fn get_stats(&self, card_id: &str) -> Option<SerialStats> {
        let entry = self.entry(card_id).await.ok()?;
        let entry = entry.lock().await;
        Some(entry.stats)
    }

    /// 关闭会话
    ///
    /// 先摘除会话条目再关停后端：之后的调用立即得到 `NotConnected`，
    /// 不会被正在关闭（或已被阻塞）的卡片拖住。
    pub async fn close(&self, card_id: &str) -> SerialResult<()> {
        let removed = self.sessions.lock().await.remove(card_id);
        if let Some(entry) = removed {
            let mut entry = entry.lock().await;
            entry.backend.close().await?;
        }
        Ok(())
    }

    /// 获取绑定的 Mock 实例（仅用于单元测试注入与断言）
    pub async fn get_mock(&self, card_id: &str) -> Option<MockSerialBackend> {
        let entry = self.entry(card_id).await.ok()?;
        let entry = entry.lock().await;
        entry.mock.clone()
    }

    /// 检查指定卡片串口是否活跃
    pub async fn is_open(&self, card_id: &str) -> bool {
        let Ok(entry) = self.entry(card_id).await else {
            return false;
        };
        let entry = entry.lock().await;
        entry.backend.is_open()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DataBits, FlowControl, Parity, StopBits};
    use async_trait::async_trait;
    use std::time::Duration;

    /// 一个卡片的后端被卡住时，其他卡片仍必须能完成读写与关闭。
    struct BlockingBackend {
        released: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl SerialBackend for BlockingBackend {
        async fn open(&mut self, _config: &SerialProfileConfig) -> SerialResult<()> {
            Ok(())
        }
        async fn read(&mut self, _buf: &mut [u8]) -> SerialResult<usize> {
            // 模拟「控制命令/读队列被反压」而长时间无响应。
            self.released.notified().await;
            Ok(0)
        }
        async fn write(&mut self, data: &[u8]) -> SerialResult<usize> {
            Ok(data.len())
        }
        async fn set_dtr(&mut self, _level: bool) -> SerialResult<()> {
            Ok(())
        }
        async fn set_rts(&mut self, _level: bool) -> SerialResult<()> {
            Ok(())
        }
        async fn read_modem_status(&mut self) -> SerialResult<ModemStatus> {
            Ok(ModemStatus {
                cts: true,
                dsr: true,
                ri: false,
                cd: true,
            })
        }
        async fn set_baud_rate(&mut self, _baud_rate: u32) -> SerialResult<()> {
            Ok(())
        }
        async fn close(&mut self) -> SerialResult<()> {
            Ok(())
        }
        fn is_open(&self) -> bool {
            true
        }
    }

    fn config() -> SerialProfileConfig {
        SerialProfileConfig {
            port_name: "COM-TEST".into(),
            baud_rate: 115200,
            data_bits: DataBits::Eight,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_blocked_card_does_not_stall_other_cards() {
        let service = SerialService::new();
        let released = Arc::new(tokio::sync::Notify::new());
        service
            .open_with_backend(
                "stuck",
                Box::new(BlockingBackend {
                    released: released.clone(),
                }),
            )
            .await
            .unwrap();
        service.open("healthy", &config(), true).await.unwrap();

        // 卡住的那张卡正在 read（持自己的锁，等待释放）。
        let stuck = {
            let service = service.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8];
                service.read("stuck", &mut buf).await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;

        // 另一张卡的读写、控制线与关闭必须在有界时间内完成。
        let healthy = tokio::time::timeout(Duration::from_secs(2), async {
            service.write("healthy", b"ping").await.unwrap();
            let mut buf = [0u8; 8];
            assert_eq!(service.read("healthy", &mut buf).await.unwrap(), 0);
            service.get_modem_status("healthy").await.unwrap();
            service.close("healthy").await.unwrap();
        })
        .await;
        assert!(healthy.is_ok(), "a blocked card stalled an unrelated card");
        assert!(!service.is_open("healthy").await);

        // 释放卡住的卡片后，它的读取与其后关闭都必须收敛。
        released.notify_one();
        tokio::time::timeout(Duration::from_secs(2), stuck)
            .await
            .expect("the blocked read never finished")
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), service.close("stuck"))
            .await
            .expect("closing the released card did not complete")
            .unwrap();
    }

    #[tokio::test]
    async fn close_removes_the_session_before_waiting_on_its_backend() {
        let service = SerialService::new();
        let released = Arc::new(tokio::sync::Notify::new());
        service
            .open_with_backend(
                "stuck",
                Box::new(BlockingBackend {
                    released: released.clone(),
                }),
            )
            .await
            .unwrap();
        let reader = {
            let service = service.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8];
                service.read("stuck", &mut buf).await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        // 关闭被同一张卡的 in-flight 读拖住是允许的，但其他调用必须立刻失败。
        let closer = {
            let service = service.clone();
            tokio::spawn(async move { service.close("stuck").await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(matches!(
            service.write("stuck", b"x").await,
            Err(SerialError::NotConnected)
        ));
        released.notify_one();
        tokio::time::timeout(Duration::from_secs(2), closer)
            .await
            .expect("close did not finish after the backend was released")
            .unwrap()
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
}
