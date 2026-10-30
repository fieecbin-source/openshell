use crate::errors::map_russh_error;
use crate::handler::OpenShellClientHandler;
use crate::known_hosts::HostKeyVerifier;
use crate::stream::bridge_channel;
use openshell_core_domain::{
    AuthMethod, ByteStream, ConnectionId, DomainError, DomainResult, ErrorCode, ExecOutput,
    HostKeyPolicy, KnownHostRepository, SessionId, TermSize,
};
use russh::client::AuthResult;
use russh::{ChannelMsg, MethodKind, MethodSet};
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
    /// 连续多少次 keepalive 失败后判定连接已失联（默认 3）
    pub keepalive_max_miss: u32,
    pub timeout_sec: u64,
}

pub struct SshConnection {
    pub connection_id: ConnectionId,
    pub session_id: SessionId,
    handle: Arc<Mutex<russh::client::Handle<OpenShellClientHandler>>>,
    /// 连接被判定关闭（远端断开 / 保活失联）时置为 true
    closed_tx: Arc<tokio::sync::watch::Sender<bool>>,
    _health_task: Option<JoinHandle<()>>,
}

impl SshConnection {
    /// 订阅连接关闭信号。
    ///
    /// 上层（连接服务）据此在远端断开 / 保活连续失败时收到通知，
    /// 清理连接表并向界面发送 `ConnectionState::Closed`。
    pub fn closed_channel(&self) -> tokio::sync::watch::Receiver<bool> {
        self.closed_tx.subscribe()
    }

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
        //
        // 注意：russh 的认证调用内部没有任何超时保护。部分服务器（尤其启用 PAM 的
        // macOS / Linux 主机）在密码被拒之后收到 keyboard-interactive 请求时会完全不回包，
        // 客户端只能一直挂到服务器 LoginGraceTime（OpenSSH 默认 120 秒）才断开。
        // 因此这里对每一步认证显式限时，让用户能在十几秒内拿到明确结论。
        const AUTH_STEP_TIMEOUT: Duration = Duration::from_secs(15);
        // 键盘交互回退必须由服务器主动公布，且正常服务器都是秒级响应；
        // 用更短的超时，避免「密码错误」场景下让用户多等。
        const KBD_STEP_TIMEOUT: Duration = Duration::from_secs(10);

