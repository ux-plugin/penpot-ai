mod local_server;
mod audio;

use local_server::LocalServer;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tokio::runtime::Runtime;

// Server state that will be managed by Tauri
struct ServerState(Mutex<Option<LocalServer>>, Mutex<Option<Runtime>>);

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str)  {
    println!("Hello, {}! You've been greeted from Rust!", name);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            let quit = MenuItemBuilder::new("Quit").id("quit").build(app).unwrap();
            let hide = MenuItemBuilder::new("Hide").id("hide").build(app).unwrap();
            let show = MenuItemBuilder::new("Show").id("show").build(app).unwrap();
            // we could opt handle an error case better than calling unwrap
            let menu = MenuBuilder::new(app)
                .items(&[&quit, &hide, &show])
                .build()
                .unwrap();

            let _ = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        // Shutdown the server before exiting
                        let server_state = app.state::<ServerState>();
                        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

                        // Take the server from the state and shut it down
                        if let Some(mut server) = server_state.0.lock().unwrap().take() {
                            rt.block_on(async {
                                server.shutdown().await;
                            });
                            println!("Local server shut down");
                        }

                        app.exit(0)
                    },
                    "hide" => {
                        dbg!("menu item hide clicked");
                        let window = app.get_webview_window("main").unwrap();
                        window.hide().unwrap();
                    }
                    "show" => {
                        dbg!("menu item show clicked");
                        let window = app.get_webview_window("main").unwrap();
                        window.show().unwrap();
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray_icon, event| match event {
                    TrayIconEvent::DoubleClick {
                        id: _,
                        position,
                        rect: _,
                        button: _,
                    } => {
                        dbg!("system tray received a left click");

                        let window = tray_icon.app_handle().get_webview_window("main").unwrap();
                        let _ = window.show().unwrap();
                        let logical_size = tauri::LogicalSize::<f64> {
                            width: 300.00,
                            height: 400.00,
                        };
                        let logical_s = tauri::Size::Logical(logical_size);
                        let _ = window.set_size(logical_s);
                        let logical_position = tauri::LogicalPosition::<f64> {
                            x: position.x - logical_size.width,
                            y: position.y - logical_size.height - 70.,
                        };
                        let logical_pos: tauri::Position =
                            tauri::Position::Logical(logical_position);
                        let _ = window.set_position(logical_pos);
                        let _ = window.set_focus();
                    }
                    _ => {}
                })
                .build(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
