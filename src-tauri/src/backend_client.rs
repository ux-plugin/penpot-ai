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
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
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

// Login flow structures
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LoginInitResponse {
    #[serde(rename = "readTokenJwt")]
    pub read_token_jwt: String,
    #[serde(rename = "loginUrl")]
    pub login_url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AccessTokenResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RefreshTokenResponse {
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "refreshTokenExpiresAt")]
    pub refresh_token_expires_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LoginAuthData {
    pub access_token: String,
    pub refresh_token: String,
    pub refresh_token_expires_at: String,
}

// User config structures
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UserConfig {
    pub id: String,
    pub name: Option<String>,
    pub username: Option<String>,
    #[serde(rename = "allowSavingCompletions")]
    pub allow_saving_completions: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UpdateUserRequest {
    pub name: Option<String>,
    pub username: Option<String>,
    #[serde(rename = "allowSavingCompletions")]
    pub allow_saving_completions: Option<bool>,
}

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
    ) -> Result<(String, String), String> {
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

            Ok((refresh_response.access_token, refresh_response.refresh_token))
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
                            Ok((new_access_token, new_refresh_token)) => {
                                // Update the auth state with the new tokens
                                self.auth_state
                                    .update(|creds| {
                                        creds.access_token = Some(new_access_token.clone());
                                        creds.refresh_token = Some(new_refresh_token);
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

    // Login with Figma - complete OAuth flow
    pub async fn login_with_figma(&self) -> Result<LoginAuthData, String> {
        // Step 1: Initialize login
        let init_url = format!("{}/auth/figma/login", self.base_url);
        let init_response = self
            .client
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

        let login_init: LoginInitResponse = init_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse login init response: {}", e))?;

        // Step 2: Get access token (polling)
        let access_token_url = format!("{}/auth/figma/access-token", self.base_url);
        let access_response = self
            .client
            .get(&access_token_url)
            .bearer_auth(&login_init.read_token_jwt)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Failed to get Figma access token: {}", e))?;

        if !access_response.status().is_success() {
            let status = access_response.status();
            let text = access_response.text().await.unwrap_or_default();
            return Err(format!("Figma access token request failed: {} {}", status, text));
        }

        let access_token_resp: AccessTokenResponse = access_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse access token response: {}", e))?;

        // Step 3: Get refresh token
        let refresh_token_url = format!("{}/auth/plugin-ui/refresh-token", self.base_url);
        let refresh_response = self
            .client
            .get(&refresh_token_url)
            .bearer_auth(&access_token_resp.access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Failed to get refresh token: {}", e))?;

        if !refresh_response.status().is_success() {
            let status = refresh_response.status();
            let text = refresh_response.text().await.unwrap_or_default();
            return Err(format!("Refresh token request failed: {} {}", status, text));
        }

        let refresh_token_resp: RefreshTokenResponse = refresh_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse refresh token response: {}", e))?;

        Ok(LoginAuthData {
            access_token: access_token_resp.access_token,
            refresh_token: refresh_token_resp.refresh_token,
            refresh_token_expires_at: refresh_token_resp.refresh_token_expires_at,
        })
    }

    // Login with GitHub - complete OAuth flow
    pub async fn login_with_github(&self) -> Result<LoginAuthData, String> {
        // Step 1: Initialize login
        let init_url = format!("{}/auth/github/login", self.base_url);
        let init_response = self
            .client
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

        let login_init: LoginInitResponse = init_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse login init response: {}", e))?;

        // Step 2: Get access token (polling)
        let access_token_url = format!("{}/auth/github/access-token", self.base_url);
        let access_response = self
            .client
            .get(&access_token_url)
            .bearer_auth(&login_init.read_token_jwt)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Failed to get GitHub access token: {}", e))?;

        if !access_response.status().is_success() {
            let status = access_response.status();
            let text = access_response.text().await.unwrap_or_default();
            return Err(format!("GitHub access token request failed: {} {}", status, text));
        }

        let access_token_resp: AccessTokenResponse = access_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse access token response: {}", e))?;

        // Step 3: Get refresh token
        let refresh_token_url = format!("{}/auth/plugin-ui/refresh-token", self.base_url);
        let refresh_response = self
            .client
            .get(&refresh_token_url)
            .bearer_auth(&access_token_resp.access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Failed to get refresh token: {}", e))?;

        if !refresh_response.status().is_success() {
            let status = refresh_response.status();
            let text = refresh_response.text().await.unwrap_or_default();
            return Err(format!("Refresh token request failed: {} {}", status, text));
        }

        let refresh_token_resp: RefreshTokenResponse = refresh_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse refresh token response: {}", e))?;

        Ok(LoginAuthData {
            access_token: access_token_resp.access_token,
            refresh_token: refresh_token_resp.refresh_token,
            refresh_token_expires_at: refresh_token_resp.refresh_token_expires_at,
        })
    }

    // Get login URL (used for opening browser)
    pub fn get_login_url(&self, login_init: &LoginInitResponse) -> String {
        login_init.login_url.clone()
    }

    // Fetch user configuration
    pub async fn fetch_user_config(&self) -> Result<UserConfig, String> {
        let url = format!("{}/user/info", self.base_url);

        self.make_authenticated_request(|access_token| {
            let url = url.clone();
            let client = self.client.clone();
            async move {
                let response = client
                    .get(&url)
                    .bearer_auth(&access_token)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to fetch user config: {}", e))?;

                if response.status().is_success() {
                    let user_config: UserConfig = response
                        .json()
                        .await
                        .map_err(|e| format!("Failed to parse user config response: {}", e))?;
                    Ok(user_config)
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    Err("HTTP 401".to_string())
                } else {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    Err(format!("Failed to fetch user config: {} {}", status, text))
                }
            }
        })
        .await
    }

    // Update user configuration
    pub async fn update_user_config(&self, update_data: UpdateUserRequest) -> Result<(), String> {
        let url = format!("{}/user/update", self.base_url);

        self.make_authenticated_request(|access_token| {
            let url = url.clone();
            let update_data = update_data.clone();
            let client = self.client.clone();
            async move {
                let response = client
                    .post(&url)
                    .bearer_auth(&access_token)
                    .json(&update_data)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to update user config: {}", e))?;

                if response.status().is_success() {
                    Ok(())
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    Err("HTTP 401".to_string())
                } else {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    Err(format!("Failed to update user config: {} {}", status, text))
                }
            }
        })
        .await
    }
}