        match opts.auth_method {
            AuthMethod::Password => {
                let pass = opts.password.ok_or_else(|| {
                    DomainError::new(ErrorCode::AuthFailed, "密码认证需要提供登录密码")
                })?;

                // 2.1 标准 SSH 密码认证
                let mut remaining_methods: Option<MethodSet> = None;
                let mut authenticated = false;
                match tokio::time::timeout(
                    AUTH_STEP_TIMEOUT,
                    handle.authenticate_password(&opts.username, &pass),
                )
                .await
                {
                    Err(_) => {
                        return Err(DomainError::new(
                            ErrorCode::Timeout,
                            format!(
                                "服务器 {addr} 在 {} 秒内没有响应密码认证请求，已中止本次连接。请检查服务器负载与网络稳定性。",
                                AUTH_STEP_TIMEOUT.as_secs()
                            ),
                        ))
                    }
                    Ok(Ok(AuthResult::Success)) => authenticated = true,
                    Ok(Ok(AuthResult::Failure {
                        remaining_methods: m,
                        ..
                    })) => remaining_methods = Some(m),
                    Ok(Err(e)) => return Err(map_russh_error(e)),
                }

                // 2.2 标准密码认证未成功时，仅在服务器确实公布 keyboard-interactive 时回退
                //     （兼容大量开启 PAM / 挑战应答的 Linux、macOS 主机）
                //     注意：回退超时不立即返回，而是记下原因后统一给出结论，
                //     这样错误文案里能同时包含「密码被拒」与后续线索。
                let mut kbd_note: Option<String> = None;
                if !authenticated {
                    let kbd_supported = remaining_methods
                        .as_ref()
                        .map(|m| m.contains(&MethodKind::KeyboardInteractive))
                        .unwrap_or(false);

                    if kbd_supported {
                        match tokio::time::timeout(
                            KBD_STEP_TIMEOUT,
                            handle.authenticate_keyboard_interactive_start(&opts.username, None),
                        )
                        .await
                        {
                            Err(_) => {
                                kbd_note = Some(format!(
                                    "随后尝试键盘交互认证时，服务器在 {} 秒内没有任何响应，已中止本次尝试。",
                                    KBD_STEP_TIMEOUT.as_secs()
                                ));
                            }
                            Ok(Err(e)) => return Err(map_russh_error(e)),
                            Ok(Ok(
                                russh::client::KeyboardInteractiveAuthResponse::Success,
                            )) => authenticated = true,
                            Ok(Ok(russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                                prompts,
                                ..
                            })) => {
                                let responses = vec![pass.clone(); prompts.len()];
                                match tokio::time::timeout(
                                    KBD_STEP_TIMEOUT,
                                    handle.authenticate_keyboard_interactive_respond(responses),
                                )
                                .await
                                {
                                    Err(_) => {
                                        kbd_note = Some(format!(
                                            "服务器要求键盘交互认证，但在 {} 秒内没有给出认证结果，已中止本次尝试。",
                                            KBD_STEP_TIMEOUT.as_secs()
                                        ));
                                    }
                                    Ok(Err(e)) => return Err(map_russh_error(e)),
                                    Ok(Ok(
                                        russh::client::KeyboardInteractiveAuthResponse::Success,
                                    )) => authenticated = true,
                                    Ok(Ok(_)) => {}
                                }
                            }
                            Ok(Ok(
                                russh::client::KeyboardInteractiveAuthResponse::Failure { .. },
                            )) => {}
                        }
                    }
                }

                if !authenticated {
                    let mut message =
                        String::from("密码认证被远端服务器拒绝，请核对用户名与密码是否正确。");
                    if let Some(m) = remaining_methods.as_ref() {
                        if !m.contains(&MethodKind::Password)
                            && !m.contains(&MethodKind::KeyboardInteractive)
                        {
                            message = format!(
                                "远端服务器未开放密码登录（服务器公布的认证方式：{}），请在服务器上启用密码认证或改用其他认证方式。",
                                describe_methods(m)
                            );
                        }
                    }
                    if let Some(note) = kbd_note {
                        message.push(' ');
                        message.push_str(&note);
                    }
                    if opts.username == "root" {
                        message.push_str(
                            " 提示：macOS 默认 PermitRootLogin 为 prohibit-password，root 账号不能直接用密码登录；请改用普通账号，或在服务器 sshd_config 中放开 root 密码登录。",
                        );
                    }
                    return Err(DomainError::new(ErrorCode::AuthFailed, message));
                }
            }
            AuthMethod::PublicKey => {
                let pem_bytes = opts.private_key_pem.ok_or_else(|| {
                    DomainError::new(ErrorCode::AuthFailed, "公钥认证需要提供有效私钥")
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
                let best_hash = match tokio::time::timeout(
                    AUTH_STEP_TIMEOUT,
                    handle.best_supported_rsa_hash(),
                )
                .await
                {
                    // 查询失败或超时不应阻断认证，后续按未公布处理即可
                    Ok(Ok(v)) => v.flatten(),
                    _ => None,
                };
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
                    match tokio::time::timeout(
                        AUTH_STEP_TIMEOUT,
                        handle.authenticate_publickey(&opts.username, key_with_hash),
                    )
                    .await
                    {
                        Err(_) => {
                            last_err = Some(DomainError::new(
                                ErrorCode::Timeout,
                                format!(
                                    "服务器 {addr} 在 {} 秒内没有响应公钥认证，已中止本次连接。",
                                    AUTH_STEP_TIMEOUT.as_secs()
                                ),
                            ));
                            break;
                        }
                        Ok(Ok(res)) if res.success() => {
                            authenticated = true;
                            break;
                        }
                        Ok(Ok(_)) => {}
                        Ok(Err(e)) => last_err = Some(map_russh_error(e)),
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
                let init = match tokio::time::timeout(
                    KBD_STEP_TIMEOUT,
                    handle.authenticate_keyboard_interactive_start(&opts.username, None),
                )
                .await
                {
                    Err(_) => {
                        return Err(DomainError::new(
                            ErrorCode::Timeout,
                            format!(
                                "服务器 {addr} 在 {} 秒内没有响应键盘交互认证，已中止本次连接。",
                                KBD_STEP_TIMEOUT.as_secs()
                            ),
                        ))
                    }
                    Ok(res) => res.map_err(map_russh_error)?,
                };
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
                        let final_res = match tokio::time::timeout(
                            KBD_STEP_TIMEOUT,
                            handle.authenticate_keyboard_interactive_respond(responses),
                        )
                        .await
                        {
                            Err(_) => {
                                return Err(DomainError::new(
                                    ErrorCode::Timeout,
                                    format!(
                                        "服务器要求键盘交互认证，但在 {} 秒内没有给出认证结果，已中止本次连接。",
                                        KBD_STEP_TIMEOUT.as_secs()
                                    ),
                                ))
                            }
                            Ok(res) => res.map_err(map_russh_error)?,
                        };
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
                let res = match tokio::time::timeout(
                    AUTH_STEP_TIMEOUT,
                    handle.authenticate_none(&opts.username),
                )
                .await
                {
                    Err(_) => {
                        return Err(DomainError::new(
                            ErrorCode::Timeout,
                            format!(
                                "服务器 {addr} 在 {} 秒内没有响应免密登录请求，已中止本次连接。",
                                AUTH_STEP_TIMEOUT.as_secs()
                            ),
                        ))
                    }
                    Ok(res) => res.map_err(map_russh_error)?,
                };
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

        // 3. 连接健康监视 + KeepAlive
        //
        // 历史实现只在 keepalive_sec > 0 时启动任务，单次失败就退出，且
        // `keepalive_max_miss` 完全没被使用；更关键的是任务退出后没有任何人知道，
        // 界面会一直显示「已连接」，实际早已哑死。
        //
        // 现在的行为：
        //  - 即使关闭 keepalive，也每 30 秒轮询 `is_closed()` 做断线探测；
        //  - 连续 keepalive 失败达到 `keepalive_max_miss` 才判定失联（容忍偶发丢包）；
        //  - 任务结束时通过 watch 通道广播「连接已关闭」，由连接服务发事件并清表。
        let (closed_tx, _closed_rx) = tokio::sync::watch::channel(false);
        let closed_tx = Arc::new(closed_tx);
        let health_handle = {
            let handle_clone = Arc::clone(&handle_arc);
            let closed_tx = Arc::clone(&closed_tx);
            let keepalive_sec = opts.keepalive_sec;
            let max_miss = opts.keepalive_max_miss.max(1);
            tokio::spawn(async move {
                let check_secs = if keepalive_sec > 0 { keepalive_sec } else { 30 };
                let mut interval = tokio::time::interval(Duration::from_secs(check_secs));
                interval.tick().await; // 第一拍跳过
                let mut misses: u32 = 0;
                loop {
                    interval.tick().await;
                    let lost = {
                        let locked = handle_clone.lock().await;
                        if locked.is_closed() {
                            true
                        } else if keepalive_sec > 0 {
                            match locked.send_keepalive(false).await {
                                Ok(()) => {
                                    misses = 0;
                                    false
                                }
                                Err(err) => {
                                    misses = misses.saturating_add(1);
                                    tracing::warn!(
                                        misses,
                                        max_miss,
                                        error = %err,
                                        "ssh keepalive failed"
                                    );
                                    misses >= max_miss
                                }
                            }
                        } else {
                            false
                        }
                    };
                    if lost {
                        break;
                    }
                }
                // watch 会保存最后一次值，订阅者即使晚于此处订阅也不会漏掉通知
                let _ = closed_tx.send(true);
            })
        };

        Ok(Self {
            connection_id: opts.connection_id,
            session_id: opts.session_id,
            handle: handle_arc,
            closed_tx,
            _health_task: Some(health_handle),
        })
    }

    pub async fn open_shell(&self, size: TermSize) -> DomainResult<Box<dyn ByteStream>> {
        let handle = self.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(map_russh_error)?;
        // want_reply = true：让 PTY 请求的成败可见。
        // 旧实现传 false，服务器拒绝 PTY（例如 sshd 关闭了 tty 分配）时被静默忽略，
        // 之后终端表现为「能输入但没有任何回显」，极难排查。
        channel
            .request_pty(
                true,
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
        // 只在「打开通道 + 发送 exec 请求」期间持有连接锁。
        //
        // 旧实现把整条命令的执行循环都包在锁里：一条长命令（服务器监控采集、
        // 用户自定义脚本）执行期间，同连接的新终端、SFTP 通道、keepalive 心跳
        // 甚至 connection_close 都会被阻塞，最长可达数十秒。
        let mut channel = {
            let handle = self.handle.lock().await;
            // 内层不需要 mut：exec 之后才在锁外消费通道
            let channel = handle
                .channel_open_session()
                .await
                .map_err(map_russh_error)?;
            channel.exec(true, cmd).await.map_err(map_russh_error)?;
            channel
        };

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut eof_seen = false;

        loop {
            // 收到 Eof 后不能立刻 break：exit-status 是独立的 channel request，
            // 部分 sshd 会把它排在 Eof 之后。旧实现在 Eof 处直接跳出循环，
            // 导致 exit_code 恒为 None（前端据此判定命令失败，把正常输出当报错）。
            // 这里在 Eof 之后再做一次短超时等待，专门捞取迟到的 ExitStatus。
            let next = if eof_seen {
                match tokio::time::timeout(Duration::from_millis(300), channel.wait()).await {
                    Ok(msg) => msg,
                    Err(_) => break,
                }
            } else {
                channel.wait().await
            };

            let Some(msg) = next else { break };
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
                ChannelMsg::Eof => {
                    eof_seen = true;
                }
                ChannelMsg::Close => {
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

/// 把服务器公布的认证方式列表转成可读文本，用于认证失败时的提示。
fn describe_methods(methods: &MethodSet) -> String {
    methods
        .iter()
        .map(|m| <&'static str>::from(m))
        .collect::<Vec<_>>()
        .join(", ")
}
