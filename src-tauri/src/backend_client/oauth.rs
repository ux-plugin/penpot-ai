use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use super::types::{LoginInitResponse, AccessTokenResponse, RefreshTokenResponse, LoginAuthData, Auth0AccessTokenResponse};

impl super::auth::BackendClient {
    // Login with Figma - complete OAuth flow
    pub async fn login_with_figma(&self, app: AppHandle) -> Result<LoginAuthData, String> {
        tracing::debug!("Starting Figma OAuth flow");
        
        // Step 1: Initialize login
        let init_url = format!("{}/auth/figma/login", self.base_url);
        tracing::trace!("Requesting Figma login init from: {}", init_url);
        
        let init_response = self
            .client
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
            tracing::error!("Figma login init failed with status {}: {}", status, text);
            return Err(format!("Figma login request failed: {} {}", status, text));
        }

        let login_init: LoginInitResponse = init_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse Figma login init response: {}", e);
                format!("Failed to parse login init response: {}", e)
            })?;

        app.opener()
            .open_url(&login_init.login_url, None::<&str>)
            .map_err(|e| {
                tracing::error!("Failed to open login URL: {}", e);
                format!("Failed to open login URL: {}", e)
            })?;
        
        tracing::debug!("Figma login initialized, polling for access token");

        // Step 2: Get access token (polling)
        let access_token_url = format!("{}/auth/figma/access-token", self.base_url);
        let access_response = self
            .client
            .get(&access_token_url)
            .bearer_auth(&login_init.read_token_jwt)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to get Figma access token: {}", e);
                format!("Failed to get Figma access token: {}", e)
            })?;

        if !access_response.status().is_success() {
            let status = access_response.status();
            let text = access_response.text().await.unwrap_or_default();
            tracing::error!("Figma access token request failed with status {}: {}", status, text);
            return Err(format!("Figma access token request failed: {} {}", status, text));
        }

        let access_token_resp: AccessTokenResponse = access_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse Figma access token response: {}", e);
                format!("Failed to parse access token response: {}", e)
            })?;
        
        tracing::debug!("Figma access token obtained, fetching refresh token");

        // Step 3: Get refresh token
        let refresh_token_url = format!("{}/auth/plugin-ui/refresh-token", self.base_url);
        let refresh_response = self
            .client
            .get(&refresh_token_url)
            .bearer_auth(&access_token_resp.access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to get refresh token: {}", e);
                format!("Failed to get refresh token: {}", e)
            })?;

        if !refresh_response.status().is_success() {
            let status = refresh_response.status();
            let text = refresh_response.text().await.unwrap_or_default();
            tracing::error!("Refresh token request failed with status {}: {}", status, text);
            return Err(format!("Refresh token request failed: {} {}", status, text));
        }

        let refresh_token_resp: RefreshTokenResponse = refresh_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse refresh token response: {}", e);
                format!("Failed to parse refresh token response: {}", e)
            })?;

        tracing::info!("Figma OAuth flow completed successfully");
        
        Ok(LoginAuthData {
            access_token: access_token_resp.access_token,
            refresh_token: refresh_token_resp.refresh_token,
            refresh_token_expires_at: refresh_token_resp.refresh_token_expires_at,
        })
    }

    // Login with GitHub - complete OAuth flow
    pub async fn login_with_github(&self, app: AppHandle) -> Result<LoginAuthData, String> {
        tracing::debug!("Starting GitHub OAuth flow");
        
        // Step 1: Initialize login
        let init_url = format!("{}/auth/github/login", self.base_url);
        tracing::trace!("Requesting GitHub login init from: {}", init_url);
        
        let init_response = self
            .client
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
            tracing::error!("GitHub login init failed with status {}: {}", status, text);
            return Err(format!("GitHub login request failed: {} {}", status, text));
        }

        let login_init: LoginInitResponse = init_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse GitHub login init response: {}", e);
                format!("Failed to parse login init response: {}", e)
            })?;
        
        tracing::debug!("GitHub login initialized, polling for access token");

        // Step 2: Get access token (polling)
        let access_token_url = format!("{}/auth/github/access-token", self.base_url);
        let access_response = self
            .client
            .get(&access_token_url)
            .bearer_auth(&login_init.read_token_jwt)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to get GitHub access token: {}", e);
                format!("Failed to get GitHub access token: {}", e)
            })?;

        if !access_response.status().is_success() {
            let status = access_response.status();
            let text = access_response.text().await.unwrap_or_default();
            tracing::error!("GitHub access token request failed with status {}: {}", status, text);
            return Err(format!("GitHub access token request failed: {} {}", status, text));
        }

        let access_token_resp: AccessTokenResponse = access_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse GitHub access token response: {}", e);
                format!("Failed to parse access token response: {}", e)
            })?;
        
        app.opener()
            .open_url(&login_init.login_url, None::<&str>)
            .map_err(|e| {
                tracing::error!("Failed to open login URL: {}", e);
                format!("Failed to open login URL: {}", e)
            })?;
        
        tracing::debug!("GitHub access token obtained, fetching refresh token");

        // Step 3: Get refresh token
        let refresh_token_url = format!("{}/auth/plugin-ui/refresh-token", self.base_url);
        let refresh_response = self
            .client
            .get(&refresh_token_url)
            .bearer_auth(&access_token_resp.access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to get refresh token: {}", e);
                format!("Failed to get refresh token: {}", e)
            })?;

        if !refresh_response.status().is_success() {
            let status = refresh_response.status();
            let text = refresh_response.text().await.unwrap_or_default();
            tracing::error!("Refresh token request failed with status {}: {}", status, text);
            return Err(format!("Refresh token request failed: {} {}", status, text));
        }

        let refresh_token_resp: RefreshTokenResponse = refresh_response
            .json()
            .await
            .map_err(|e| {
                tracing::error!("Failed to parse refresh token response: {}", e);
                format!("Failed to parse refresh token response: {}", e)
            })?;

        tracing::info!("GitHub OAuth flow completed successfully");
        
        Ok(LoginAuthData {
            access_token: access_token_resp.access_token,
            refresh_token: refresh_token_resp.refresh_token,
            refresh_token_expires_at: refresh_token_resp.refresh_token_expires_at,
        })
    }

    // Login with Auth0 - complete OAuth flow (2-step: tokens returned together)
    pub async fn login_with_auth0(&self, app: AppHandle) -> Result<LoginAuthData, String> {
        tracing::debug!("Starting Auth0 OAuth flow");

        // Step 1: Initialize login
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
        println!("DEBUG: opening browser with URL: {}", login_init.login_url);

        let open_result = app.opener().open_url(&login_init.login_url, None::<&str>);
        println!("DEBUG: open_url result: {:?}", open_result);
        open_result.map_err(|e| {
            tracing::error!("Failed to open Auth0 login URL: {}", e);
            format!("Failed to open login URL: {}", e)
        })?;

        tracing::debug!("Auth0 login initialized, polling for tokens");

        // Step 2: Get access + refresh tokens together (Auth0 flow returns both in one call)
        let access_token_url = format!("{}/auth/auth0/access-token", self.base_url);
        let tokens_response = self
            .client
            .get(&access_token_url)
            .bearer_auth(&login_init.read_token_jwt)
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

        let tokens: Auth0AccessTokenResponse = tokens_response
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

    // Get login URL (used for opening browser)
    pub fn get_login_url(&self, login_init: &LoginInitResponse) -> String {
        login_init.login_url.clone()
    }
}