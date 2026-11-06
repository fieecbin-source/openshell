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
    let exit_code = if let Some(process) = child.as_mut() {
        let status = match process.try_wait()? {
            Some(status) => status,
            None => {
                if let Err(error) = process.kill() {
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
