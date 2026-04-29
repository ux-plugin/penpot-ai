use crate::backend_client::{LoginAuthData, UpdateUserRequest, UserConfig};
use crate::dependencies::AppDependencies;
use tauri::AppHandle;

// Login with Auth0
#[tauri::command]
pub async fn login_with_auth0(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    tracing::info!("Starting Auth0 login flow");

    let result = deps.backend_client().login_with_auth0(app).await?;

    tracing::info!("Auth0 login completed successfully");
    Ok(result)
}

// Login with Figma
#[tauri::command]
pub async fn login_with_figma(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    tracing::info!("Starting Figma login flow");
    
    let result = deps.backend_client().login_with_figma(app).await?;
    
    tracing::info!("Figma login completed successfully");
    Ok(result)
}

// Login with GitHub
#[tauri::command]
pub async fn login_with_github(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    tracing::info!("Starting GitHub login flow");
    
    let result = deps.backend_client().login_with_github(app).await?;
    
    tracing::info!("GitHub login completed successfully");
    Ok(result)
}

// Fetch user configuration
#[tauri::command]
pub async fn fetch_user_config(
    deps: tauri::State<'_, AppDependencies>,
) -> Result<UserConfig, String> {
    tracing::debug!("Fetching user configuration");
    
    let result = deps.backend_client().fetch_user_config().await;
    
    match &result {
        Ok(config) => tracing::debug!("User configuration fetched successfully for user ID: {}", config.id),
        Err(e) => tracing::error!("Failed to fetch user configuration: {}", e),
    }
    
    result
}

// Update user configuration
#[tauri::command]
pub async fn update_user_config(
    update_data: UpdateUserRequest,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<(), String> {
    tracing::debug!("Updating user configuration");
    
    let result = deps.backend_client().update_user_config(update_data).await;
    
    match &result {
        Ok(_) => tracing::info!("User configuration updated successfully"),
        Err(e) => tracing::error!("Failed to update user configuration: {}", e),
    }
    
    result
}
