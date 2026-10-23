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
    rx_receiver: Option<mpsc::Receiver<Vec<u8>>>,
    read_chunk_buffer: Vec<u8>,
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
        }
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

#[async_trait]
impl SerialBackend for NativeSerialBackend {
    async fn open(&mut self, config: &SerialProfileConfig) -> SerialResult<()> {
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

        let (rx_tx, rx_rx) = mpsc::channel::<Vec<u8>>(256);
        let (ctrl_tx, mut ctrl_rx) = mpsc::channel::<ControlMsg>(64);
        let is_running = Arc::new(AtomicBool::new(true));
        let is_open_flag = self.is_open.clone();
        is_open_flag.store(true, Ordering::SeqCst);
        let is_running_clone = is_running.clone();

        // 启动后台阻塞工作线程处理同步 I/O 与引脚控制
        std::thread::Builder::new()
            .name("openshell-serial-worker".to_string())
            .spawn(move || {
                let mut port = port;
                let _ = port.write_data_terminal_ready(dtr_open);
                let _ = port.write_request_to_send(rts_open);

                let mut read_buf = [0u8; 16384];

                while is_running_clone.load(Ordering::Relaxed) {
                    // 1. 处理控制命令
                    while let Ok(msg) = ctrl_rx.try_recv() {
                        match msg {
                            ControlMsg::SetDtr(lvl, resp) => {
                                let res = port
                                    .write_data_terminal_ready(lvl)
                                    .map_err(|e| SerialError::ModemControlFailed(e.to_string()));
                                let _ = resp.send(res);
                            }
                            ControlMsg::SetRts(lvl, resp) => {
                                let res = port
                                    .write_request_to_send(lvl)
                                    .map_err(|e| SerialError::ModemControlFailed(e.to_string()));
                                let _ = resp.send(res);
                            }
                            ControlMsg::GetModem(resp) => {
                                let cts = port.read_clear_to_send().unwrap_or(false);
                                let dsr = port.read_data_set_ready().unwrap_or(false);
                                let ri = port.read_ring_indicator().unwrap_or(false);
                                let cd = port.read_carrier_detect().unwrap_or(false);
                                let _ = resp.send(Ok(ModemStatus { cts, dsr, ri, cd }));
                            }
                            ControlMsg::SetBaud(baud, resp) => {
                                let res = port
                                    .set_baud_rate(baud)
                                    .map_err(|e| SerialError::InvalidConfiguration(e.to_string()));
                                let _ = resp.send(res);
                            }
                            ControlMsg::Write(data, resp) => {
                                let res = port
                                    .write_all(&data)
                                    .and_then(|_| port.flush())
                                    .map(|_| data.len())
                                    .map_err(|e| SerialError::WriteError(e.to_string()));
                                let _ = resp.send(res);
                            }
                        }
                    }

                    // 2. 读取数据
                    match port.read(&mut read_buf) {
                        Ok(n) if n > 0 => {
                            if rx_tx.blocking_send(read_buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Ok(_) => {
                            // 读到 0 字节，略作休眠防空转
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            // 预期内超时，继续下一次循环
                        }
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::BrokenPipe
                                || e.kind() == std::io::ErrorKind::NotFound
                                || e.kind() == std::io::ErrorKind::PermissionDenied =>
                        {
                            // 设备拔出
                            break;
                        }
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(2));
                        }
                    }
                }

                is_open_flag.store(false, Ordering::SeqCst);
            })
            .map_err(|e| SerialError::OpenFailed(format!("Failed to spawn worker: {e}")))?;

        self.control_tx = Some(ctrl_tx);
        self.rx_receiver = Some(rx_rx);
        self.read_chunk_buffer.clear();

        Ok(())
    }

    async fn read(&mut self, buf: &mut [u8]) -> SerialResult<usize> {
        if !self.is_open.load(Ordering::SeqCst) {
            return Err(SerialError::DeviceDisconnected);
        }

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
            Ok(chunk) => {
                let to_read = buf.len().min(chunk.len());
                buf[..to_read].copy_from_slice(&chunk[..to_read]);
                if chunk.len() > to_read {
                    self.read_chunk_buffer.extend_from_slice(&chunk[to_read..]);
                }
                Ok(to_read)
            }
            Err(mpsc::error::TryRecvError::Empty) => Ok(0),
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
        Ok(())
    }

    fn is_open(&self) -> bool {
        self.is_open.load(Ordering::SeqCst)
    }
}
