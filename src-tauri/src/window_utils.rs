use tauri::{AppHandle, Manager};

pub async fn show_or_create_main_window(app: AppHandle) -> Result<(), String> {
    let main_window = app.get_webview_window("main");

    match main_window {
        Some(window) => {
            // Window exists, show it and focus
            window
                .show()
                .map_err(|e| format!("Failed to show window: {}", e))?;
            window
                .set_focus()
                .map_err(|e| format!("Failed to focus window: {}", e))?;
            tracing::debug!("Existing main window shown and focused");
        }
        None => {
            // No window exists, create one
            tracing::debug!("No main window found, creating new window");
            let window =
                tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("/".into()))
                    .inner_size(300.0, 400.0)
                    .title("Figma Plugin Companion")
                    .resizable(true)
                    .build()
                    .map_err(|e| format!("Failed to create window: {}", e))?;

            window
                .show()
                .map_err(|e| format!("Failed to show new window: {}", e))?;
            window
                .set_focus()
                .map_err(|e| format!("Failed to focus new window: {}", e))?;
            tracing::debug!("New main window created and shown");
        }
    }

    Ok(())
}
