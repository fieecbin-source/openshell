//! 原生串口后端实现（基于 serialport-rs，跨平台调用操作系统驱动）。

use crate::backend::SerialBackend;
use crate::error::{SerialError, SerialResult};
use crate::types::{DataBits, FlowControl, ModemStatus, Parity, SerialProfileConfig, StopBits};
use async_trait::async_trait;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

enum ControlMsg {
    SetDtr(bool, oneshot::Sender<SerialResult<()>>),
    SetRts(bool, oneshot::Sender<SerialResult<()>>),
    GetModem(oneshot::Sender<SerialResult<ModemStatus>>),
    SetBaud(u32, oneshot::Sender<SerialResult<()>>),
    Write(Vec<u8>, oneshot::Sender<SerialResult<usize>>),
}

pub struct NativeSerialBackend {
    is_open: Arc<AtomicBool>,
    control_tx: Option<mpsc::Sender<ControlMsg>>,
    rx_receiver: Option<mpsc::Receiver<SerialResult<Vec<u8>>>>,
    read_chunk_buffer: Vec<u8>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Default for NativeSerialBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeSerialBackend {
    pub fn new() -> Self {
        Self {
            is_open: Arc::new(AtomicBool::new(false)),
            control_tx: None,
            rx_receiver: None,
            read_chunk_buffer: Vec::new(),
            worker: None,
        }
    }
}

impl Drop for NativeSerialBackend {
    fn drop(&mut self) {
        self.is_open.store(false, Ordering::SeqCst);
        self.control_tx.take();
        self.rx_receiver.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn close_waits_for_worker_to_release_device() {
        let mut backend = NativeSerialBackend::new();
        backend.is_open.store(true, Ordering::SeqCst);
        let open = backend.is_open.clone();
        let (released_tx, released_rx) = std::sync::mpsc::channel();
        backend.worker = Some(std::thread::spawn(move || {
            while open.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(20));
            released_tx.send(()).unwrap();
        }));
        backend.close().await.unwrap();
        assert!(
            released_rx.try_recv().is_ok(),
            "close returned before the device worker exited"
        );
        assert!(backend.worker.is_none());
    }

    #[tokio::test]
    async fn unsupported_parameters_are_not_silently_replaced() {
        for (parity, stop_bits) in [
            (Parity::Mark, StopBits::One),
            (Parity::Space, StopBits::One),
            (Parity::None, StopBits::OnePointFive),
        ] {
            let mut backend = NativeSerialBackend::new();
            let config = SerialProfileConfig {
                port_name: "openshell-nonexistent-serial-port".into(),
                parity,
                stop_bits,
                ..Default::default()
            };
            assert!(matches!(
                backend.open(&config).await,
                Err(SerialError::InvalidConfiguration(_))
            ));
        }
    }

    #[tokio::test]
    async fn idle_and_queued_data_are_distinct_from_driver_failure() {
        let mut backend = NativeSerialBackend::new();
        backend.is_open.store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(4);
        backend.rx_receiver = Some(rx);
        let mut bytes = [0; 2];
        assert_eq!(backend.read(&mut bytes).await.unwrap(), 0);
        tx.send(Ok(vec![1, 2, 3])).await.unwrap();
        tx.send(Err(SerialError::ReadError(
            "synthetic driver disconnect".into(),
        )))
        .await
        .unwrap();
        backend.is_open.store(false, Ordering::SeqCst);
        drop(tx);
        assert_eq!(backend.read(&mut bytes).await.unwrap(), 2);
        assert_eq!(bytes, [1, 2]);
        assert_eq!(backend.read(&mut bytes).await.unwrap(), 1);
        assert_eq!(bytes[0], 3);
        assert!(
            matches!(backend.read(&mut bytes).await, Err(SerialError::ReadError(message)) if message == "synthetic driver disconnect")
        );
        assert!(matches!(
            backend.read(&mut bytes).await,
            Err(SerialError::DeviceDisconnected)
        ));
        assert!(matches!(
            backend.write(b"x").await,
            Err(SerialError::DeviceDisconnected)
        ));
    }

    /// 可控假设备：按顺序吐出预置字节，并记录被写入的内容。
    struct FakeDevice {
        chunks: Vec<Vec<u8>>,
        written: Arc<std::sync::Mutex<Vec<u8>>>,
        dtr: bool,
    }

