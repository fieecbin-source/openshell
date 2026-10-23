use bytes::Bytes;
use openshell_core_domain::{ByteStream, DomainResult, TermSize};
use russh::ChannelMsg;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio::sync::{mpsc, oneshot};

/// 双向字节流适配器：桥接 russh::Channel 与 tokio::io::DuplexStream。
pub struct SshByteStream {
    io: DuplexStream,
    resize_tx: mpsc::Sender<TermSize>,
    close_tx: Option<oneshot::Sender<()>>,
}

impl SshByteStream {
    pub fn new(
        io: DuplexStream,
        resize_tx: mpsc::Sender<TermSize>,
        close_tx: oneshot::Sender<()>,
    ) -> Self {
        Self {
            io,
            resize_tx,
            close_tx: Some(close_tx),
        }
    }
}

impl AsyncRead for SshByteStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshByteStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

impl ByteStream for SshByteStream {
    fn resize(&mut self, size: TermSize) -> DomainResult<()> {
        let _ = self.resize_tx.try_send(size);
        Ok(())
    }

    fn close(mut self: Box<Self>) -> DomainResult<()> {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(());
        }
        Ok(())
    }
}

/// 启动后台管道转发循环，返回连接好的 ByteStream。
pub fn bridge_channel(mut channel: russh::Channel<russh::client::Msg>) -> Box<dyn ByteStream> {
    let (client_io, mut server_io) = tokio::io::duplex(64 * 1024);
    let (resize_tx, mut resize_rx) = mpsc::channel::<TermSize>(16);
    let (close_tx, mut close_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let mut read_buf = vec![0u8; 16 * 1024];

        loop {
            tokio::select! {
                // 1. 用户输入（从 Duplex 读出，发送给远程 SSH 通道）
                n = server_io.read(&mut read_buf) => {
                    match n {
                        Ok(0) => {
                            // 本地写端关闭，向远程发 EOF
                            let _ = channel.eof().await;
                            break;
                        }
                        Ok(cnt) => {
                            let chunk = Bytes::copy_from_slice(&read_buf[..cnt]);
                            if channel.data_bytes(chunk).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }

                // 2. 远端数据（从 SSH 通道读出，写入 Duplex 供前端消费）
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            if server_io.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if server_io.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }

                // 3. 终端尺寸变化
                Some(size) = resize_rx.recv() => {
                    let _ = channel.window_change(
                        size.cols as u32,
                        size.rows as u32,
                        0,
                        0,
                    ).await;
                }

                // 4. 主动关闭请求
                _ = &mut close_rx => {
                    break;
                }
            }
        }

        let _ = channel.close().await;
    });

    Box::new(SshByteStream::new(client_io, resize_tx, close_tx))
}
