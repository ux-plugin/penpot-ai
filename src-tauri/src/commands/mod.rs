use keyring::Entry;
use serde::{Deserialize, Serialize};

// Authentication credentials structure
#[derive(Serialize, Deserialize, Clone)]
pub struct AuthCredentials {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub aes_gcm: Option<String>,
    pub refresh_token_expires_at: Option<String>,
    pub user_id: Option<String>,
}

// Keyring commands for secure credential storage
#[tauri::command]
pub async fn get_credentials() -> Result<AuthCredentials, String> {
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    match entry.get_password() {
        Ok(password) => serde_json::from_str::<AuthCredentials>(&password)
            .map_err(|e| format!("Failed to deserialize credentials: {}", e)),
        Err(keyring::Error::NoEntry) => {
            // Return empty credentials if no entry exists
            Ok(AuthCredentials {
                access_token: None,
                refresh_token: None,
                aes_gcm: None,
                refresh_token_expires_at: None,
                user_id: None,
            })
        }
        Err(e) => Err(format!("Failed to get credentials from keyring: {}", e)),
    }
}

#[tauri::command]
pub async fn set_credentials(credentials: AuthCredentials) -> Result<(), String> {
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    let credentials_json = serde_json::to_string(&credentials)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    entry
        .set_password(&credentials_json)
        .map_err(|e| format!("Failed to set credentials in keyring: {}", e))
}

#[tauri::command]
pub async fn delete_credentials() -> Result<(), String> {
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete credentials from keyring: {}", e))
}