    impl SerialDevice for FakeDevice {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let Some(chunk) = self.chunks.first().cloned() else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "synthetic idle",
                ));
            };
            assert!(chunk.len() <= buf.len(), "test chunk must fit the read buffer");
            buf[..chunk.len()].copy_from_slice(&chunk);
            self.chunks.remove(0);
            Ok(chunk.len())
        }
        fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
            self.written.lock().unwrap().extend_from_slice(data);
            Ok(())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn set_dtr(&mut self, level: bool) -> serialport::Result<()> {
            self.dtr = level;
            Ok(())
        }
        fn set_rts(&mut self, _level: bool) -> serialport::Result<()> {
            Ok(())
        }
        fn set_baud(&mut self, _baud: u32) -> serialport::Result<()> {
            Ok(())
        }
        fn clear_to_send(&mut self) -> serialport::Result<bool> {
            Ok(true)
        }
        fn data_set_ready(&mut self) -> serialport::Result<bool> {
            Ok(true)
        }
        fn ring_indicator(&mut self) -> serialport::Result<bool> {
            Ok(false)
        }
        fn carrier_detect(&mut self) -> serialport::Result<bool> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn full_rx_queue_still_completes_control_writes_and_close() {
        let (rx_tx, mut rx_rx) = mpsc::channel::<SerialResult<Vec<u8>>>(1);
        // 容量 1 的 RX 队列先塞满：旧实现在这里 blocking_send 卡死整条 worker。
        rx_tx.try_send(Ok(vec![0xAA])).unwrap();
        let (ctrl_tx, mut ctrl_rx) = mpsc::channel::<ControlMsg>(4);
        let is_open = Arc::new(AtomicBool::new(true));
        let written = Arc::new(std::sync::Mutex::new(Vec::new()));
        let device = FakeDevice {
            chunks: vec![vec![1u8; 4096], vec![2u8; 1024]],
            written: written.clone(),
            dtr: false,
        };
        let flag = is_open.clone();
        let worker = std::thread::spawn(move || {
            let mut device = device;
            run_worker(&mut device, &mut ctrl_rx, &rx_tx, &flag);
        });

        // 队列满且设备仍有数据时，write 仍必须在有界时间内返回。
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::Write(vec![9, 9], resp_tx))
            .await
            .unwrap();
        let written_len = tokio::time::timeout(Duration::from_secs(2), resp_rx)
            .await
            .expect("write was blocked by a full RX queue")
            .expect("worker dropped the write response")
            .expect("write failed");
        assert_eq!(written_len, 2);
        assert_eq!(written.lock().unwrap().as_slice(), &[9, 9]);

        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx.send(ControlMsg::GetModem(resp_tx)).await.unwrap();
        let modem = tokio::time::timeout(Duration::from_secs(2), resp_rx)
            .await
            .expect("modem status was blocked by a full RX queue")
            .expect("worker dropped the modem response")
            .expect("modem status failed");
        assert!(modem.cts);

        // 消费队列后，被反压的字节必须完整、按序到达。
        assert_eq!(rx_rx.recv().await.unwrap().unwrap(), vec![0xAA]);
        assert_eq!(rx_rx.recv().await.unwrap().unwrap(), vec![1u8; 4096]);
        assert_eq!(rx_rx.recv().await.unwrap().unwrap(), vec![2u8; 1024]);

        is_open.store(false, Ordering::SeqCst);
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || worker.join().unwrap()),
        )
        .await
        .expect("worker did not observe close while the RX queue was full")
        .expect("worker thread panicked");
        assert!(!is_open.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn closing_while_backpressured_stops_the_worker() {
        let (rx_tx, _rx_rx) = mpsc::channel::<SerialResult<Vec<u8>>>(1);
        rx_tx.try_send(Ok(vec![1])).unwrap();
        let (_ctrl_tx, mut ctrl_rx) = mpsc::channel::<ControlMsg>(4);
        let is_open = Arc::new(AtomicBool::new(true));
        let device = FakeDevice {
            chunks: vec![vec![7u8; 1024]],
            written: Arc::new(std::sync::Mutex::new(Vec::new())),
            dtr: true,
        };
        let flag = is_open.clone();
        let worker = std::thread::spawn(move || {
            let mut device = device;
            run_worker(&mut device, &mut ctrl_rx, &rx_tx, &flag);
        });
        std::thread::sleep(Duration::from_millis(30));
        is_open.store(false, Ordering::SeqCst);
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || worker.join().unwrap()),
        )
        .await
        .expect("close did not interrupt a backpressured worker")
        .expect("worker thread panicked");
        assert!(!is_open.load(Ordering::SeqCst));
    }
}

fn map_data_bits(bits: DataBits) -> serialport::DataBits {
    match bits {
        DataBits::Five => serialport::DataBits::Five,
        DataBits::Six => serialport::DataBits::Six,
        DataBits::Seven => serialport::DataBits::Seven,
        DataBits::Eight => serialport::DataBits::Eight,
    }
}

