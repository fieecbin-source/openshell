use super::*;
use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, Status, StatusCode};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::{AsyncSeekExt, SeekFrom};
use tokio::net::{TcpListener, TcpStream};

// A real loopback SFTP endpoint backed by isolated files; no SSH authentication is exercised here.
struct FileServer {
    file: PathBuf,
    open_gate: Option<Arc<(tokio::sync::Notify, tokio::sync::Notify)>>,
    extra_size: u64,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for FileServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn open(
        &mut self,
        id: u32,
        _: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        if let Some(gate) = &self.open_gate {
            gate.0.notify_one();
            gate.1.notified().await;
        }
        if flags.contains(OpenFlags::TRUNCATE) {
            tokio::fs::write(&self.file, [])
                .await
                .map_err(|_| StatusCode::Failure)?;
        }
        Ok(Handle {
            id,
            handle: "file".into(),
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(ok(id))
    }
    async fn stat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        let size = tokio::fs::metadata(&self.file)
            .await
            .map_err(|_| StatusCode::NoSuchFile)?
            .len();
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(size + self.extra_size),
                ..Default::default()
            },
        })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        self.stat(id, handle).await
    }
    async fn read(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let mut file = tokio::fs::File::open(&self.file)
            .await
            .map_err(|_| StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|_| StatusCode::Failure)?;
        let mut data = vec![0; len as usize];
        let n = file
            .read(&mut data)
            .await
            .map_err(|_| StatusCode::Failure)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&self.file)
            .await
            .map_err(|_| StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|_| StatusCode::Failure)?;
        file.write_all(&data)
            .await
            .map_err(|_| StatusCode::Failure)?;
        file.flush().await.map_err(|_| StatusCode::Failure)?;
        Ok(ok(id))
    }
}

async fn endpoint(file: PathBuf) -> (Arc<SftpClient>, tokio::task::JoinHandle<()>) {
    endpoint_with(FileServer {
        file,
        open_gate: None,
        extra_size: 0,
    })
    .await
}

async fn endpoint_with(handler: FileServer) -> (Arc<SftpClient>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let task = tokio::spawn(russh_sftp::server::run(server, handler));
    let client = SftpClient::new(russh_sftp::client::SftpSession::new(socket).await.unwrap());
    (Arc::new(client), task)
}

