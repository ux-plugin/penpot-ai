use crate::backend_client::BackendClient;
use crate::config::AppConfig;
use crate::local_server::audio::AudioCommand;
use crate::local_server::encryption::EncryptionState;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, RwLock};

// Server state that will be shared across handlers
#[derive(Clone)]
pub struct StateForLocalServerHandler {
    pub audio_command_tx: Arc<Mutex<Option<mpsc::Sender<AudioCommand>>>>,
    pub backend_client: Arc<BackendClient>,
    pub encryption_state: Arc<RwLock<EncryptionState>>,
    pub config: Arc<AppConfig>,
}

impl StateForLocalServerHandler {
    pub fn new(
        audio_command_tx: mpsc::Sender<AudioCommand>,
        backend_client: Arc<BackendClient>,
        encryption_state: Arc<RwLock<EncryptionState>>,
        config: Arc<AppConfig>,
    ) -> Self {
        Self {
            audio_command_tx: Arc::new(Mutex::new(Some(audio_command_tx))),
            backend_client,
            encryption_state,
            config,
        }
    }
}