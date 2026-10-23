//! 串口后端抽象 Trait（SerialBackend）。

use crate::error::SerialResult;
use crate::types::{ModemStatus, SerialProfileConfig};
use async_trait::async_trait;

#[async_trait]
pub trait SerialBackend: Send + Sync {
    /// 打开串口设备并应用配置
    async fn open(&mut self, config: &SerialProfileConfig) -> SerialResult<()>;

    /// 从串口读取数据（异步非阻塞）
    async fn read(&mut self, buf: &mut [u8]) -> SerialResult<usize>;

    /// 向串口写入数据
    async fn write(&mut self, data: &[u8]) -> SerialResult<usize>;

    /// 设置 DTR 控制引脚电平
    async fn set_dtr(&mut self, level: bool) -> SerialResult<()>;

    /// 设置 RTS 控制引脚电平
    async fn set_rts(&mut self, level: bool) -> SerialResult<()>;

    /// 读取 Modem 状态引脚（CTS, DSR, RI, CD）
    async fn read_modem_status(&mut self) -> SerialResult<ModemStatus>;

    /// 动态热更新波特率
    async fn set_baud_rate(&mut self, baud_rate: u32) -> SerialResult<()>;

    /// 关闭并释放串口设备
    async fn close(&mut self) -> SerialResult<()>;

    /// 检查串口当前是否处于打开状态
    fn is_open(&self) -> bool;
}
