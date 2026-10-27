//! OpenShell 桌面壳：Tauri 命令注册、状态注入与事件桥接。

mod commands;
mod error;
mod updater;

use commands::*;
use openshell_app_core::AppServices;
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = match resolve_data_dir(app) {
                Ok(dir) => dir,
                Err(err) => {
                    // 宁可拒绝启动，也不要把连接配置写进安装目录（更新/卸载会一并删除）。
                    tracing::error!(error = %err, "unsafe or unavailable user data directory");
                    tauri_plugin_dialog::DialogExt::dialog(app.handle())
                        .message(format!(
                            "OpenShell 无法确定安全的用户数据目录：{err}\n\n\
                             为避免把连接数据写进安装目录，程序已停止启动。\n\
                             请检查系统用户目录权限后重试。"
                        ))
                        .title("OpenShell 启动失败")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    return Err(Box::<dyn std::error::Error>::from(err));
                }
            };
            if let Err(err) = std::fs::create_dir_all(&data_dir) {
                tracing::error!(error = %err, dir = %data_dir.display(), "failed to create data dir");
            }
            tracing::info!(dir = %data_dir.display(), "using user data directory");

            let services =
                Arc::new(AppServices::new(data_dir).expect("failed to initialize AppServices"));

            // 注册内置扩展示例模块（Architecture §21 / P1-M5-1）
            services
                .extensions
                .register_tool(Arc::new(openshell_extension_sample::PortCheckerTool));
            services.extensions.register_panel(Arc::new(
                openshell_extension_sample::PortCheckerSidePanel::new(),
            ));
            services.extensions.register_quick_action(Arc::new(
                openshell_extension_sample::PortCheckerQuickAction::new(),
            ));
            services
                .extensions
                .register_protocol(Arc::new(openshell_extension_sample::EchoProtocolProvider));

            app.manage(services.clone());

            // 更新服务：工作目录与备份目录都在用户数据目录下（与安装目录严格隔离）。
            let updater = updater::UpdaterHandle::new(
                services.paths.data_dir.clone(),
                services.paths.updater_dir.clone(),
                services.paths.backups_dir.clone(),
            )
            .map_err(Box::<dyn std::error::Error>::from)?;
            app.manage(updater);

            // 监听事件总线并将事件转发给前端窗口。
            //
            // 转发逻辑放在 app-core 的 `forward_events` 里：它把 broadcast 的 `Lagged`
            // 当作「丢旧事件继续转发」而不是终止条件（旧实现的 `while let Ok(..)` 会在
            // 一次卡顿后永久停止转发，使界面停留在「已连接」的假状态），
            // 同时便于用单测锁定该行为。
            let event_rx = services.event_bus.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                openshell_app_core::forward_events(event_rx, |event| {
                    let app_handle = app_handle.clone();
                    async move {
                        if let Err(err) = app_handle.emit("openshell://event", &event) {
                            tracing::warn!(error = %err, "failed to forward app event to frontend");
                        }
                    }
                })
                .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_change_password,
            session_list,
            session_get,
            session_create,
            session_update,
            session_delete,
            session_duplicate,
            group_list,
            group_create,
            group_rename,
            group_move,
            group_delete,
            credential_list,
            credential_create,
            credential_delete,
            ssh_key_list,
            ssh_key_import,
            ssh_key_delete,
            ssh_key_set_passphrase,
            connect_session,
            connection_close,
            connection_list,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_ack,
            terminal_close,
            op_cancel,
            local_fs_home,
            local_fs_list,
            sftp_list_dir,
            sftp_stat,
            sftp_mkdir,
            sftp_remove_file,
            sftp_remove_dir,
            sftp_rename,
            sftp_set_permissions,
            sftp_read_file,
            sftp_write_file,
            sftp_start_transfer,
            sftp_list_transfers,
            sftp_pause_transfer,
            sftp_cancel_transfer,
            sftp_get_cwd,
            monitor_start,
            monitor_stop,
            monitor_get_latest,
            monitor_get_history,
            monitor_kill_process,
            ssh_exec,
            forward_list,
            forward_create,
            forward_update,
            forward_delete,
            forward_start,
            forward_stop,
            forward_list_statuses,
            snippet_list,
            snippet_create,
            snippet_update,
            snippet_delete,
            importer_preview_openssh,
            importer_preview_finalshell,
            importer_commit,
            importer_export_bundle_json,
            importer_export_bundle_encrypted,
            importer_preview_bundle_json,
            importer_preview_bundle_encrypted,
            settings_get,
            settings_set,
            settings_list,
            updater::updater_get_state,
            updater::updater_check,
            updater::updater_download,
            updater::updater_cancel_download,
            updater::updater_install,
            updater::updater_skip_version,
            updater::updater_remind_later,
            updater::updater_clear_skipped,
            updater::updater_backup_now,
            updater::updater_list_backups,
            updater::updater_open_release_page,
            updater::updater_open_log_dir,
            updater::updater_open_backup_dir,
            updater::updater_open_download_dir,
            sync_get_config,
            sync_save_config,
            sync_register,
            sync_login,
            sync_logout,
            sync_now,
            sync_check_updates,
            plugin_list_tools,
            plugin_list_panels,
            plugin_list_quick_actions,
            plugin_execute_quick_action,
            plugin_toggle_feature,
            plugin_check_port,
            card_create,
            card_list,
            card_get,
            card_set_mode,
            card_mark_connected,
            card_mark_disconnected,
            card_close,
            serial_list_ports,
            serial_open,
            serial_send,
            serial_read,
            serial_set_lines,
            serial_get_modem_status,
            serial_set_baud_rate,
            serial_get_stats,
            serial_close,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OpenShell");
}

