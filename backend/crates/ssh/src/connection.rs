use crate::errors::map_russh_error;
use crate::handler::OpenShellClientHandler;
use crate::known_hosts::HostKeyVerifier;
use crate::stream::bridge_channel;
use openshell_core_domain::{
    AuthMethod, ByteStream, ConnectionId, DomainError, DomainResult, ErrorCode, ExecOutput,
    HostKeyPolicy, KnownHostRepository, SessionId, TermSize,
};
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub struct ConnectOptions {
    pub connection_id: ConnectionId,
    pub session_id: SessionId,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub password: Option<String>,
    pub private_key_pem: Option<Vec<u8>>,
    pub private_key_passphrase: Option<String>,
    pub host_key_policy: HostKeyPolicy,
    pub keepalive_sec: u64,
    pub timeout_sec: u64,
}

pub struct SshConnection {
    pub connection_id: ConnectionId,
    pub session_id: SessionId,
    handle: Arc<Mutex<russh::client::Handle<OpenShellClientHandler>>>,
    _keepalive_task: Option<JoinHandle<()>>,
}

impl SshConnection {
    pub async fn connect(
        opts: ConnectOptions,
        known_host_repo: Option<Arc<dyn KnownHostRepository>>,
    ) -> DomainResult<Self> {
        let timeout_dur = Duration::from_secs(opts.timeout_sec.max(5));
        let verifier = Arc::new(HostKeyVerifier::new(
            known_host_repo,
            opts.host_key_policy,
            opts.host.clone(),
            opts.port,
        ));

        let config = Arc::new(russh::client::Config::default());
        let addr = format!("{}:{}", opts.host, opts.port);
        let handler = OpenShellClientHandler::new(verifier);

        // 1. TCP + SSH 协议握手
        let mut handle =
            tokio::time::timeout(timeout_dur, russh::client::connect(config, &addr, handler))
                .await
                .map_err(|_| {
                    DomainError::new(
                        ErrorCode::Timeout,
                        format!("connection to {addr} timed out"),
                    )
                })?
                .map_err(map_russh_error)?;

        // 2. 身份认证
        match opts.auth_method {
            AuthMethod::Password => {
                let pass = opts.password.ok_or_else(|| {
                    DomainError::new(
                        ErrorCode::AuthFailed,
                        "password is required for password auth",
                    )
                })?;
                let res = handle
                    .authenticate_password(&opts.username, pass)
                    .await
                    .map_err(map_russh_error)?;
                if !res.success() {
                    return Err(DomainError::new(
                        ErrorCode::AuthFailed,
                        "password authentication rejected by remote server",
                    ));
                }
            }
            AuthMethod::PublicKey => {
                let pem_bytes = opts.private_key_pem.ok_or_else(|| {
                    DomainError::new(
                        ErrorCode::AuthFailed,
                        "private key is required for publickey auth",
                    )
                })?;
                let pem_str = std::str::from_utf8(&pem_bytes).map_err(|e| {
                    DomainError::new(
                        ErrorCode::Validation,
                        format!("invalid UTF-8 in private key: {e}"),
                    )
                })?;
                let privkey =
                    russh::keys::decode_secret_key(pem_str, opts.private_key_passphrase.as_deref())
                        .map_err(|e| {
                            DomainError::new(
                                ErrorCode::AuthFailed,
                                format!("failed to decode private key (check passphrase): {e}"),
                            )
                        })?;

                let best_hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .unwrap_or(None)
                    .flatten();
                let key_with_hash =
                    russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(privkey), best_hash);
                let res = handle
                    .authenticate_publickey(&opts.username, key_with_hash)
                    .await
                    .map_err(map_russh_error)?;
                if !res.success() {
                    return Err(DomainError::new(
                        ErrorCode::AuthFailed,
                        "public key authentication rejected by remote server",
                    ));
                }
            }
            AuthMethod::KeyboardInteractive => {
                let pass = opts.password.unwrap_or_default();
                let init = handle
                    .authenticate_keyboard_interactive_start(&opts.username, None)
                    .await
                    .map_err(map_russh_error)?;
                match init {
                    russh::client::KeyboardInteractiveAuthResponse::Success => {}
                    russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                        return Err(DomainError::new(
                            ErrorCode::AuthFailed,
                            "keyboard-interactive auth failed at start",
                        ));
                    }
                    russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                        prompts, ..
                    } => {
                        let responses = vec![pass; prompts.len()];
                        let final_res = handle
                            .authenticate_keyboard_interactive_respond(responses)
                            .await
                            .map_err(map_russh_error)?;
                        match final_res {
                            russh::client::KeyboardInteractiveAuthResponse::Success => {}
                            _ => {
                                return Err(DomainError::new(
                                    ErrorCode::AuthFailed,
                                    "keyboard-interactive authentication rejected",
                                ));
                            }
                        }
                    }
                }
            }
            AuthMethod::None => {
                let res = handle
                    .authenticate_none(&opts.username)
                    .await
                    .map_err(map_russh_error)?;
                if !res.success() {
                    return Err(DomainError::new(
                        ErrorCode::AuthFailed,
                        "none authentication rejected by remote server",
                    ));
                }
            }
            AuthMethod::Agent => {
                return Err(DomainError::new(
                    ErrorCode::AuthMethodUnsupported,
                    "ssh-agent authentication not configured",
                ));
            }
        }

        let handle_arc = Arc::new(Mutex::new(handle));

        // 3. Keepalive 保活循环
        let keepalive_task = if opts.keepalive_sec > 0 {
            let handle_clone = Arc::clone(&handle_arc);
            let interval_dur = Duration::from_secs(opts.keepalive_sec);
            Some(tokio::spawn(async move {
                let mut interval = tokio::time::interval(interval_dur);
                interval.tick().await; // 第一拍跳过
                loop {
                    interval.tick().await;
                    let locked = handle_clone.lock().await;
                    if locked.is_closed() {
                        break;
                    }
                    if locked.send_keepalive(false).await.is_err() {
                        tracing::warn!("keepalive failed or disconnected");
                        break;
                    }
                }
            }))
        } else {
            None
        };

        Ok(Self {
            connection_id: opts.connection_id,
            session_id: opts.session_id,
            handle: handle_arc,
            _keepalive_task: keepalive_task,
        })
    }

    pub async fn open_shell(&self, size: TermSize) -> DomainResult<Box<dyn ByteStream>> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(map_russh_error)?;
        channel
            .request_pty(
                false,
                "xterm-256color",
                size.cols as u32,
                size.rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(map_russh_error)?;
        channel.request_shell(true).await.map_err(map_russh_error)?;
        Ok(bridge_channel(channel))
    }

    pub async fn open_exec(&self, cmd: &str) -> DomainResult<ExecOutput> {
        let handle = self.handle.lock().await;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(map_russh_error)?;
        channel.exec(true, cmd).await.map_err(map_russh_error)?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                }
                ChannelMsg::Eof | ChannelMsg::Close => {
                    break;
                }
                _ => {}
            }
        }

        let _ = channel.close().await;

        Ok(ExecOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    pub async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
    ) -> DomainResult<Box<dyn ByteStream>> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await
            .map_err(map_russh_error)?;
        Ok(bridge_channel(channel))
    }

    pub async fn open_sftp(&self) -> DomainResult<Box<dyn ByteStream>> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(map_russh_error)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(map_russh_error)?;
        Ok(bridge_channel(channel))
    }

    pub async fn open_sftp_channel(&self) -> DomainResult<russh::Channel<russh::client::Msg>> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(map_russh_error)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(map_russh_error)?;
        Ok(channel)
    }

    pub async fn close(&self) -> DomainResult<()> {
        let handle = self.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "closed by user", "en")
            .await;
        Ok(())
    }
}
