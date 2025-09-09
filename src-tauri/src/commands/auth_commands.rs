use crate::auth::AuthCredentials;
use crate::dependencies::AppDependencies;
use tauri::{AppHandle};

use crate::window_utils::show_or_create_main_window;

#[tauri::command]
pub async fn get_credentials(deps: tauri::State<'_, AppDependencies>) -> Result<AuthCredentials, String> {
    deps.auth_state().get().await
}

#[tauri::command]
pub async fn set_credentials(
    credentials: AuthCredentials,
    deps: tauri::State<'_, AppDependencies>
) -> Result<(), String> {
    deps.auth_state().set(credentials).await
}

#[tauri::command]
pub async fn delete_credentials(deps: tauri::State<'_, AppDependencies>) -> Result<(), String> {
    deps.auth_state().clear().await
}

#[tauri::command]
pub async fn logout(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>
) -> Result<(), String> {
    println!("Logging out...");
    deps.auth_state().clear().await?;

    // Ensure the main window is visible after logout
    show_or_create_main_window(app.clone()).await?;

    // Shutdown the server
    deps.local_server().stop().await?;

    Ok(())
}
