use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use super::types::{LoginInitResponse, LoginAuthData, Auth0PluginTokensResponse};

impl super::auth::BackendClient {
    // Login with Auth0 — Auth0 is the sole identity issuer.
    // Flow: GET /auth/auth0/login → open browser to login URL → poll
    // GET /auth/auth0/access-token?readToken=<readToken> until tokens are available.
    pub async fn login_with_auth0(&self, app: AppHandle) -> Result<LoginAuthData, String> {
        tracing::debug!("Starting Auth0 OAuth flow");

        let init_url = format!("{}/auth/auth0/login", self.base_url);
        tracing::trace!("Requesting Auth0 login init from: {}", init_url);

        let init_response = self
            .client
            .get(&init_url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to initialize Auth0 login: {}", e);
                format!("Failed to initialize Auth0 login: {}", e)
            })?;

        if !init_response.status().is_success() {
            let status = init_response.status();
            let text = init_response.text().await.unwrap_or_default();
            tracing::error!("Auth0 login init failed with status {}: {}", status, text);
            return Err(format!("Auth0 login request failed: {} {}", status, text));
        }

        let login_init: LoginInitResponse = init_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse Auth0 login init response: {}", e);
                format!("Failed to parse login init response: {}", e)
            })?;

        tracing::info!("Auth0 login URL: {}", login_init.login_url);

        app.opener()
            .open_url(&login_init.login_url, None::<&str>)
            .map_err(|e| {
                tracing::error!("Failed to open Auth0 login URL: {}", e);
                format!("Failed to open login URL: {}", e)
            })?;

        tracing::debug!("Auth0 login initialized, polling for tokens");

        let access_token_url = format!("{}/auth/auth0/access-token", self.base_url);
        let tokens_response = self
            .client
            .get(&access_token_url)
            .query(&[("readToken", &login_init.read_token)])
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to get Auth0 tokens: {}", e);
                format!("Failed to get Auth0 tokens: {}", e)
            })?;

        if !tokens_response.status().is_success() {
            let status = tokens_response.status();
            let text = tokens_response.text().await.unwrap_or_default();
            tracing::error!("Auth0 token request failed with status {}: {}", status, text);
            return Err(format!("Auth0 token request failed: {} {}", status, text));
        }

        let tokens: Auth0PluginTokensResponse = tokens_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse Auth0 tokens response: {}", e);
                format!("Failed to parse Auth0 tokens response: {}", e)
            })?;

        tracing::info!("Auth0 OAuth flow completed successfully");

        Ok(LoginAuthData {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            refresh_token_expires_at: tokens.refresh_token_expires_at,
        })
    }
}
