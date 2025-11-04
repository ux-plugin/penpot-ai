use tauri_plugin_http::reqwest;
use super::types::AppState;

impl super::auth::BackendClient {
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

    // Public method to update app config with 401 handling
    pub async fn update_port(
        &self,
        port: Option<u16>,
    ) -> Result<(), String> {
        self.update_app_config(port).await
    }
}