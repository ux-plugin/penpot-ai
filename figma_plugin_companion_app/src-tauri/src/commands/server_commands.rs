use crate::auth::auth_errors;
use crate::dependencies::AppDependencies;
use tauri::State;

#[tauri::command]
pub async fn start_server(deps: State<'_, AppDependencies>) -> Result<u16, String> {
    // Validate authentication before starting server
    let is_auth = deps.auth_state().is_authenticated().await?;
    if !is_auth {
        return Err(auth_errors::NOT_AUTHENTICATED.to_string());
    }
    
    deps.local_server().get_or_start().await
}

#[tauri::command]
pub async fn stop_server(deps: State<'_, AppDependencies>) -> Result<(), String> {
    // Validate authentication before stopping server
    let is_auth = deps.auth_state().is_authenticated().await?;
    if !is_auth {
        return Err(auth_errors::NOT_AUTHENTICATED.to_string());
    }
    
    deps.local_server().stop().await
}
