//! 串口类型定义与数据模型（严格对照 spec/serial.md）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

impl Default for DataBits {
    fn default() -> Self {
        Self::Eight
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopBits {
    One,
    OnePointFive,
    Two,
}

impl Default for StopBits {
    fn default() -> Self {
        Self::One
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    None,
    Even,
    Odd,
    Mark,
    Space,
}

impl Default for Parity {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowControl {
    None,
    Software, // XON/XOFF
    Hardware, // RTS/CTS
}

impl Default for FlowControl {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewlineMode {
    None,
    Cr,
    Lf,
    Crlf,
}

impl Default for NewlineMode {
    fn default() -> Self {
        Self::Crlf
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputNewlineMode {
    None,
    CrToCrlf,
    LfToCrlf,
    StripCr,
}

impl Default for OutputNewlineMode {
    fn default() -> Self {
        Self::LfToCrlf
    }
}

/// 串口连接配置 Profile。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialProfileConfig {
    pub port_name: String,
    pub baud_rate: u32,
    #[serde(default)]
    pub data_bits: DataBits,
    #[serde(default)]
    pub stop_bits: StopBits,
    #[serde(default)]
    pub parity: Parity,
    #[serde(default)]
    pub flow_control: FlowControl,
    #[serde(default = "default_true")]
    pub dtr_on_open: bool,
    #[serde(default = "default_true")]
    pub rts_on_open: bool,
    #[serde(default)]
    pub input_newline: NewlineMode,
    #[serde(default)]
    pub output_newline: OutputNewlineMode,
    #[serde(default)]
    pub local_echo: bool,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default = "default_reconnect_ms")]
    pub reconnect_interval_ms: u64,
}

fn default_true() -> bool {
    true
}

fn default_reconnect_ms() -> u64 {
    1500
}

impl Default for SerialProfileConfig {
    fn default() -> Self {
        Self {
            port_name: "COM1".to_string(),
            baud_rate: 115200,
            data_bits: DataBits::Eight,
            stop_bits: StopBits::One,
            parity: Parity::None,
            flow_control: FlowControl::None,
            dtr_on_open: true,
            rts_on_open: true,
            input_newline: NewlineMode::Crlf,
            output_newline: OutputNewlineMode::LfToCrlf,
            local_echo: false,
            auto_reconnect: false,
            reconnect_interval_ms: 1500,
        }
    }
}

/// Modem 状态引脚指示（CTS, DSR, RI, CD）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModemStatus {
    pub cts: bool,
    pub dsr: bool,
    pub ri: bool,
    pub cd: bool,
}

/// 串口端口枚举信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialPortInfo {
    pub name: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// 流量与速率统计。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SerialStats {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_bps: u64,
    pub tx_bps: u64,
}
