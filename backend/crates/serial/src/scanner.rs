//! 跨平台串口端口枚举与热插拔感知器（Port Scanner & Watcher）。

use crate::error::SerialResult;
use crate::types::SerialPortInfo;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// 枚举当前系统所有可用串口端口
pub fn list_serial_ports() -> SerialResult<Vec<SerialPortInfo>> {
    let ports = serialport::available_ports().unwrap_or_default();
    let result = ports
        .into_iter()
        .map(|p| {
            let (port_type, manufacturer, product, serial_number, vid, pid) = match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    "USB".to_string(),
                    usb.manufacturer,
                    usb.product,
                    usb.serial_number,
                    Some(usb.vid),
                    Some(usb.pid),
                ),
                serialport::SerialPortType::PciPort => {
                    ("PCI".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::BluetoothPort => {
                    ("Bluetooth".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::Unknown => {
                    ("Standard".to_string(), None, None, None, None, None)
                }
            };

            SerialPortInfo {
                name: p.port_name,
                port_type,
                manufacturer,
                product,
                serial_number,
                vid,
                pid,
            }
        })
        .collect();

    Ok(result)
}

/// 后台热插拔感知监听器
pub struct SerialPortScanner {
    is_running: Arc<AtomicBool>,
    event_tx: broadcast::Sender<Vec<String>>,
}

impl Default for SerialPortScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialPortScanner {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            event_tx: tx,
        }
    }

    /// 订阅端口插拔变动通知
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<String>> {
        self.event_tx.subscribe()
    }

    /// 启动后台周期扫描（每 1.5 秒探测一次端口列表变化）
    pub fn start(&self) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = self.is_running.clone();
        let tx = self.event_tx.clone();

        tokio::spawn(async move {
            let mut last_set: HashSet<String> = list_serial_ports()
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.name)
                .collect();

            while is_running.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                if !is_running.load(Ordering::Relaxed) {
                    break;
                }

                let current_ports: Vec<String> = list_serial_ports()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.name)
                    .collect();

                let current_set: HashSet<String> = current_ports.iter().cloned().collect();
                if current_set != last_set {
                    last_set = current_set;
                    let _ = tx.send(current_ports);
                }
            }
        });
    }

    /// 停止扫描
    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }
}