/// 解析并校验用户数据目录（数据安全的第 0 道防线）。
///
/// * 必须能通过 Tauri 的 `app_data_dir()` 解析。旧实现失败时会静默退化成相对路径 `data`，
///   等于把数据库写进进程 CWD（通常是安装目录），更新/卸载时会被一并删除 —— 这里改为拒绝启动。
/// * 数据目录不得等于或位于可执行文件所在目录内，防止便携版误配置导致数据跟着安装包走。
fn resolve_data_dir(app: &tauri::App) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法解析应用数据目录：{err}"))?;
    if data_dir.as_os_str().is_empty() {
        return Err("解析出的应用数据目录为空".to_string());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            reject_install_dir(&data_dir, exe_dir)?;
        }
    }
    Ok(data_dir)
}

/// 数据目录与安装目录的隔离校验（纯函数，便于单测）。
fn reject_install_dir(data_dir: &std::path::Path, exe_dir: &std::path::Path) -> Result<(), String> {
    let install_dir = std::fs::canonicalize(exe_dir).unwrap_or_else(|_| exe_dir.to_path_buf());
    let resolved = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    if resolved == install_dir || resolved.starts_with(&install_dir) {
        return Err(format!(
            "数据目录 {} 位于安装目录 {} 内",
            resolved.display(),
            install_dir.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::reject_install_dir;

    #[test]
    fn rejects_data_dir_inside_install_dir() {
        let install = std::path::Path::new("/opt/openshell");
        assert!(reject_install_dir(std::path::Path::new("/opt/openshell"), install).is_err());
        assert!(reject_install_dir(std::path::Path::new("/opt/openshell/data"), install).is_err());
    }

    #[test]
    fn allows_data_dir_outside_install_dir() {
        let install = std::path::Path::new("/opt/openshell");
        assert!(reject_install_dir(
            std::path::Path::new("/home/user/.local/share/openshell"),
            install
        )
        .is_ok());
        // 形似但不在其下的兄弟目录也必须放行
        assert!(reject_install_dir(std::path::Path::new("/opt/openshell-data"), install).is_ok());
    }
}
