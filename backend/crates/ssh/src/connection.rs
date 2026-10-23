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
        let timeout_dur = Duration::from_secs(opts.timeout_sec.max(30));
        let host_clean = opts.host.trim().to_string();
        let verifier = Arc::new(HostKeyVerifier::new(
            known_host_repo,
            opts.host_key_policy,
            host_clean.clone(),
            opts.port,
        ));

        let config = Arc::new(russh::client::Config::default());
        let addr = format!("{}:{}", host_clean, opts.port);
        let handler = OpenShellClientHandler::new(verifier);
        // 主机密钥校验发生在握手阶段，russh 只返回通用错误；通过共享槽位把具体原因取回来。
        let host_key_error = handler.host_key_error_slot();

        // 1. TCP + SSH 协议握手
        let mut handle =
            match tokio::time::timeout(timeout_dur, russh::client::connect(config, &addr, handler))
                .await
            {
                Err(_) => {
                    return Err(DomainError::new(
                        ErrorCode::Timeout,
                        format!("连接到服务器 {addr} 超时，请检查目标 IP/端口可达性以及防火墙设置"),
                    ))
                }
                Ok(Ok(handle)) => handle,
                Ok(Err(err)) => {
                    if let Some(host_key_err) = host_key_error.lock().ok().and_then(|g| g.clone()) {
                        return Err(host_key_err);
                    }
                    return Err(map_russh_error(err));
                }
            };

        // 2. 身份认证
        match opts.auth_method {
            AuthMethod::Password => {
                let pass = opts.password.ok_or_else(|| {
                    DomainError::new(
                        ErrorCode::AuthFailed,
                        "密码认证需要提供登录密码",
                    )
                })?;
                let mut authenticated = false;
                // 首先尝试标准 SSH 密码认证
                if let Ok(res) = handle.authenticate_password(&opts.username, &pass).await {
                    if res.success() {
                        authenticated = true;
                    }
                }

                // 若标准密码认证未成功，尝试 Keyboard-Interactive 回退认证（兼容大量开启 PAM/挑战应答的 Linux 主机）
                if !authenticated {
                    if let Ok(init) = handle
                        .authenticate_keyboard_interactive_start(&opts.username, None)
                        .await
                    {
                        match init {
                            russh::client::KeyboardInteractiveAuthResponse::Success => {
                                authenticated = true;
                            }
                            russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                                prompts,
                                ..
                            } => {
                                let responses = vec![pass.clone(); prompts.len()];
                                if let Ok(russh::client::KeyboardInteractiveAuthResponse::Success) =
                                    handle.authenticate_keyboard_interactive_respond(responses).await
                                {
                                    authenticated = true;
                                }
                            }
                            _ => {}
                        }
                    }
                }

                if !authenticated {
                    return Err(DomainError::new(
                        ErrorCode::AuthFailed,
                        "密码认证被远端服务器拒绝，请核对用户名与密码是否正确",
                    ));
                }
            }
            AuthMethod::PublicKey => {
                let pem_bytes = opts.private_key_pem.ok_or_else(|| {
                    DomainError::new(
                        ErrorCode::AuthFailed,
                        "公钥认证需要提供有效私钥",
                    )
                })?;
                let pem_str = std::str::from_utf8(&pem_bytes).map_err(|e| {
                    DomainError::new(
                        ErrorCode::Validation,
                        format!("私钥文件包含无效 UTF-8 字符: {e}"),
                    )
                })?;
                let clean_pem = pem_str.trim().replace("\r\n", "\n").replace('\r', "\n");
                let privkey = russh::keys::decode_secret_key(
                    &clean_pem,
                    opts.private_key_passphrase.as_deref(),
                )
                .map_err(|e| {
                    let err_str = e.to_string().to_lowercase();
                    let has_passphrase = opts
                        .private_key_passphrase
                        .as_deref()
                        .map(|p| !p.is_empty())
                        .unwrap_or(false);
                    let unreadable = err_str.contains("could not read key")
                        || err_str.contains("unsupported key type");
                    if !unreadable
                        && (has_passphrase
                            || err_str.contains("encrypted")
                            || clean_pem.contains("ENCRYPTED")
                            || clean_pem.contains("bcrypt")
                            || clean_pem.contains("aes256"))
                    {
                        if has_passphrase {
                            DomainError::new(
                                ErrorCode::AuthFailed,
                                "私钥口令不正确，无法解密该私钥。请在「私钥管理」中重新设置正确的口令后重试。",
                            )
                        } else {
                            DomainError::new(
                                ErrorCode::AuthFailed,
                                "该私钥已加密，需要正确的私钥口令 (Passphrase)。请在「私钥管理」中为该私钥设置口令后重试。",
                            )
                        }
                    } else {
                        DomainError::new(
                            ErrorCode::AuthFailed,
                            "无法读取该私钥，请在「私钥管理」中重新导入正确的私钥文件（OpenSSH 或 PEM 格式）。",
                        )
                    }
                })?;

                // 按服务器实际公布的 server-sig-algs 协商签名哈希：
                // - Some(Some(alg))：服务器支持 SHA-2，使用返回的算法；
                // - None：服务器未公布（多为旧版 OpenSSH），走 ssh-rsa/SHA-1 兼容路径。
                // 不能强行指定 Sha256，否则仅支持 ssh-rsa 的旧服务器会直接拒绝认证。
                let best_hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
                let key = Arc::new(privkey);
                let is_rsa = key.algorithm().is_rsa();

                // 部分服务器虽然公布了 rsa-sha2-* 算法，但 sshd 实际只允许 ssh-rsa(SHA-1)；
                // 若首轮失败，再补一次 SHA-1 兼容尝试，避免用户被迫手动改服务器配置。
                let mut hashes = vec![best_hash];
                if is_rsa && best_hash.is_some() {
                    hashes.push(None);
                }

                let mut last_err: Option<DomainError> = None;
                let mut authenticated = false;
                for hash in hashes {
                    let key_with_hash =
                        russh::keys::key::PrivateKeyWithHashAlg::new(Arc::clone(&key), hash);
                    match handle
                        .authenticate_publickey(&opts.username, key_with_hash)
                        .await
                    {
                        Ok(res) if res.success() => {
                            authenticated = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(e) => last_err = Some(map_russh_error(e)),
                    }
                }

                if !authenticated {
                    if let Some(e) = last_err {
                        return Err(e);
                    }
                    return Err(DomainError::new(
                        ErrorCode::AuthFailed,
                        "公钥认证被远端服务器拒绝：请确认该私钥对应的公钥已添加至服务器 ~/.ssh/authorized_keys 中，且服务器 .ssh 目录权限为 700、authorized_keys 文件权限为 600",
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
                            "键盘交互认证握手失败",
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
                                    "键盘交互认证被远端服务器拒绝",
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
                        "服务器拒绝免密登录 (None Auth)，请配置密码或私钥认证",
                    ));
                }
            }
            AuthMethod::Agent => {
                return Err(DomainError::new(
                    ErrorCode::AuthMethodUnsupported,
                    "尚未配置本地 SSH-Agent 转发代理",
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
