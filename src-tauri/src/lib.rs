pub mod auth;
mod backend_client;
mod commands;
mod config;
mod dependencies;
mod local_server;
mod menu;
pub mod window_utils;

use crate::commands::{logout, stop_server};
use crate::dependencies::AppDependencies;
use commands::{delete_credentials, get_credentials, is_authenticated, set_credentials, start_server};
use menu::setup_menu_and_tray;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenv::dotenv().ok();

    let deps = AppDependencies::new().expect("Failed to initialize dependencies");

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(deps)
        .setup(|app| {
            setup_window_behavior(app)?;
            setup_menu_and_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_authenticated,
            get_credentials,
            set_credentials,
            delete_credentials,
            logout,
            start_server,
            stop_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_window_behavior(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_window("main").unwrap();
    window.clone().on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            window.hide().unwrap();
            window.set_skip_taskbar(true).unwrap();
            api.prevent_close();
        }
    });
    Ok(())
}
