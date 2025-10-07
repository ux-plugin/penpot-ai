use crate::auth::AuthState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri_plugin_http::reqwest;

// Request/Response structures for the backend API
#[derive(Serialize, Deserialize)]
pub struct FigmaPluginRefreshAccessTokenRequest {
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "userId")]
    pub user_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct RefreshAccessTokenResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
}

#[derive(Serialize, Deserialize)]
pub struct EncryptionKeyResponse {
    pub key: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String, // ISO 8601 datetime string
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AppState {
    pub port: Option<u16>,
}

#[derive(Serialize, Deserialize)]
pub struct AuthErrorResponse {}

// Backend client configuration
#[derive(Clone)]
pub struct BackendClient {
    client: reqwest::Client,
    base_url: String,
    auth_state: Arc<AuthState>,
}

impl BackendClient {
    pub fn new(base_url: String, auth_state: Arc<AuthState>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
            auth_state,
        }
    }

    // Refresh access token using refresh token and user ID
    async fn refresh_access_token(
        &self,
        refresh_token: &str,
        user_id: &str,
    ) -> Result<String, String> {
        let request = FigmaPluginRefreshAccessTokenRequest {
            refresh_token: refresh_token.to_string(),
            user_id: user_id.to_string(),
        };

        let url = format!("{}/auth/plugin-ui/access-token/refresh", self.base_url);

        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Failed to send refresh token request: {}", e))?;

        if response.status().is_success() {
            let refresh_response: RefreshAccessTokenResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse refresh token response: {}", e))?;

            Ok(refresh_response.access_token)
        } else {
            Err(format!(
                "Failed to refresh access token: HTTP {}",
                response.status()
            ))
        }
    }

    // Generic method to handle authenticated requests with 401 retry logics
    async fn make_authenticated_request<F, Fut, T>(
        &self,
        request_fn: F,
    ) -> Result<T, String>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let current_credentials = self.auth_state.get().await?;

        let access_token = current_credentials
            .access_token
            .as_ref()
            .ok_or("No access token available")?;

        // Make the initial request
        match request_fn(access_token.clone()).await {
            Ok(result) => Ok(result),
            Err(error) => {
                // Check if it's a 401 error
                if error.contains("HTTP 401") {
                    // Attempt to refresh token
                    if let (Some(ref refresh_token), Some(ref user_id)) = (
                        &current_credentials.refresh_token,
                        &current_credentials.user_id,
                    ) {
                        match self.refresh_access_token(refresh_token, user_id).await {
                            Ok(new_access_token) => {
                                // Update the auth state with the new token
                                self.auth_state
                                    .update(|creds| {
                                        creds.access_token = Some(new_access_token.clone());
                                    })
                                    .await?;

                                // Retry the request with a new token
                                request_fn(new_access_token).await
                            }
                            Err(_) => {
                                Err("AUTH_FAILED".to_string())
                            }
                        }
                    } else {
                        Err("AUTH_FAILED".to_string())
                    }
                } else {
                    Err(error)
                }
            }
        }
    }

    // Get encryption key from backend with 401 handling
    async fn get_encryption_key(
        &self,
    ) -> Result<EncryptionKeyResponse, String> {
        let url = format!("{}/user/key", self.base_url);

        self.make_authenticated_request(|access_token| {
            let url = url.clone();
            let client = self.client.clone();
            async move {
                let response = client
                    .get(&url)
                    .bearer_auth(&access_token)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to get encryption key: {}", e))?;

                if response.status().is_success() {
                    let key_response: EncryptionKeyResponse = response
                        .json()
                        .await
                        .map_err(|e| format!("Failed to parse encryption key response: {}", e))?;
                    Ok(key_response)
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    Err("HTTP 401".to_string())
                } else {
                    Err(format!(
                        "Failed to get encryption key: HTTP {}",
                        response.status()
                    ))
                }
            }
        })
        .await
    }

    // Update app configuration (port) with 401 handling
    async fn update_app_config(
        &self,
        port: Option<u16>,
    ) -> Result<(), String> {
        let url = format!("{}/user/port", self.base_url);
        let app_state = AppState { port };
        self.make_authenticated_request(|access_token| {
            let url = url.clone();
            let app_state = app_state.clone();
            let client = self.client.clone();
            async move {
                let response = client
                    .post(&url)
                    .bearer_auth(&access_token)
                    .json(&app_state)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to update app config: {}", e))?;

                if response.status().is_success() {
                    Ok(())
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    Err("HTTP 401".to_string())
                } else {
                    Err(format!(
                        "Failed to update app config: HTTP {}",
                        response.status()
                    ))
                }
            }
        })
        .await
    }

    // Public method to get an encryption key with 401 handling
    pub async fn get_key(
        &self,
    ) -> Result<EncryptionKeyResponse, String> {
        self.get_encryption_key().await
    }

    // Public method to update app config with 401 handling
    pub async fn update_port(
        &self,
        port: Option<u16>,
    ) -> Result<(), String> {
        self.update_app_config(port).await
    }
}
