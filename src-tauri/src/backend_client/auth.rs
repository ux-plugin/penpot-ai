use crate::auth::AuthState;
use std::sync::Arc;
use tauri_plugin_http::reqwest;
use super::types::{FigmaPluginRefreshAccessTokenRequest, RefreshAccessTokenResponse};

pub struct BackendClient {
    pub(super) client: reqwest::Client,
    pub(super) base_url: String,
    pub(super) auth_state: Arc<AuthState>,
}

impl BackendClient {
    // Refresh access token using refresh token and user ID
    pub(super) async fn refresh_access_token(
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

    // Generic method to handle authenticated requests with 401 retry logic
    pub(super) async fn make_authenticated_request<F, Fut, T>(
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
}