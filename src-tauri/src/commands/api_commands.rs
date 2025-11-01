use crate::backend_client::{LoginAuthData, UpdateUserRequest, UserConfig};
use crate::dependencies::AppDependencies;
use tauri::AppHandle;

// Login with Figma
#[tauri::command]
pub async fn login_with_figma(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    tracing::info!("Starting Figma login flow");
    
    let backend_client = deps.backend_client();
    
    // Get login init response first to extract the login URL
    let init_url = deps.config().backend_base_url.clone() + "/auth/figma/login";
    tracing::debug!("Initializing Figma login with URL: {}", init_url);
    
    // Use reqwest directly for the initial call to get the login URL
    let client = tauri_plugin_http::reqwest::Client::new();
    let init_response = client
        .get(&init_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to initialize Figma login: {}", e);
            format!("Failed to initialize Figma login: {}", e)
        })?;

    if !init_response.status().is_success() {
        let status = init_response.status();
        let text = init_response.text().await.unwrap_or_default();
        tracing::error!("Figma login request failed with status {}: {}", status, text);
        return Err(format!("Figma login request failed: {} {}", status, text));
    }

    #[derive(serde::Deserialize)]
    struct LoginInitResponse {
        #[serde(rename = "loginUrl")]
        login_url: String,
    }

    let login_init: LoginInitResponse = init_response
        .json()
        .await
        .map_err(|e| {
            tracing::error!("Failed to parse login init response: {}", e);
            format!("Failed to parse login init response: {}", e)
        })?;

    // Open the login URL in the default browser
    tracing::debug!("Opening login URL in browser");
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&login_init.login_url, None::<&str>)
        .map_err(|e| {
            tracing::error!("Failed to open login URL: {}", e);
            format!("Failed to open login URL: {}", e)
        })?;

    // Continue with the login flow using backend_client
    tracing::debug!("Continuing with backend login flow");
    let result = backend_client.login_with_figma().await;
    
    match &result {
        Ok(_) => tracing::info!("Figma login completed successfully"),
        Err(e) => tracing::error!("Figma login failed: {}", e),
    }
    
    result
}

// Login with GitHub
#[tauri::command]
pub async fn login_with_github(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    tracing::info!("Starting GitHub login flow");
    
    let backend_client = deps.backend_client();
    
    // Get login init response first to extract the login URL
    let init_url = deps.config().backend_base_url.clone() + "/auth/github/login";
    tracing::debug!("Initializing GitHub login with URL: {}", init_url);
    
    // Use reqwest directly for the initial call to get the login URL
    let client = tauri_plugin_http::reqwest::Client::new();
    let init_response = client
        .get(&init_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to initialize GitHub login: {}", e);
            format!("Failed to initialize GitHub login: {}", e)
        })?;

    if !init_response.status().is_success() {
        let status = init_response.status();
        let text = init_response.text().await.unwrap_or_default();
        tracing::error!("GitHub login request failed with status {}: {}", status, text);
        return Err(format!("GitHub login request failed: {} {}", status, text));
    }

    #[derive(serde::Deserialize)]
    struct LoginInitResponse {
        #[serde(rename = "loginUrl")]
        login_url: String,
    }

    let login_init: LoginInitResponse = init_response
        .json()
        .await
        .map_err(|e| {
            tracing::error!("Failed to parse login init response: {}", e);
            format!("Failed to parse login init response: {}", e)
        })?;

    // Open the login URL in the default browser
    tracing::debug!("Opening login URL in browser");
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&login_init.login_url, None::<&str>)
        .map_err(|e| {
            tracing::error!("Failed to open login URL: {}", e);
            format!("Failed to open login URL: {}", e)
        })?;

    // Continue with the login flow using backend_client
    tracing::debug!("Continuing with backend login flow");
    let result = backend_client.login_with_github().await;
    
    match &result {
        Ok(_) => tracing::info!("GitHub login completed successfully"),
        Err(e) => tracing::error!("GitHub login failed: {}", e),
    }
    
    result
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
