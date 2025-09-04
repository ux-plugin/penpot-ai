use crate::local_server::LocalServer;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tokio::runtime::Runtime;

// Server state type alias for clarity
type ServerState = (Mutex<Option<LocalServer>>, Mutex<Option<Runtime>>);

pub fn setup_menu_and_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItemBuilder::new("Quit").id("quit").build(app)?;
    let logout = MenuItemBuilder::new("Logout").id("logout").build(app)?;
    let show = MenuItemBuilder::new("Show").id("show").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &logout, &quit])
        .build()?;

    let _ = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                handle_quit_menu(app);
            }
            "logout" => {
                handle_logout_menu(app);
            }
            "show" => {
                handle_show_menu(app);
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
                handle_tray_double_click(tray_icon, position);
            }
            _ => {}
        })
        .build(app);

    Ok(())
}

fn handle_quit_menu(app: &AppHandle) {
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
}

fn handle_logout_menu(app: &AppHandle) {
    println!("=== LOGOUT MENU CLICKED ===");
    dbg!("menu item logout clicked");
    
    // Check if the main window exists, create if it doesn't
    let main_window = app.get_webview_window("main");
    
    match main_window {
        Some(window) => {
            // Window exists, show it and emit logout event
            let _ = window.show();
            let _ = window.set_focus();
            match app.emit("logout", ()) {
                Ok(_) => println!("✅ Logout event emitted successfully to existing window"),
                Err(e) => println!("❌ Failed to emit logout event: {}", e),
            }
        }
        None => {
            // No window exists, create one first
            println!("No main window found, creating new window");
            match tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("/".into())
            )
            .inner_size(300.0, 400.0)
            .title("Figma Plugin Companion")
            .resizable(true)
            .build() {
                Ok(window) => {
                    let _ = window.show();
                    let _ = window.set_focus();
                    
                    // Emit logout event to the new window
                    match app.emit("logout", ()) {
                        Ok(_) => println!("✅ Logout event emitted successfully to new window"),
                        Err(e) => println!("❌ Failed to emit logout event: {}", e),
                    }
                }
                Err(e) => {
                    println!("❌ Failed to create new window: {}", e);
                }
            }
        }
    }
    
    println!("=== LOGOUT HANDLING COMPLETED ===");
}

fn handle_show_menu(app: &AppHandle) {
    println!("=== SHOW MENU CLICKED ===");
    
    let main_window = app.get_webview_window("main");
    
    match main_window {
        Some(window) => {
            // Window exists, just show it and focus
            let _ = window.show();
            let _ = window.set_focus();
            println!("✅ Existing window shown and focused");
        }
        None => {
            // No window exists, create one
            println!("No main window found, creating new window");
            match tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("/".into())
            )
            .inner_size(300.0, 400.0)
            .title("Figma Plugin Companion")
            .resizable(true)
            .build() {
                Ok(window) => {
                    let _ = window.show();
                    let _ = window.set_focus();
                    println!("✅ New window created and shown");
                }
                Err(e) => {
                    println!("❌ Failed to create new window: {}", e);
                }
            }
        }
    }
    
    println!("=== SHOW HANDLING COMPLETED ===");
}

fn handle_tray_double_click(tray_icon: &tauri::tray::TrayIcon, position: tauri::PhysicalPosition<f64>) {
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
    let logical_pos: tauri::Position = tauri::Position::Logical(logical_position);
    let _ = window.set_position(logical_pos);
    let _ = window.set_focus();
}