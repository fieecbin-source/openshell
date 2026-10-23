//! 串口通信错误定义。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SerialError {
    #[error("串口打开失败: {0}")]
    OpenFailed(String),

    #[error("端口不存在或未连接: {0}")]
    PortNotFound(String),

    #[error("端口正被其他进程占用: {0}")]
    PortBusy(String),

    #[error("无访问权限（请检查权限组或 udev 规则）: {0}")]
    PermissionDenied(String),

    #[error("不支持的串口参数配置: {0}")]
    InvalidConfiguration(String),

    #[error("数据读取 I/O 错误: {0}")]
    ReadError(String),

    #[error("数据写入 I/O 错误: {0}")]
    WriteError(String),

    #[error("串口设备已意外断开/拔出")]
    DeviceDisconnected,

    #[error("操作超时")]
    Timeout,

    #[error("串口未打开")]
    NotConnected,

    #[error("Modem 控制线操作失败: {0}")]
    ModemControlFailed(String),

    #[error("底层驱动错误: {0}")]
    DriverError(String),
}

pub type SerialResult<T> = Result<T, SerialError>;
