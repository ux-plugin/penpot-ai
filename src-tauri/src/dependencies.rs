use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;
use crate::auth::AuthState;
use crate::backend_client::BackendClient;
use crate::local_server::{LocalServer, encryption::EncryptionState};
use crate::config::AppConfig;

#[derive(Clone)]
pub struct AppDependencies {
    pub config: Arc<AppConfig>, // Eagerly initialized
    auth_state: Arc<OnceLock<Arc<AuthState>>>,
    backend_client: Arc<OnceLock<Arc<BackendClient>>>,
    local_server: Arc<OnceLock<Arc<LocalServer>>>,
    encryption_state: Arc<OnceLock<Arc<RwLock<EncryptionState>>>>,
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
            encryption_state: Arc::new(OnceLock::new()),
        })
    }

    pub fn config(&self) -> Arc<AppConfig> {
        self.config.clone()
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
    
    // Lazy getter for EncryptionState singleton
    pub fn encryption_state(&self) -> Arc<RwLock<EncryptionState>> {
        self.encryption_state.get_or_init(|| {
            EncryptionState::get_or_init(self.config())
        }).clone()
    }

    // Lazy getter for LocalServer
    pub fn local_server(&self) -> Arc<LocalServer> {
        self.local_server.get_or_init(|| {
            Arc::new(LocalServer::new(self.backend_client(), self.encryption_state(), self.config()))
        }).clone()
    }
}
