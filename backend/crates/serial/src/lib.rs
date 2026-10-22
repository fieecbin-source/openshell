//! OpenShell 串口（Serial）通信子系统。
//!
//! 提供跨平台串口硬件通信与 Mock 抽象。

pub mod error;
pub mod types;
pub mod backend;
pub mod mock;
pub mod native;
pub mod scanner;
pub mod service;

pub use backend::SerialBackend;
pub use error::SerialError;
pub use mock::MockSerialBackend;
pub use native::NativeSerialBackend;
pub use scanner::{list_serial_ports, SerialPortScanner};
pub use service::SerialService;
pub use types::*;