fn map_stop_bits(bits: StopBits) -> serialport::StopBits {
    match bits {
        StopBits::One => serialport::StopBits::One,
        StopBits::OnePointFive | StopBits::Two => serialport::StopBits::Two,
    }
}

fn map_parity(parity: Parity) -> serialport::Parity {
    match parity {
        Parity::None | Parity::Mark | Parity::Space => serialport::Parity::None,
        Parity::Even => serialport::Parity::Even,
        Parity::Odd => serialport::Parity::Odd,
    }
}

fn map_flow_control(flow: FlowControl) -> serialport::FlowControl {
    match flow {
        FlowControl::None => serialport::FlowControl::None,
        FlowControl::Software => serialport::FlowControl::Software,
        FlowControl::Hardware => serialport::FlowControl::Hardware,
    }
}

/// worker 线程所需的最小设备能力。
///
/// 生产实现包装 `serialport::SerialPort`；测试用可控假设备驱动同一段循环，
/// 否则「RX 队列满时控制命令是否仍有界完成」只能靠真实硬件验证。
trait SerialDevice: Send {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize>;
    fn write_all(&mut self, data: &[u8]) -> std::io::Result<()>;
    fn flush(&mut self) -> std::io::Result<()>;
    fn set_dtr(&mut self, level: bool) -> serialport::Result<()>;
    fn set_rts(&mut self, level: bool) -> serialport::Result<()>;
    fn set_baud(&mut self, baud: u32) -> serialport::Result<()>;
    fn clear_to_send(&mut self) -> serialport::Result<bool>;
    fn data_set_ready(&mut self) -> serialport::Result<bool>;
    fn ring_indicator(&mut self) -> serialport::Result<bool>;
    fn carrier_detect(&mut self) -> serialport::Result<bool>;
}

struct NativeDevice(Box<dyn serialport::SerialPort>);

impl SerialDevice for NativeDevice {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        Read::read(&mut self.0, buf)
    }
    fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        Write::write_all(&mut self.0, data)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Write::flush(&mut self.0)
    }
    fn set_dtr(&mut self, level: bool) -> serialport::Result<()> {
        self.0.write_data_terminal_ready(level)
    }
    fn set_rts(&mut self, level: bool) -> serialport::Result<()> {
        self.0.write_request_to_send(level)
    }
    fn set_baud(&mut self, baud: u32) -> serialport::Result<()> {
        self.0.set_baud_rate(baud)
    }
    fn clear_to_send(&mut self) -> serialport::Result<bool> {
        self.0.read_clear_to_send()
    }
    fn data_set_ready(&mut self) -> serialport::Result<bool> {
        self.0.read_data_set_ready()
    }
    fn ring_indicator(&mut self) -> serialport::Result<bool> {
        self.0.read_ring_indicator()
    }
    fn carrier_detect(&mut self) -> serialport::Result<bool> {
        self.0.read_carrier_detect()
    }
}

