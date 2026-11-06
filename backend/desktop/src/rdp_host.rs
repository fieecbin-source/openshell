use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use zeroize::Zeroizing;

pub const SOURCE: &str = include_str!("rdp_host.cs");
const UTF8_INPUT: &str = "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);";

#[derive(Clone)]
pub struct Status {
    pub state: &'static str,
    pub error: Option<String>,
    pub authenticated: bool,
    pub code: Option<i32>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            state: "starting",
            error: None,
            authenticated: false,
            code: None,
        }
    }
}

#[derive(Deserialize)]
struct Event {
    state: String,
    code: Option<i32>,
}

impl Status {
    fn update(&mut self, line: &str) -> io::Result<()> {
        let event: Event = serde_json::from_str(line)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid RDP host event"))?;
        self.state = match event.state.as_str() {
            "starting" => "starting",
            "launched" => "launched",
            "connected" => "connected",
            "disconnected" => "disconnected",
            "failed" => "failed",
            "closed" => "closed",
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid RDP host state",
                ))
            }
        };
        self.authenticated |= self.state == "connected";
        self.code = event.code;
        self.error = if self.state == "failed" {
            Some(format!(
                "远程桌面认证或连接失败（代码 {}）",
                event.code.unwrap_or(-1)
            ))
        } else {
            None
        };
        Ok(())
    }
}

#[cfg(windows)]
pub fn start(
    config: &serde_json::Value,
    password: Option<&str>,
    file: &std::path::Path,
) -> io::Result<(Child, Arc<Mutex<Status>>, JoinHandle<()>)> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut directory = [0u16; 32768];
    let length =
        unsafe { GetSystemDirectoryW(directory.as_mut_ptr(), directory.len() as u32) } as usize;
    if length == 0 || length >= directory.len() {
        return Err(io::Error::other("Windows system directory unavailable"));
    }
    let powershell = std::path::PathBuf::from(std::ffi::OsString::from_wide(&directory[..length]))
        .join("WindowsPowerShell/v1.0/powershell.exe");
    #[derive(Serialize)]
    struct Input<'a> {
        config: &'a serde_json::Value,
        password: Option<&'a str>,
    }
    let input = Zeroizing::new(serde_json::to_vec(&Input { config, password })?);
    let self_check = if cfg!(test) {
        "[OpenShellRdpHost]::SelfCheck();"
    } else {
        ""
    };
    let script=format!("$ErrorActionPreference='Stop';try {{ {UTF8_INPUT} Add-Type -TypeDefinition @'\n{SOURCE}\n'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions,Microsoft.CSharp;{self_check}[OpenShellRdpHost]::Run([Console]::In.ReadToEnd()) }} catch {{ [Console]::Out.WriteLine('{{\"state\":\"failed\",\"code\":-1}}');[Console]::Out.Flush();exit 1 }}");
    let mut command = Command::new(powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", &script])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if cfg!(test) {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = crate::rdp_process::start(command, file)?;
    let send = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("RDP host input unavailable"))
        .and_then(|mut stdin| stdin.write_all(&input));
    if let Err(error) = send {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("RDP host events unavailable"))?;
    let status = Arc::new(Mutex::new(Status::default()));
    let events = status.clone();
    let reader = std::thread::spawn(move || {
        for line in io::BufReader::new(output).lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(mut status) = events.lock() else {
                break;
            };
            if status.update(&line).is_err() {
                status.state = "failed";
                status.error = Some("远程桌面状态通道无效".into());
                break;
            }
        }
    });
    Ok((child, status, reader))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_authenticated_login_events_report_connected_and_errors_are_sanitized() {
        let mut status = Status::default();
        status
            .update(r#"{"state":"launched","code":null}"#)
            .unwrap();
        assert_ne!(status.state, "connected");
        status
            .update(r#"{"state":"connected","code":null}"#)
            .unwrap();
        assert_eq!(status.state, "connected");
        status
            .update(r#"{"state":"failed","code":5,"raw":"synthetic-secret"}"#)
            .unwrap();
        assert!(!status.error.unwrap().contains("synthetic-secret"));
        assert!(Status::default().update(r#"{"state":"unknown"}"#).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn actual_active_x_refused_loopback_connection_never_reports_authenticated_login() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = serde_json::json!({"host":"127.0.0.1","port":port,"username":"synthetic-rdp","width":800,"height":600,"hidden_test":true});
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("owned.rdp");
        std::fs::write(&file, b"synthetic").unwrap();
        let (child, events, reader) = start(&config, Some("synthetic-password"), &file).unwrap();
        let mut child = Some(child);
        // COM activation plus Windows' refused-connection retries can exceed thirty seconds.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let result = loop {
            let status = events.lock().unwrap().clone();
            if status.state == "failed" || std::time::Instant::now() >= deadline {
                break status;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        let exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let automatic_exit = loop {
            if child.as_mut().unwrap().try_wait().unwrap().is_some() {
                break true;
            }
            if std::time::Instant::now() >= exit_deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        let mut stderr = String::new();
        if automatic_exit {
            if let Some(mut output) = child.as_mut().unwrap().stderr.take() {
                use std::io::Read;
                output.read_to_string(&mut stderr).unwrap();
            }
        }
        let exit = crate::rdp_process::close(&mut child, &file).unwrap();
        reader.join().unwrap();
        // The last COM event can arrive while we wait for automatic process exit.
        let final_status = events.lock().unwrap().clone();
        assert!(!file.exists());
        assert!(
            automatic_exit,
            "failed RDP host did not release itself: state={}, code={:?}",
            result.state, result.code
        );
        assert!(
            !final_status.authenticated,
            "unreachable server reported login success"
        );
        assert_eq!(
            final_status.state, "failed",
            "host exit={exit:?}, stderr={stderr}"
        );
        assert!(
            final_status.code.is_some_and(|code| code > 0),
            "expected a real ActiveX network failure, got {:?}: {:?}",
            final_status.code,
            final_status.error
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_stdin_preserves_unicode_credentials() {
        use std::os::windows::process::CommandExt;
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", &format!("{UTF8_INPUT}[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::Out.Write([Console]::In.ReadToEnd())")])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let input = "é密🔑";
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), input);
    }
}
