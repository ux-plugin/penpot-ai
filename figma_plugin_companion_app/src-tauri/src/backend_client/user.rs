use tauri_plugin_http::reqwest;
use super::types::{UserConfig, UpdateUserRequest};

impl super::auth::BackendClient {
    // Fetch user configuration
    pub async fn fetch_user_config(&self) -> Result<UserConfig, String> {
        tracing::debug!("Fetching user configuration from backend");
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
                    .map_err(|e| {
                        tracing::error!("Failed to fetch user config: {}", e);
                        format!("Failed to fetch user config: {}", e)
                    })?;

                if response.status().is_success() {
                    let user_config: UserConfig = response
                        .json()
                        .await
                        .map_err(|e| {
                            tracing::error!("Failed to parse user config response: {}", e);
                            format!("Failed to parse user config response: {}", e)
                        })?;
                    tracing::trace!("User config fetched successfully");
                    Ok(user_config)
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    tracing::debug!("Received 401, will trigger token refresh");
                    Err("HTTP 401".to_string())
                } else {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    tracing::error!("Failed to fetch user config with status {}: {}", status, text);
                    Err(format!("Failed to fetch user config: {} {}", status, text))
                }
            }
        })
        .await
    }

    // Update user configuration
    pub async fn update_user_config(&self, update_data: UpdateUserRequest) -> Result<(), String> {
        tracing::debug!("Updating user configuration");
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
                    .map_err(|e| {
                        tracing::error!("Failed to update user config: {}", e);
                        format!("Failed to update user config: {}", e)
                    })?;

                if response.status().is_success() {
                    tracing::info!("User configuration updated successfully");
                    Ok(())
                } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    tracing::debug!("Received 401, will trigger token refresh");
                    Err("HTTP 401".to_string())
                } else {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    tracing::error!("Failed to update user config with status {}: {}", status, text);
                    Err(format!("Failed to update user config: {} {}", status, text))
                }
            }
        })
        .await
    }
}