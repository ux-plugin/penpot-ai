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
    let span = tracing::info_span!("logout");
    let _enter = span.enter();
    
    tracing::info!("Starting logout");
    
    // Clear credentials - log error but don't block logout if keyring fails
    if let Err(e) = deps.auth_state().clear().await {
        tracing::warn!("Failed to clear credentials from keyring: {}", e);
        // Continue with logout anyway
    }

    // Ensure the main window is visible after logout - log error but don't block
    if let Err(e) = show_or_create_main_window(app.clone()).await {
        tracing::warn!("Failed to show main window: {}", e);
        // Continue with logout anyway
    }

    // Shutdown the server - log error but don't block logout
    if let Err(e) = deps.local_server().stop().await {
        tracing::warn!("Failed to stop server: {}", e);
        // Continue with logout anyway
    }

    tracing::info!("Logout completed successfully");
    Ok(())
}
