mod types;
mod auth;
mod encryption;
mod config;
mod oauth;
mod user;

// Re-export all public types
pub use types::*;

// Re-export BackendClient
pub use auth::BackendClient;

use crate::auth::AuthState;
use std::sync::Arc;
use tauri_plugin_http::reqwest;

impl BackendClient {
    pub fn new(base_url: String, auth_state: Arc<AuthState>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
            auth_state,
        }
    }
}