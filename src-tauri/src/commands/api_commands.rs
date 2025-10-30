use crate::backend_client::{LoginAuthData, UpdateUserRequest, UserConfig};
use crate::dependencies::AppDependencies;
use tauri::AppHandle;

// Login with Figma
#[tauri::command]
pub async fn login_with_figma(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    let backend_client = deps.backend_client();
    
    // Get login init response first to extract the login URL
    let init_url = deps.config().backend_base_url.clone() + "/auth/figma/login";
    
    // Use reqwest directly for the initial call to get the login URL
    let client = tauri_plugin_http::reqwest::Client::new();
    let init_response = client
        .get(&init_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to initialize Figma login: {}", e))?;

    if !init_response.status().is_success() {
        let status = init_response.status();
        let text = init_response.text().await.unwrap_or_default();
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
        .map_err(|e| format!("Failed to parse login init response: {}", e))?;

    // Open the login URL in the default browser
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&login_init.login_url, None::<&str>)
        .map_err(|e| format!("Failed to open login URL: {}", e))?;

    // Continue with the login flow using backend_client
    backend_client.login_with_figma().await
}

// Login with GitHub
#[tauri::command]
pub async fn login_with_github(
    app: AppHandle,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<LoginAuthData, String> {
    let backend_client = deps.backend_client();
    
    // Get login init response first to extract the login URL
    let init_url = deps.config().backend_base_url.clone() + "/auth/github/login";
    
    // Use reqwest directly for the initial call to get the login URL
    let client = tauri_plugin_http::reqwest::Client::new();
    let init_response = client
        .get(&init_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to initialize GitHub login: {}", e))?;

    if !init_response.status().is_success() {
        let status = init_response.status();
        let text = init_response.text().await.unwrap_or_default();
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
        .map_err(|e| format!("Failed to parse login init response: {}", e))?;

    // Open the login URL in the default browser
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&login_init.login_url, None::<&str>)
        .map_err(|e| format!("Failed to open login URL: {}", e))?;

    // Continue with the login flow using backend_client
    backend_client.login_with_github().await
}

// Fetch user configuration
#[tauri::command]
pub async fn fetch_user_config(
    deps: tauri::State<'_, AppDependencies>,
) -> Result<UserConfig, String> {
    deps.backend_client().fetch_user_config().await
}

// Update user configuration
#[tauri::command]
pub async fn update_user_config(
    update_data: UpdateUserRequest,
    deps: tauri::State<'_, AppDependencies>,
) -> Result<(), String> {
    deps.backend_client().update_user_config(update_data).await
}
