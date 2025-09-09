use std::sync::{Arc, OnceLock};
use crate::auth::AuthState;
use crate::backend_client::BackendClient;
use crate::local_server::LocalServer;
use crate::config::AppConfig;

#[derive(Clone)]
pub struct AppDependencies {
    pub config: Arc<AppConfig>, // Eagerly initialized
    auth_state: Arc<OnceLock<Arc<AuthState>>>,
    backend_client: Arc<OnceLock<Arc<BackendClient>>>,
    local_server: Arc<OnceLock<Arc<LocalServer>>>,
}

impl AppDependencies {
    pub fn new() -> Result<Self, String> {
        // Only initialize config eagerly
        let config = Arc::new(AppConfig::load()?);

        Ok(Self {
            config,
            auth_state: Arc::new(OnceLock::new()),
            backend_client: Arc::new(OnceLock::new()),
            local_server: Arc::new(OnceLock::new()),
        })
    }
    
    // Lazy getter for AuthState
    pub fn auth_state(&self) -> Arc<AuthState> {
        self.auth_state.get_or_init(|| {
            Arc::new(AuthState::new()) // This will only run on first access
        }).clone()
    }
    
    // Lazy getter for BackendClient
    pub fn backend_client(&self) -> Arc<BackendClient> {
        self.backend_client.get_or_init(|| {
            Arc::new(BackendClient::new(
                self.config.backend_base_url.clone(),
                self.auth_state()
            ))
        }).clone()
    }
    
    // Lazy getter for LocalServer
    pub fn local_server(&self) -> Arc<LocalServer> {
        self.local_server.get_or_init(|| {
            Arc::new(LocalServer::new(self.backend_client()))
        }).clone()
    }
}