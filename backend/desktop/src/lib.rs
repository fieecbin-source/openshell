//! OpenShell 桌面壳：Tauri 命令注册、状态注入与事件桥接。

mod commands;
mod error;

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
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("data"));
            std::fs::create_dir_all(&data_dir).ok();

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

            // 监听事件总线并将事件转发给前端窗口
            let mut event_rx = services.event_bus.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = event_rx.recv().await {
                    let _ = app_handle.emit("openshell://event", &event);
                }
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
            group_delete,
            credential_list,
            credential_create,
            credential_delete,
            ssh_key_list,
            ssh_key_import,
            ssh_key_delete,
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
