//! 串口类型定义与数据模型（严格对照 spec/serial.md）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DataBits {
    Five,
    Six,
    Seven,
    #[default]
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StopBits {
    #[default]
    One,
    OnePointFive,
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    #[default]
    None,
    Even,
    Odd,
    Mark,
    Space,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FlowControl {
    #[default]
    None,
    Software, // XON/XOFF
    Hardware, // RTS/CTS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NewlineMode {
    None,
    Cr,
    Lf,
    #[default]
    Crlf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputNewlineMode {
    None,
    CrToCrlf,
    #[default]
    LfToCrlf,
    StripCr,
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
