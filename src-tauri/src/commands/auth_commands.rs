use crate::auth::{AuthCredentials, auth_errors};
use crate::dependencies::AppDependencies;
use tauri::{AppHandle};

use crate::window_utils::show_or_create_main_window;

#[tauri::command]
pub async fn is_authenticated(deps: tauri::State<'_, AppDependencies>) -> Result<bool, String> {
    deps.auth_state().is_authenticated().await
}

#[tauri::command]
pub async fn get_credentials(deps: tauri::State<'_, AppDependencies>) -> Result<AuthCredentials, String> {
    // Validate authentication before exposing sensitive credential data
    let is_auth = deps.auth_state().is_authenticated().await?;
    if !is_auth {
        return Err(auth_errors::NOT_AUTHENTICATED.to_string());
    }
    
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
    
    // Allow logout regardless of authentication state to handle edge cases
    // like invalid/expired credentials or backend database resets
    
    // Clear credentials (this will succeed even if already empty)
    deps.auth_state().clear().await?;

    // Ensure the main window is visible after logout
    show_or_create_main_window(app.clone()).await?;

    // Shutdown the server (this will handle already-stopped servers gracefully)
    deps.local_server().stop().await?;

    Ok(())
}
