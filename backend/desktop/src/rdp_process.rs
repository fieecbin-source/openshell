use std::io;
use std::path::Path;
use std::process::{Child, Command};

pub fn start(mut command: Command, file: &Path) -> io::Result<Child> {
    match command.spawn() {
        Ok(child) => Ok(child),
        Err(error) => {
            cleanup(file).map_err(|cleanup_error| {
                io::Error::new(
                    error.kind(),
                    format!("{error}; RDP temporary file cleanup failed: {cleanup_error}"),
                )
            })?;
            Err(error)
        }
    }
}

pub fn close(child: &mut Option<Child>, file: &Path) -> io::Result<Option<i32>> {
    close_with_kill(child, file, |process| process.kill())
}

/// kill 失败时如实返回 Err，并保留 child 所有权与状态文件，供调用者重试；
/// 不把「未能终止」伪装成「已释放」。参数化 kill 仅为让该边界可被定向测试注入。
fn close_with_kill<F>(child: &mut Option<Child>, file: &Path, kill: F) -> io::Result<Option<i32>>
where
    F: FnOnce(&mut Child) -> io::Result<()>,
{
    let exit_code = if let Some(process) = child.as_mut() {
        let status = match process.try_wait()? {
            Some(status) => status,
            None => {
                if let Err(error) = kill(process) {
                    if process.try_wait()?.is_none() {
                        return Err(error);
                    }
                }
                process.wait()?
            }
        };
        *child = None;
        status.code()
    } else {
        None
    };
    cleanup(file)?;
    Ok(exit_code)
}

pub fn cleanup(file: &Path) -> io::Result<()> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[cfg(windows)]
    #[test]
    fn failed_kill_retains_the_child_and_status_file_until_retry_succeeds() {
        use std::os::windows::process::CommandExt;
        let file = path();
        std::fs::write(&file, b"synthetic RDP settings").unwrap();
        let mut child = Some(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        // 注入 native kill 失败：进程仍在运行，close 必须如实报错，
        // 且保留 child 所有权与临时 .rdp 状态文件，不能谎报已释放。
        let denied = || {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "synthetic kill denied",
            )
        };
        let result = close_with_kill(&mut child, &file, |_| Err(denied()));
        assert!(result.is_err(), "failed kill reported a successful release");
        assert!(child.is_some(), "failed kill dropped the child owner");
        assert!(
            file.exists(),
            "failed kill removed the status file before release"
        );

        let exit = close(&mut child, &file).unwrap();
        assert!(
            exit.is_some(),
            "retry did not observe the owned process exit"
        );
        assert!(child.is_none(), "retry kept the child owner");
        assert!(!file.exists(), "retry left the status file behind");
    }

    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "openshell-rdp-process-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn spawn_failure_removes_its_temporary_file() {
        let file = path();
        std::fs::write(&file, b"synthetic RDP settings").unwrap();
        let result = start(Command::new("openshell-nonexistent-rdp-client"), &file);
        let leaked = file.exists();
        if leaked {
            std::fs::remove_file(&file).unwrap();
        }
        assert!(result.is_err());
        assert!(!leaked, "failed spawn retained its temporary file");
    }

    #[test]
    fn cleanup_failure_is_reported_and_can_be_retried() {
        let file = path();
        std::fs::create_dir(&file).unwrap();
        let mut child = None;
        let result = close(&mut child, &file);
        std::fs::remove_dir(&file).unwrap();
        assert!(result.is_err(), "cleanup failure reported success");
        assert!(close(&mut child, &file).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn close_waits_for_only_its_owned_child_and_removes_file() {
        use std::os::windows::process::CommandExt;
        let file = path();
        std::fs::write(&file, b"synthetic RDP settings").unwrap();
        let mut child = Some(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        let exit = close(&mut child, &file).unwrap();
        assert!(exit.is_some(), "owned process exit was not observed");
        assert!(child.is_none());
        assert!(!file.exists());
        assert!(close(&mut child, &file).is_ok());
    }
}
