use tauri_plugin_http::reqwest;
use super::types::EncryptionKeyResponse;

impl super::auth::BackendClient {
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

    // Public method to get an encryption key with 401 handling
    pub async fn get_key(
        &self,
    ) -> Result<EncryptionKeyResponse, String> {
        self.get_encryption_key().await
    }
}