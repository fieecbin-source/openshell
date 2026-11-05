//! 本地管道终端与 Telnet 的字节流适配。
use openshell_core_domain::{ByteStream, DomainError, DomainResult, TermSize};
use serde::Deserialize;
use std::{
    collections::HashMap,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};

pub struct RuntimeStream {
    io: DuplexStream,
    task: tokio::task::AbortHandle,
}
impl Drop for RuntimeStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl AsyncRead for RuntimeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}
impl AsyncWrite for RuntimeStream {
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
impl ByteStream for RuntimeStream {
    // 管道进程没有 PTY 尺寸；Telnet 当前拒绝 NAWS 协商。
    fn resize(&mut self, _size: TermSize) -> DomainResult<()> {
        Ok(())
    }
    fn close(self: Box<Self>) -> DomainResult<()> {
        Ok(())
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ShellConfig {
    pub shell_kind: Option<String>,
    pub shell_path: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Default)]
struct LineInput {
    line: Vec<u8>,
    after_cr: bool,
}
impl LineInput {
    fn consume(&mut self, data: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut input = Vec::new();
        let mut echo = Vec::new();
        for &b in data {
            if b == b'\n' && self.after_cr {
                self.after_cr = false;
                continue;
            }
            self.after_cr = b == b'\r';
            match b {
                b'\r' | b'\n' => {
                    input.append(&mut self.line);
                    input.extend_from_slice(if cfg!(windows) { b"\r\n" } else { b"\n" });
                    echo.extend_from_slice(b"\r\n");
                }
                8 | 127 => {
                    if !self.line.is_empty() {
                        let mut start = self.line.len() - 1;
                        while start > 0 && self.line[start] & 0xc0 == 0x80 {
                            start -= 1;
                        }
                        self.line.truncate(start);
                        echo.extend_from_slice(b"\x08 \x08");
                    }
                }
                3 => {
                    self.line.clear();
                    echo.extend_from_slice(b"^C\r\n");
                }
                _ => {
                    self.line.push(b);
                    echo.push(b);
                }
            }
        }
        (input, echo)
    }
}

pub async fn open_shell(
    config: ShellConfig,
    working_dir: Option<String>,
    startup: Option<String>,
) -> DomainResult<Box<dyn ByteStream>> {
    let kind = config.shell_kind.as_deref().unwrap_or(if cfg!(windows) {
        "powershell"
    } else {
        "default"
    });
    let program = match kind {
        "custom" => config
            .shell_path
            .clone()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| DomainError::validation("自定义 Shell 路径不能为空"))?,
        "powershell" => "powershell.exe".into(),
        "pwsh" => "pwsh.exe".into(),
        "cmd" => "cmd.exe".into(),
        "wsl" => "wsl.exe".into(),
        "bash" => {
            if cfg!(windows) {
                "bash.exe".into()
            } else {
                "/bin/bash".into()
            }
        }
        "zsh" => "/bin/zsh".into(),
        "default" => std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()),
        _ => return Err(DomainError::validation("不支持的本地 Shell 类型")),
    };
    // cmd.exe 也会解析 argv[0]；正斜杠路径会被它误当作命令行选项。
    #[cfg(windows)]
    let program = program.replace('/', "\\");
    let mut command = tokio::process::Command::new(program);
    if kind == "powershell" || kind == "pwsh" {
        command.args(["-NoLogo", "-NoExit", "-Command", "-"]);
    }
    if kind == "cmd" {
        command.arg("/Q");
    }
    command
        .args(config.args)
        .envs(config.env)
        .env("TERM", "xterm-256color");
    if let Some(dir) = working_dir
        .filter(|p| !p.is_empty())
        .or_else(|| std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok())
    {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| DomainError::internal("缺少 Shell 输入管道"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| DomainError::internal("缺少 Shell 输出管道"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| DomainError::internal("缺少 Shell 错误管道"))?;
    if let Some(startup) = startup.filter(|p| !p.trim().is_empty()) {
        let startup = startup.replace("\r\n", "\n").replace('\r', "\n");
        let startup = format!("{}\n", startup.trim_end_matches('\n'));
        let startup = if cfg!(windows) {
            startup.replace('\n', "\r\n")
        } else {
            startup
        };
        stdin.write_all(startup.as_bytes()).await?;
        stdin.flush().await?;
    }
    let (io, mut bridge) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move {
        let mut input = LineInput::default();
        let mut user = vec![0; 16384];
        let mut out = vec![0; 16384];
        let mut err = vec![0; 16384];
        let mut stdout_open = true;
        let mut stderr_open = true;
        loop {
            tokio::select! {
                result = bridge.read(&mut user) => match result {
                    Ok(0) | Err(_) => break,
                    Ok(n) => { let (data, echo) = input.consume(&user[..n]); if bridge.write_all(&echo).await.is_err() || stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() { break; } }
                },
                result = stdout.read(&mut out), if stdout_open => match result { Ok(0) | Err(_) => stdout_open = false, Ok(n) => if bridge.write_all(&out[..n]).await.is_err() { break; } },
                result = stderr.read(&mut err), if stderr_open => match result { Ok(0) | Err(_) => stderr_open = false, Ok(n) => if bridge.write_all(&err[..n]).await.is_err() { break; } },
            }
            if !stdout_open && !stderr_open {
                break;
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    });
    Ok(Box::new(RuntimeStream {
        io,
        task: task.abort_handle(),
    }))
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct TelnetConfig {
    login_prompt: Option<String>,
    password_prompt: Option<String>,
    auto_login: bool,
    newline_mode: Option<String>,
    local_echo: bool,
}
#[derive(Default)]
struct IacParser {
    state: u8,
    command: u8,
}
impl IacParser {
    fn consume(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut text = Vec::new();
        let mut reply = Vec::new();
        for &b in bytes {
            match self.state {
                0 if b == 255 => self.state = 1,
                0 => text.push(b),
                1 => match b {
                    255 => {
                        text.push(255);
                        self.state = 0;
                    }
                    251..=254 => {
                        self.command = b;
                        self.state = 2;
                    }
                    250 => self.state = 3,
                    _ => self.state = 0,
                },
                2 => {
                    if self.command == 253 {
                        reply.extend_from_slice(&[255, 252, b]);
                    } else if self.command == 251 {
                        reply.extend_from_slice(&[255, 254, b]);
                    }
                    self.state = 0;
                }
                3 if b == 255 => self.state = 4,
                3 => {}
                4 => self.state = if b == 240 { 0 } else { 3 },
                _ => self.state = 0,
            }
        }
        (text, reply)
    }
}
fn telnet_input(data: &[u8], mode: &str, after_cr: &mut bool) -> Vec<u8> {
    let mut out = Vec::new();
    for &b in data {
        if b == b'\n' && *after_cr {
            *after_cr = false;
            continue;
        }
        *after_cr = b == b'\r';
        match b {
            b'\r' | b'\n' => out.extend_from_slice(match mode {
                "lf" => b"\n",
                "cr" => b"\r",
                _ => b"\r\n",
            }),
            255 => out.extend_from_slice(&[255, 255]),
            _ => out.push(b),
        }
    }
    out
}

pub fn open_telnet(
    mut socket: tokio::net::TcpStream,
    config: TelnetConfig,
    username: Option<String>,
    password: Option<zeroize::Zeroizing<String>>,
) -> Box<dyn ByteStream> {
    let (io, mut bridge) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move {
        let mut parser = IacParser::default();
        let mut after_cr = false;
        let mut user = vec![0; 16384];
        let mut remote = vec![0; 16384];
        let mut prompt = String::new();
        let mut sent_user = false;
        let mut sent_password = false;
        loop {
            tokio::select! {
                result = bridge.read(&mut user) => match result {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = telnet_input(&user[..n], config.newline_mode.as_deref().unwrap_or("crlf"), &mut after_cr);
                        if socket.write_all(&data).await.is_err() { break; }
                        if config.local_echo && bridge.write_all(&user[..n]).await.is_err() { break; }
                    }
                },
                result = socket.read(&mut remote) => match result {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let (text, reply) = parser.consume(&remote[..n]);
                        if socket.write_all(&reply).await.is_err() || bridge.write_all(&text).await.is_err() { break; }
                        if config.auto_login {
                            prompt.push_str(&String::from_utf8_lossy(&text).to_lowercase());
                            let login = config.login_prompt.as_deref().unwrap_or("login:").to_lowercase();
                            let pass = config.password_prompt.as_deref().unwrap_or("password:").to_lowercase();
                            let secret = if !sent_user && !login.is_empty() && prompt.contains(&login) { sent_user=true; username.as_deref() }
                                else if !sent_password && !pass.is_empty() && prompt.contains(&pass) { sent_password=true; password.as_deref().map(|p| p.as_str()) } else { None };
                            if let Some(secret) = secret { let mut cr = false; let data = telnet_input(format!("{secret}\r").as_bytes(), config.newline_mode.as_deref().unwrap_or("crlf"), &mut cr); if socket.write_all(&data).await.is_err() { break; } prompt.clear(); }
                            if prompt.len() > 4096 { prompt = prompt.chars().rev().take(2048).collect::<String>().chars().rev().collect(); }
                        }
                    }
                }
            }
        }
        let _ = socket.shutdown().await;
    });
    Box::new(RuntimeStream {
        io,
        task: task.abort_handle(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iac_fragmented_and_escaped() {
        let mut p = IacParser::default();
        assert_eq!(p.consume(&[b'a', 255, 253]), (vec![b'a'], vec![]));
        assert_eq!(
            p.consume(&[1, b'b', 255, 255, 255, 250, 1, 2, 255]),
            (vec![b'b', 255], vec![255, 252, 1])
        );
        assert_eq!(p.consume(&[240, b'c']), (vec![b'c'], vec![]));
    }
    #[test]
    fn line_input_handles_split_crlf_and_backspace() {
        let mut p = LineInput::default();
        assert_eq!(
            p.consume(b"ab\x7fc\r").0,
            if cfg!(windows) {
                b"ac\r\n".to_vec()
            } else {
                b"ac\n".to_vec()
            }
        );
        assert!(p.consume(b"\n").0.is_empty());
    }
    #[test]
    fn telnet_normalizes_and_escapes() {
        let mut cr = false;
        assert_eq!(telnet_input(b"a\r", "crlf", &mut cr), b"a\r\n");
        assert_eq!(telnet_input(&[10, 255], "crlf", &mut cr), vec![255, 255]);
    }
    #[tokio::test]
    async fn local_shell_runs_startup_and_closes() {
        let config = ShellConfig {
            shell_kind: Some("custom".into()),
            shell_path: Some(
                if cfg!(windows) {
                    "C:/Windows/System32/cmd.exe"
                } else {
                    "/bin/sh"
                }
                .into(),
            ),
            args: if cfg!(windows) {
                vec!["/Q".into()]
            } else {
                vec![]
            },
            ..Default::default()
        };
        let mut stream = open_shell(config, None, Some("echo OPENSHELL_PIPE_OK\r\nexit".into()))
            .await
            .unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stream.read_to_end(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            String::from_utf8_lossy(&output).contains("OPENSHELL_PIPE_OK"),
            "Shell output: {:?}",
            String::from_utf8_lossy(&output)
        );
    }

    #[tokio::test]
    async fn telnet_negotiates_and_logs_in_over_tcp() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(&[255, 253]).await.unwrap();
            socket.write_all(&[1]).await.unwrap();
            let mut refusal = [0; 3];
            socket.read_exact(&mut refusal).await.unwrap();
            assert_eq!(refusal, [255, 252, 1]);
            socket.write_all(b"login:").await.unwrap();
            let mut username = [0; 6];
            socket.read_exact(&mut username).await.unwrap();
            assert_eq!(&username, b"user\r\n");
            socket.write_all(b"Pass").await.unwrap();
            socket.write_all(b"word:").await.unwrap();
            let mut password = [0; 6];
            socket.read_exact(&mut password).await.unwrap();
            assert_eq!(&password, b"pass\r\n");
            socket.write_all(b"ready").await.unwrap();
        });
        let config = TelnetConfig {
            auto_login: true,
            ..Default::default()
        };
        let mut stream = open_telnet(
            socket,
            config,
            Some("user".into()),
            Some(zeroize::Zeroizing::new("pass".into())),
        );
        let mut output = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_to_end(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&output, b"login:Password:ready");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn dropping_telnet_stream_closes_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut peer, _) = listener.accept().await.unwrap();
        let stream = open_telnet(socket, TelnetConfig::default(), None, None);
        tokio::task::yield_now().await;
        drop(stream);
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), peer.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
