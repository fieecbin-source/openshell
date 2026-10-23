#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("OpenShell Panic: {}\n", info);
        eprintln!("{}", msg);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("openshell_crash.log")
        {
            use std::io::Write;
            let _ = writeln!(f, "{}", msg);
        }
    }));

    openshell_desktop_lib::run()
}