/// 串口读线程主体。
///
/// 关键约束：**先处理控制命令，再考虑投递数据**，且数据投递永不阻塞。
/// 历史实现在 RX 队列满时 `blocking_send` 卡住整条线程，控制通道随之塞满，
/// 而 `SerialService` 又持着全局会话锁等待控制响应，最终读/关停与所有卡片一起死锁。
///
/// 现在队列满时把已读字节留在本地（`pending`）并停止继续读，由驱动缓冲承担反压：
/// 既不丢字节，也不会把线程卡死。
fn run_worker(
    device: &mut dyn SerialDevice,
    ctrl_rx: &mut mpsc::Receiver<ControlMsg>,
    rx_tx: &mpsc::Sender<SerialResult<Vec<u8>>>,
    is_open: &AtomicBool,
) {
    let mut read_buf = [0u8; 16384];
    let mut pending: Option<Vec<u8>> = None;

    while is_open.load(Ordering::SeqCst) {
        while let Ok(msg) = ctrl_rx.try_recv() {
            match msg {
                ControlMsg::SetDtr(level, resp) => {
                    let res = device
                        .set_dtr(level)
                        .map_err(|e| SerialError::ModemControlFailed(e.to_string()));
                    let _ = resp.send(res);
                }
                ControlMsg::SetRts(level, resp) => {
                    let res = device
                        .set_rts(level)
                        .map_err(|e| SerialError::ModemControlFailed(e.to_string()));
                    let _ = resp.send(res);
                }
                ControlMsg::GetModem(resp) => {
                    let cts = device.clear_to_send().unwrap_or(false);
                    let dsr = device.data_set_ready().unwrap_or(false);
                    let ri = device.ring_indicator().unwrap_or(false);
                    let cd = device.carrier_detect().unwrap_or(false);
                    let _ = resp.send(Ok(ModemStatus { cts, dsr, ri, cd }));
                }
                ControlMsg::SetBaud(baud, resp) => {
                    let res = device
                        .set_baud(baud)
                        .map_err(|e| SerialError::InvalidConfiguration(e.to_string()));
                    let _ = resp.send(res);
                }
                ControlMsg::Write(data, resp) => {
                    let res = device
                        .write_all(&data)
                        .and_then(|_| device.flush())
                        .map(|_| data.len())
                        .map_err(|e| SerialError::WriteError(e.to_string()));
                    if res.is_err() {
                        is_open.store(false, Ordering::SeqCst);
                    }
                    let _ = resp.send(res);
                }
            }
        }
        if !is_open.load(Ordering::SeqCst) {
            break;
        }

        if let Some(chunk) = pending.take() {
            match rx_tx.try_send(Ok(chunk)) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(Ok(chunk))) => {
                    pending = Some(chunk);
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
                // 只有数据帧会进入 `pending`，此分支不可达，保守丢弃错误帧。
                Err(mpsc::error::TrySendError::Full(Err(_))) => {}
            }
        }

        // 队列满时 `pending` 非空即 continue，不再读设备，字节留在驱动缓冲。
        match device.read(&mut read_buf) {
            Ok(n) if n > 0 => pending = Some(read_buf[..n].to_vec()),
            Ok(_) => std::thread::sleep(Duration::from_millis(2)),
            Err(ref e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => {
                // 驱动错误必须让读取方看到，而不是静默变成“空闲”。
                let _ = rx_tx.try_send(Err(SerialError::ReadError(e.to_string())));
                break;
            }
        }
    }
    is_open.store(false, Ordering::SeqCst);
}

#[async_trait]
impl SerialBackend for NativeSerialBackend {
    async fn open(&mut self, config: &SerialProfileConfig) -> SerialResult<()> {
        if matches!(config.parity, Parity::Mark | Parity::Space)
            || config.stop_bits == StopBits::OnePointFive
        {
            return Err(SerialError::InvalidConfiguration(
                "当前原生驱动不支持所选校验位或 1.5 停止位".into(),
            ));
        }
        self.close().await?;
        let port_name = config.port_name.clone();
        let baud_rate = config.baud_rate;
        let data_bits = map_data_bits(config.data_bits);
        let stop_bits = map_stop_bits(config.stop_bits);
        let parity = map_parity(config.parity);
        let flow_control = map_flow_control(config.flow_control);
        let dtr_open = config.dtr_on_open;
        let rts_open = config.rts_on_open;

        // 打开原生串口对象（阻塞构建）
        let port = tokio::task::spawn_blocking(move || {
            serialport::new(&port_name, baud_rate)
                .data_bits(data_bits)
                .stop_bits(stop_bits)
                .parity(parity)
                .flow_control(flow_control)
                .timeout(Duration::from_millis(15))
                .open()
        })
        .await
        .map_err(|e| SerialError::OpenFailed(format!("Task spawn failed: {e}")))?
        .map_err(|e| match e.kind() {
            serialport::ErrorKind::NoDevice => SerialError::PortNotFound(e.to_string()),
            serialport::ErrorKind::InvalidInput => SerialError::InvalidConfiguration(e.to_string()),
            serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
                SerialError::PermissionDenied(e.to_string())
            }
            _ => {
                let msg = e.to_string();
                if msg.contains("Access is denied") || msg.contains("busy") {
                    SerialError::PortBusy(msg)
                } else if msg.contains("Permission denied") {
                    SerialError::PermissionDenied(msg)
                } else {
                    SerialError::OpenFailed(msg)
                }
            }
        })?;

        let (rx_tx, rx_rx) = mpsc::channel::<SerialResult<Vec<u8>>>(256);
        let (ctrl_tx, mut ctrl_rx) = mpsc::channel::<ControlMsg>(64);
        let is_open_flag = self.is_open.clone();
        is_open_flag.store(true, Ordering::SeqCst);

        // 启动后台阻塞工作线程处理同步 I/O 与引脚控制
        let worker = std::thread::Builder::new()
            .name("openshell-serial-worker".to_string())
            .spawn(move || {
                let mut device = NativeDevice(port);
                let _ = device.set_dtr(dtr_open);
                let _ = device.set_rts(rts_open);
                run_worker(&mut device, &mut ctrl_rx, &rx_tx, &is_open_flag);
            })
            .map_err(|e| {
                self.is_open.store(false, Ordering::SeqCst);
                SerialError::OpenFailed(format!("Failed to spawn worker: {e}"))
            })?;

