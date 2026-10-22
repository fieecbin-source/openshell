//! 终端数据路由与流控：管理终端标签生命周期、背压信用窗口与二进制帧编码。

use crate::credit_tracker::{CreditTracker, FlowAction};
use crate::event_bus::EventBus;
use openshell_core_domain::{
    AppEvent, ByteStream, DomainError, DomainResult, ErrorCode, TabId, TermSize, TerminalNoticeKind,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// 帧编码：tag 0x01 为 PTY 数据，tag 0x03 为通知
pub fn encode_data_frame(data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + data.len());
    frame.push(0x01);
    let len = data.len() as u32;
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(data);
    frame
}

pub fn encode_notice_frame(kind: u8, text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut frame = Vec::with_capacity(5 + 1 + bytes.len());
    frame.push(0x03);
    let len = (1 + bytes.len()) as u32;
    frame.extend_from_slice(&len.to_le_bytes());
    frame.push(kind);
    frame.extend_from_slice(bytes);
    frame
}

struct ActiveTerminal {
    credit_tracker: Arc<CreditTracker>,
    write_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<TermSize>,
    abort_handle: AbortHandle,
}

pub struct TerminalRouter {
    terminals: RwLock<HashMap<TabId, ActiveTerminal>>,
    event_bus: Arc<EventBus>,
}

