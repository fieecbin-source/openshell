//! Mock 串口后端实现（用于脱离硬件的纯内存单元测试与集成测试）。

use crate::backend::SerialBackend;
use crate::error::{SerialError, SerialResult};
use crate::types::{ModemStatus, SerialProfileConfig};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;

struct MockInner {
    is_open: bool,
    config: Option<SerialProfileConfig>,
    rx_buffer: VecDeque<u8>,
    tx_buffer: Vec<u8>,
    dtr: bool,
    rts: bool,
    modem_status: ModemStatus,
    simulate_busy: bool,
    simulate_unplug: bool,
    responders: Vec<(Vec<u8>, Vec<u8>)>,
}

#[derive(Clone)]
pub struct MockSerialBackend {
    inner: Arc<Mutex<MockInner>>,
}

impl Default for MockSerialBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MockSerialBackend {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MockInner {
                is_open: false,
                config: None,
                rx_buffer: VecDeque::new(),
                tx_buffer: Vec::new(),
                dtr: true,
                rts: true,
                modem_status: ModemStatus {
                    cts: true,
                    dsr: true,
                    ri: false,
                    cd: true,
                },
                simulate_busy: false,
                simulate_unplug: false,
                responders: Vec::new(),
            })),
        }
    }

    /// 向 Mock 接收队列注入外部字节流（模拟对端发送）
    pub fn inject_rx(&self, data: &[u8]) {
        let mut inner = self.inner.lock();
        inner.rx_buffer.extend(data);
    }

    /// 获取并清空当前 Mock 累计发送出的字节
    pub fn take_tx(&self) -> Vec<u8> {
        let mut inner = self.inner.lock();
        std::mem::take(&mut inner.tx_buffer)
    }

    /// 查看当前 Mock 累计发送出的字节
    pub fn get_tx(&self) -> Vec<u8> {
        let inner = self.inner.lock();
        inner.tx_buffer.clone()
    }

    /// 模拟设备被拔出
    pub fn simulate_unplug(&self) {
        let mut inner = self.inner.lock();
        inner.simulate_unplug = true;
        inner.is_open = false;
    }

    /// 模拟端口被占用
    pub fn set_simulate_busy(&self, busy: bool) {
        let mut inner = self.inner.lock();
        inner.simulate_busy = busy;
    }

    /// 添加自动应答规则（若发送包含 pattern，则自动向 rx_buffer 回填 response）
    pub fn add_responder(&self, pattern: &[u8], response: &[u8]) {
        let mut inner = self.inner.lock();
        inner.responders.push((pattern.to_vec(), response.to_vec()));
    }

    /// 获取当前 DTR 电平
    pub fn get_dtr(&self) -> bool {
        self.inner.lock().dtr
    }

    /// 获取当前 RTS 电平
    pub fn get_rts(&self) -> bool {
        self.inner.lock().rts
    }
}

#[async_trait]
impl SerialBackend for MockSerialBackend {
    async fn open(&mut self, config: &SerialProfileConfig) -> SerialResult<()> {
        let mut inner = self.inner.lock();
        if inner.simulate_busy {
            return Err(SerialError::PortBusy(format!(
                "端口 {} 正在被其他进程占用",
                config.port_name
            )));
        }
        inner.is_open = true;
        inner.simulate_unplug = false;
        inner.config = Some(config.clone());
        inner.dtr = config.dtr_on_open;
        inner.rts = config.rts_on_open;
        Ok(())
    }

    async fn read(&mut self, buf: &mut [u8]) -> SerialResult<usize> {
        let mut inner = self.inner.lock();
        if !inner.is_open || inner.simulate_unplug {
            return Err(SerialError::DeviceDisconnected);
        }
        if inner.rx_buffer.is_empty() {
            return Ok(0);
        }
        let count = buf.len().min(inner.rx_buffer.len());
        for b in buf.iter_mut().take(count) {
            *b = inner.rx_buffer.pop_front().unwrap();
        }
        Ok(count)
    }

    async fn write(&mut self, data: &[u8]) -> SerialResult<usize> {
        let mut inner = self.inner.lock();
        if !inner.is_open || inner.simulate_unplug {
            return Err(SerialError::DeviceDisconnected);
        }
        inner.tx_buffer.extend_from_slice(data);

        // 检查是否有匹配的自动应答脚本
        let mut matched_responses = Vec::new();
        for (pattern, resp) in &inner.responders {
            if data.windows(pattern.len()).any(|w| w == pattern.as_slice()) {
                matched_responses.push(resp.clone());
            }
        }
        for resp in matched_responses {
            inner.rx_buffer.extend(resp);
        }

        Ok(data.len())
    }

    async fn set_dtr(&mut self, level: bool) -> SerialResult<()> {
        let mut inner = self.inner.lock();
        if !inner.is_open {
            return Err(SerialError::NotConnected);
        }
        inner.dtr = level;
        Ok(())
    }

    async fn set_rts(&mut self, level: bool) -> SerialResult<()> {
        let mut inner = self.inner.lock();
        if !inner.is_open {
            return Err(SerialError::NotConnected);
        }
        inner.rts = level;
        Ok(())
    }

    async fn read_modem_status(&mut self) -> SerialResult<ModemStatus> {
        let inner = self.inner.lock();
        if !inner.is_open {
            return Err(SerialError::NotConnected);
        }
        Ok(inner.modem_status)
    }

    async fn set_baud_rate(&mut self, baud_rate: u32) -> SerialResult<()> {
        let mut inner = self.inner.lock();
        if !inner.is_open {
            return Err(SerialError::NotConnected);
        }
        if let Some(cfg) = &mut inner.config {
            cfg.baud_rate = baud_rate;
        }
        Ok(())
    }

    async fn close(&mut self) -> SerialResult<()> {
        let mut inner = self.inner.lock();
        inner.is_open = false;
        Ok(())
    }

    fn is_open(&self) -> bool {
        let inner = self.inner.lock();
        inner.is_open && !inner.simulate_unplug
    }
}
