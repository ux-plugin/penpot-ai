use serde::{Deserialize, Serialize};

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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Auth0AccessTokenResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "refreshTokenExpiresAt")]
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