impl TerminalRouter {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            terminals: RwLock::new(HashMap::new()),
            event_bus,
        }
    }

    /// 将打开的字节流挂载到指定终端标签，并启动读写与流控协程。
    pub fn attach_stream(
        &self,
        tab_id: TabId,
        mut stream: Box<dyn ByteStream>,
        out_tx: mpsc::Sender<Vec<u8>>,
    ) -> DomainResult<()> {
        let credit_tracker = Arc::new(CreditTracker::new());
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(128);
        let (resize_tx, mut resize_rx) = mpsc::channel::<TermSize>(16);

        let tracker_clone = credit_tracker.clone();
        let event_bus_clone = self.event_bus.clone();
        let tab_id_clone = tab_id.clone();

        let join_handle = tokio::spawn(async move {
            let mut read_buf = [0u8; 16384]; // 16 KiB
            let mut batch_buf = Vec::with_capacity(65536); // 64 KiB
            let mut flush_interval = tokio::time::interval(Duration::from_millis(8));

            loop {
                let is_paused = tracker_clone.is_paused();

                tokio::select! {
                    _ = tracker_clone.wait_for_resume(), if is_paused => {
                        // 收到恢复信号，继续读取
                    }
                    read_res = stream.read(&mut read_buf), if !is_paused => {
                        match read_res {
                            Ok(0) => {
                                // EOF: 连接正常断开或退出
                                if !batch_buf.is_empty() {
                                    let frame = encode_data_frame(&batch_buf);
                                    let _ = out_tx.send(frame).await;
                                    batch_buf.clear();
                                }
                                event_bus_clone.emit(AppEvent::TerminalNotice {
                                    tab_id: tab_id_clone.clone(),
                                    kind: TerminalNoticeKind::Exit,
                                    value: None,
                                    exit_code: Some(0),
                                    paused: None,
                                    dropped_bytes: None,
                                });
                                break;
                            }
                            Ok(n) => {
                                batch_buf.extend_from_slice(&read_buf[..n]);
                                // 攒够 16 KiB 立即发送
                                if batch_buf.len() >= 16384 {
                                    let frame = encode_data_frame(&batch_buf);
                                    let action = tracker_clone.on_send(batch_buf.len());
                                    match action {
                                        FlowAction::Paused => {
                                            event_bus_clone.emit(AppEvent::TerminalNotice {
                                                tab_id: tab_id_clone.clone(),
                                                kind: TerminalNoticeKind::Flow,
                                                value: None,
                                                exit_code: None,
                                                paused: Some(true),
                                                dropped_bytes: None,
                                            });
                                        }
                                        FlowAction::DropOldest(dropped) => {
                                            event_bus_clone.emit(AppEvent::TerminalNotice {
                                                tab_id: tab_id_clone.clone(),
                                                kind: TerminalNoticeKind::Flow,
                                                value: Some("output buffer truncated".to_string()),
                                                exit_code: None,
                                                paused: None,
                                                dropped_bytes: Some(dropped),
                                            });
                                        }
                                        _ => {}
                                    }
                                    if out_tx.send(frame).await.is_err() {
                                        break;
                                    }
                                    batch_buf.clear();
                                }
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }
                    _ = flush_interval.tick() => {
                        // 距上次 flush ≥ 8 ms
                        if !batch_buf.is_empty() {
                            let frame = encode_data_frame(&batch_buf);
                            let action = tracker_clone.on_send(batch_buf.len());
                            if let FlowAction::Paused = action {
                                event_bus_clone.emit(AppEvent::TerminalNotice {
                                    tab_id: tab_id_clone.clone(),
                                    kind: TerminalNoticeKind::Flow,
                                    value: None,
                                    exit_code: None,
                                    paused: Some(true),
                                    dropped_bytes: None,
                                });
                            }
                            if out_tx.send(frame).await.is_err() {
                                break;
                            }
                            batch_buf.clear();
                        }
                    }
                    Some(user_input) = write_rx.recv() => {
                        if stream.write_all(&user_input).await.is_err() {
                            break;
                        }
                        let _ = stream.flush().await;
                    }
                    Some(size) = resize_rx.recv() => {
                        let _ = stream.resize(size);
                    }
                }
            }
        });

        let active = ActiveTerminal {
            credit_tracker,
            write_tx,
            resize_tx,
            abort_handle: join_handle.abort_handle(),
        };

        self.terminals.write().insert(tab_id, active);
        Ok(())
    }

    /// 向终端写入键盘或粘贴数据。
    pub async fn write(&self, tab_id: &TabId, data: Vec<u8>) -> DomainResult<usize> {
        let tx = {
            let terms = self.terminals.read();
            terms
                .get(tab_id)
                .map(|t| t.write_tx.clone())
                .ok_or_else(|| DomainError::new(ErrorCode::NotFound, "terminal tab not found"))?
        };

        let len = data.len();
        tx.send(data).await.map_err(|_| {
            DomainError::new(ErrorCode::Io, "failed to send data to terminal writer")
        })?;
        Ok(len)
    }

    /// 调整终端窗口大小。
    pub async fn resize(&self, tab_id: &TabId, size: TermSize) -> DomainResult<()> {
        let tx = {
            let terms = self.terminals.read();
            terms
                .get(tab_id)
                .map(|t| t.resize_tx.clone())
                .ok_or_else(|| DomainError::new(ErrorCode::NotFound, "terminal tab not found"))?
        };

        let _ = tx.send(size).await;
        Ok(())
    }

    /// 确认前端已消费字节数（流控反馈）。
    pub fn ack(&self, tab_id: &TabId, bytes: usize) -> DomainResult<i64> {
        let (tracker, tab_id_clone) = {
            let terms = self.terminals.read();
            let term = terms
                .get(tab_id)
                .ok_or_else(|| DomainError::new(ErrorCode::NotFound, "terminal tab not found"))?;
            (term.credit_tracker.clone(), tab_id.clone())
        };

        let action = tracker.on_ack(bytes);
        if let FlowAction::Resumed = action {
            self.event_bus.emit(AppEvent::TerminalNotice {
                tab_id: tab_id_clone,
                kind: TerminalNoticeKind::Flow,
                value: None,
                exit_code: None,
                paused: Some(false),
                dropped_bytes: None,
            });
        }

        Ok(tracker.credit())
    }

    /// 关闭终端标签并终止相关任务。
    pub fn close(&self, tab_id: &TabId) -> DomainResult<()> {
        if let Some(active) = self.terminals.write().remove(tab_id) {
            active.abort_handle.abort();
            Ok(())
        } else {
            Ok(())
        }
    }
}