async fn finished(tm: &TransferManager, id: &str) -> TransferTask {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let task = tm.get(id).await.unwrap();
            if matches!(
                task.state,
                TransferState::Completed | TransferState::Cancelled | TransferState::Failed
            ) {
                return task;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("transfer terminated")
}

#[tokio::test]
async fn new_tasks_overwrite_equal_short_long_and_empty_files_in_both_directions() {
    let dir = std::env::temp_dir().join(format!("openshell-transfer-{}", new_id()));
    tokio::fs::create_dir(&dir).await.unwrap();
    for resume in [true, false] {
        for upload in [true, false] {
            for (source, target) in [
                (b"BBBB".as_slice(), b"AAAA".as_slice()),
                (b"BBBB", b"A"),
                (b"BBBB", b"AAAAAA"),
                (b"", b"AAAA"),
            ] {
                let local = dir.join("local");
                let remote = dir.join("remote");
                tokio::fs::write(&local, if upload { source } else { target })
                    .await
                    .unwrap();
                tokio::fs::write(&remote, if upload { target } else { source })
                    .await
                    .unwrap();
                let (client, server) = endpoint(remote.clone()).await;
                let tm = TransferManager::new(1);
                let local_path = local.to_str().unwrap().to_owned();
                let id = if upload {
                    tm.start_upload(
                        SessionId::new(),
                        local_path,
                        "/file".into(),
                        resume,
                        client.clone(),
                    )
                    .await
                    .unwrap()
                } else {
                    tm.start_download(
                        SessionId::new(),
                        "/file".into(),
                        local_path,
                        resume,
                        client.clone(),
                    )
                    .await
                    .unwrap()
                };
                let task = finished(&tm, &id).await;
                assert_eq!(task.state, TransferState::Completed, "{task:?}");
                let actual = tokio::fs::read(if upload { &remote } else { &local })
                    .await
                    .unwrap();
                assert_eq!(
                    actual.len(),
                    source.len(),
                    "upload={upload}, resume={resume}"
                );
                assert_eq!(
                    Sha256::digest(&actual),
                    Sha256::digest(source),
                    "upload={upload}, resume={resume}"
                );
                assert_eq!(actual, source, "upload={upload}, resume={resume}");
                client.session().close().await.unwrap();
                server.abort();
            }
        }
    }
    tokio::fs::remove_dir_all(&dir).await.unwrap();
}

fn task(state: TransferState) -> ActiveTransfer {
    ActiveTransfer {
        task: TransferTask {
            id: "test".into(),
            session_id: SessionId::new(),
            direction: TransferDirection::Upload,
            local_path: String::new(),
            remote_path: String::new(),
            total_bytes: 4,
            transferred_bytes: 4,
            speed_bps: 0,
            state,
            error_message: None,
            created_at: 0,
            updated_at: 0,
        },
        cancelled: Arc::new(AtomicBool::new(false)),
        paused: Arc::new(AtomicBool::new(false)),
        current_speed: Arc::new(AtomicU64::new(0)),
    }
}

#[tokio::test]
async fn terminal_tasks_cannot_be_paused_or_cancelled() {
    let tm = TransferManager::new(1);
    for state in [
        TransferState::Completed,
        TransferState::Failed,
        TransferState::Cancelled,
    ] {
        tm.tasks
            .write()
            .await
            .insert("test".into(), task(state.clone()));
        assert!(tm.pause("test").await.is_err(), "pause changed {state:?}");
        assert_eq!(tm.get("test").await.unwrap().state, state);
        assert!(tm.cancel("test").await.is_err(), "cancel changed {state:?}");
        assert!(tm.resume("test").await.is_err(), "resume changed {state:?}");
    }
}

#[tokio::test]
async fn short_source_fails_instead_of_claiming_completion() {
    let dir = std::env::temp_dir().join(format!("openshell-short-transfer-{}", new_id()));
    tokio::fs::create_dir(&dir).await.unwrap();
    let remote = dir.join("remote");
    tokio::fs::write(&remote, b"data").await.unwrap();
    let (client, server) = endpoint_with(FileServer {
        file: remote,
        open_gate: None,
        extra_size: 1,
    })
    .await;
    let tm = TransferManager::new(1);
    let id = tm
        .start_download(
            SessionId::new(),
            "/file".into(),
            dir.join("local").to_str().unwrap().into(),
            false,
            client.clone(),
        )
        .await
        .unwrap();
    let task = finished(&tm, &id).await;
    assert_eq!(task.state, TransferState::Failed, "{task:?}");
    assert!(task.error_message.unwrap().contains("EOF"));
    client.session().close().await.unwrap();
    server.abort();
    tokio::fs::remove_dir_all(dir).await.unwrap();
}

#[tokio::test]
async fn paused_transfers_resume_same_task_in_both_directions() {
    let dir = std::env::temp_dir().join(format!("openshell-pause-transfer-{}", new_id()));
    tokio::fs::create_dir(&dir).await.unwrap();
    let source: Vec<u8> = (0..(IO_BUFFER_SIZE + CHUNK_SIZE + 7))
        .map(|i| (i % 251) as u8)
        .collect();
    for upload in [true, false] {
        let local = dir.join("local");
        let remote = dir.join("remote");
        tokio::fs::write(&local, if upload { source.as_slice() } else { b"old" })
            .await
            .unwrap();
        tokio::fs::write(&remote, if upload { b"old" } else { source.as_slice() })
            .await
            .unwrap();
        let gate = Arc::new((tokio::sync::Notify::new(), tokio::sync::Notify::new()));
        let (client, server) = endpoint_with(FileServer {
            file: remote.clone(),
            open_gate: Some(gate.clone()),
            extra_size: 0,
        })
        .await;
        let tm = TransferManager::new(1);
        let local_path = local.to_str().unwrap().to_owned();
        let id = if upload {
            tm.start_upload(
                SessionId::new(),
                local_path,
                "/file".into(),
                false,
                client.clone(),
            )
            .await
            .unwrap()
        } else {
            tm.start_download(
                SessionId::new(),
                "/file".into(),
                local_path,
                false,
                client.clone(),
            )
            .await
            .unwrap()
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), gate.0.notified())
            .await
            .unwrap();
        tm.pause(&id).await.unwrap();
        gate.1.notify_one();
        assert_eq!(tm.get(&id).await.unwrap().state, TransferState::Paused);
        tm.resume(&id).await.unwrap();
        let task = finished(&tm, &id).await;
        assert_eq!(task.id, id);
        assert_eq!(task.state, TransferState::Completed, "{task:?}");
        assert_eq!(tm.list().await.len(), 1);
        assert_eq!(
            tokio::fs::read(if upload { &remote } else { &local })
                .await
                .unwrap(),
            source
        );
        client.session().close().await.unwrap();
        server.abort();
    }
    tokio::fs::remove_dir_all(dir).await.unwrap();
}

#[tokio::test]
async fn cancelling_a_paused_task_exits_its_wait_and_cannot_complete() {
    let tm = TransferManager::new(1);
    let active = task(TransferState::Running);
    let cancelled = active.cancelled.clone();
    let paused = active.paused.clone();
    tm.tasks.write().await.insert("test".into(), active);
    tm.pause("test").await.unwrap();
    let waiter = tokio::spawn(async move { wait_until_running(&cancelled, &paused).await });
    tm.cancel("test").await.unwrap();
    assert!(
        !tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
    );
    let mut tasks = tm.tasks.write().await;
    let active = tasks.get_mut("test").unwrap();
    finish_transfer(active, Ok(()));
    assert_eq!(active.task.state, TransferState::Cancelled);
}
