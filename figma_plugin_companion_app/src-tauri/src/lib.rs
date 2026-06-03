pub mod auth;
mod backend_client;
mod commands;
mod config;
mod dependencies;
mod local_server;
mod menu;
pub mod window_utils;

use crate::commands::{logout, stop_server, login_with_auth0, fetch_user_config, update_user_config};
use crate::dependencies::AppDependencies;
use commands::{delete_credentials, get_credentials, is_authenticated, set_credentials, start_server};
use menu::setup_menu_and_tray;
use tauri::{Manager, WindowEvent};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenv::dotenv().ok();

    // Initialize tracing subscriber
    initialize_tracing();

    let deps = AppDependencies::new().expect("Failed to initialize dependencies");

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(deps.clone())
        .setup(move |app| {
            setup_window_behavior(app)?;
            setup_menu_and_tray(app.handle())?;
            
            // Initialize the app handle in LocalServer for event emission
            let app_handle = app.handle().clone();
            let deps_clone = deps.clone();
            tauri::async_runtime::spawn(async move {
                deps_clone.local_server().set_app_handle(app_handle).await;
            });
            
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
            login_with_auth0,
            fetch_user_config,
            update_user_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn initialize_tracing() {
    // Get log level from environment variable, defaulting to "info"
    let log_level = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    
    // Initialize tracing subscriber with environment filter
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(log_level))
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    
    tracing::info!("Tracing initialized");
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
