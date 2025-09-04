mod audio;
mod commands;
mod local_server;
mod menu;

use commands::{delete_credentials, get_credentials, set_credentials};
use local_server::LocalServer;
use menu::setup_menu_and_tray;
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tokio::runtime::Runtime;

// Server state that Tauri will manage
struct ServerState(Mutex<Option<LocalServer>>, Mutex<Option<Runtime>>);




#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState(Mutex::new(None), Mutex::new(None)))
        .setup(|app| {
            // Start the local server
            let server_state = app.state::<ServerState>();
            let rt = Runtime::new().expect("Failed to create Tokio runtime");
            let mut server = LocalServer::new();

            // Create and start the server
            rt.block_on(async {
                let port = server.start().await.expect("Failed to start local server");
                println!("Local server started on port {}", port);

                *server_state.0.lock().unwrap() = Some(server);
            });

            *server_state.1.lock().unwrap() = Some(rt);
            // Setup window
            let window = app.get_window("main").unwrap();

            // Handle window close events
            window.clone().on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    window.hide().unwrap();
                    window.set_skip_taskbar(true).unwrap();
                    api.prevent_close();
                }
                _ => {}
            });

            // Setup menu and tray using the menu module
            setup_menu_and_tray(&app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_credentials,
            set_credentials,
            delete_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
