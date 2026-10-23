//! 应用事件（IPC 事件的领域侧定义）。

use crate::ids::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AppEvent {
    ConnectionState {
        connection_id: ConnectionId,
        state: ConnectionState,
        attempt: u32,
        next_retry_ms: Option<u64>,
        error: Option<String>,
    },
    TerminalNotice {
        tab_id: TabId,
        kind: TerminalNoticeKind,
        value: Option<String>,
        exit_code: Option<i32>,
        paused: Option<bool>,
        dropped_bytes: Option<u64>,
    },
    VaultState {
        state: VaultLifecycle,
        reason: String,
    },
    Toast {
        level: String,
        message: String,
    },
    CardStateChanged {
        card_id: CardId,
        state: crate::entities::CardState,
        mode: crate::entities::CardMode,
        reason: Option<String>,
    },
    SerialPortsChanged {
        ports: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Idle,
    Resolving,
    Tcp,
    Handshake,
    Auth,
    Ready,
    Degraded,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalNoticeKind {
    Title,
    Cwd,
    Notify,
    Bell,
    Exit,
    Clipboard,
    Reset,
    Flow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultLifecycle {
    Locked,
    Unlocked,
}