        self.control_tx = Some(ctrl_tx);
        self.rx_receiver = Some(rx_rx);
        self.read_chunk_buffer.clear();
        self.worker = Some(worker);

        Ok(())
    }

    async fn read(&mut self, buf: &mut [u8]) -> SerialResult<usize> {
        // 如果缓冲区有上次未读完的数据，先消费缓冲区
        if !self.read_chunk_buffer.is_empty() {
            let to_read = buf.len().min(self.read_chunk_buffer.len());
            buf[..to_read].copy_from_slice(&self.read_chunk_buffer[..to_read]);
            self.read_chunk_buffer.drain(..to_read);
            return Ok(to_read);
        }

        let rx_rx = match &mut self.rx_receiver {
            Some(rx) => rx,
            None => return Err(SerialError::NotConnected),
        };

        match rx_rx.try_recv() {
            Ok(Ok(chunk)) => {
                let to_read = buf.len().min(chunk.len());
                buf[..to_read].copy_from_slice(&chunk[..to_read]);
                if chunk.len() > to_read {
                    self.read_chunk_buffer.extend_from_slice(&chunk[to_read..]);
                }
                Ok(to_read)
            }
            Ok(Err(error)) => Err(error),
            Err(mpsc::error::TryRecvError::Empty) if self.is_open.load(Ordering::SeqCst) => Ok(0),
            Err(mpsc::error::TryRecvError::Empty) => Err(SerialError::DeviceDisconnected),
            Err(mpsc::error::TryRecvError::Disconnected) => Err(SerialError::DeviceDisconnected),
        }
    }

    async fn write(&mut self, data: &[u8]) -> SerialResult<usize> {
        if !self.is_open.load(Ordering::SeqCst) {
            return Err(SerialError::DeviceDisconnected);
        }
        let ctrl_tx = self.control_tx.as_ref().ok_or(SerialError::NotConnected)?;
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::Write(data.to_vec(), resp_tx))
            .await
            .map_err(|_| SerialError::DeviceDisconnected)?;
        resp_rx.await.map_err(|_| SerialError::DeviceDisconnected)?
    }

    async fn set_dtr(&mut self, level: bool) -> SerialResult<()> {
        let ctrl_tx = self.control_tx.as_ref().ok_or(SerialError::NotConnected)?;
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::SetDtr(level, resp_tx))
            .await
            .map_err(|_| SerialError::DeviceDisconnected)?;
        resp_rx.await.map_err(|_| SerialError::DeviceDisconnected)?
    }

    async fn set_rts(&mut self, level: bool) -> SerialResult<()> {
        let ctrl_tx = self.control_tx.as_ref().ok_or(SerialError::NotConnected)?;
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::SetRts(level, resp_tx))
            .await
            .map_err(|_| SerialError::DeviceDisconnected)?;
        resp_rx.await.map_err(|_| SerialError::DeviceDisconnected)?
    }

    async fn read_modem_status(&mut self) -> SerialResult<ModemStatus> {
        let ctrl_tx = self.control_tx.as_ref().ok_or(SerialError::NotConnected)?;
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::GetModem(resp_tx))
            .await
            .map_err(|_| SerialError::DeviceDisconnected)?;
        resp_rx.await.map_err(|_| SerialError::DeviceDisconnected)?
    }

    async fn set_baud_rate(&mut self, baud_rate: u32) -> SerialResult<()> {
        let ctrl_tx = self.control_tx.as_ref().ok_or(SerialError::NotConnected)?;
        let (resp_tx, resp_rx) = oneshot::channel();
        ctrl_tx
            .send(ControlMsg::SetBaud(baud_rate, resp_tx))
            .await
            .map_err(|_| SerialError::DeviceDisconnected)?;
        resp_rx.await.map_err(|_| SerialError::DeviceDisconnected)?
    }

    async fn close(&mut self) -> SerialResult<()> {
        self.is_open.store(false, Ordering::SeqCst);
        self.control_tx = None;
        self.rx_receiver = None;
        self.read_chunk_buffer.clear();
        if let Some(worker) = self.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|_| SerialError::DriverError("等待串口工作线程失败".into()))?
                .map_err(|_| SerialError::DriverError("串口工作线程异常退出".into()))?;
        }
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.is_open.load(Ordering::SeqCst)
    }
}
