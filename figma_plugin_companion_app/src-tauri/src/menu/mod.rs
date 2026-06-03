use crate::commands::logout;
use crate::dependencies::AppDependencies;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

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
        .on_menu_event(
            |app, event: tauri::menu::MenuEvent| match event.id().as_ref() {
                "quit" => {
                    handle_quit_menu(app);
                }
                "logout" => {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_logout_menu(&app_clone).await;
                    });
                }
                "show" => {
                    handle_show_menu(app);
                }
                _ => {}
            },
        )
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
    let app_clone = app.clone();
    
    tauri::async_runtime::spawn(async move {
        // Get dependencies from the app state
        let deps = app_clone.state::<AppDependencies>();
        
        // Use the stop method from dependencies
        if let Err(e) = deps.local_server().stop().await {
            tracing::error!("Failed to stop server during quit: {}", e);
        }
        
        app_clone.exit(0);
    });
}

async fn handle_logout_menu(app: &AppHandle) {
    tracing::info!("Logout menu clicked");
    
    // Get dependencies from the app state
    let deps = app.state::<AppDependencies>();
    
    match logout(app.clone(), deps).await {
        Ok(_) => tracing::info!("Logout completed successfully"),
        Err(e) => tracing::error!("Logout failed: {}", e),
    }

    // Check if the main window exists, create if it doesn't
    let main_window = app.get_webview_window("main");

    match main_window {
        Some(window) => {
            // Window exists, show it and emit logout event
            let _ = window.show();
            let _ = window.set_focus();
            match app.emit("reload", ()) {
                Ok(_) => tracing::debug!("Logout event emitted successfully to existing window"),
                Err(e) => tracing::error!("Failed to emit logout event: {}", e),
            }
        }
        None => {
            // No window exists, create one first
            tracing::debug!("No main window found, creating new window");
            match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
                .inner_size(300.0, 400.0)
                .title("Figma Plugin Companion")
                .resizable(true)
                .build()
            {
                Ok(window) => {
                    let _ = window.show();
                    let _ = window.set_focus();

                    // Emit reload event to the new window (not logout)
                    match app.emit("reload", ()) {
                        Ok(_) => tracing::debug!("Reload event emitted successfully to new window"),
                        Err(e) => tracing::error!("Failed to emit reload event: {}", e),
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to create new window: {}", e);
                }
            }
        }
    }

    tracing::info!("Logout handling completed");
}

fn handle_show_menu(app: &AppHandle) {
    tracing::debug!("Show menu clicked");

    let main_window = app.get_webview_window("main");

    match main_window {
        Some(window) => {
            // Window exists, just show it and focus
            let _ = window.show();
            let _ = window.set_focus();
            tracing::debug!("Existing window shown and focused");
        }
        None => {
            // No window exists, create one
            tracing::debug!("No main window found, creating new window");
            match tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
                .inner_size(300.0, 400.0)
                .title("Figma Plugin Companion")
                .resizable(true)
                .build()
            {
                Ok(window) => {
                    let _ = window.show();
                    let _ = window.set_focus();
                    tracing::debug!("New window created and shown");
                }
                Err(e) => {
                    tracing::error!("Failed to create new window: {}", e);
                }
            }
        }
    }

    tracing::debug!("Show handling completed");
}

fn handle_tray_double_click(
    tray_icon: &tauri::tray::TrayIcon,
    position: tauri::PhysicalPosition<f64>,
) {
    tracing::debug!("System tray received a left click");

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
