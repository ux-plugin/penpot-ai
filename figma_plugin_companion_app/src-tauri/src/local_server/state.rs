use crate::backend_client::BackendClient;
use crate::config::AppConfig;
use crate::local_server::audio::AudioCommand;
use crate::local_server::audio_playback::PlaybackCommand;
use crate::local_server::audio_stream::AudioStream;
use crate::local_server::encryption::EncryptionState;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{stream::SplitSink, SinkExt};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

type WebSocketSender = Arc<tokio::sync::Mutex<SplitSink<WebSocket, Message>>>;

// Server state that will be shared across handlers
#[derive(Clone)]
pub struct StateForLocalServerHandler {
    pub audio_command_tx: Arc<Mutex<Option<mpsc::Sender<AudioCommand>>>>,
    pub playback_command_tx: Arc<Mutex<Option<mpsc::Sender<PlaybackCommand>>>>,
    pub backend_client: Arc<BackendClient>,
    pub encryption_state: Arc<RwLock<EncryptionState>>,
    pub config: Arc<AppConfig>,
    pub active_stream: Arc<Mutex<Option<AudioStream>>>,
    pub active_connections: Arc<Mutex<HashMap<Uuid, WebSocketSender>>>,
}

impl StateForLocalServerHandler {
    pub fn new(
        audio_command_tx: mpsc::Sender<AudioCommand>,
        playback_command_tx: mpsc::Sender<PlaybackCommand>,
        backend_client: Arc<BackendClient>,
        encryption_state: Arc<RwLock<EncryptionState>>,
        config: Arc<AppConfig>,
    ) -> Self {
        Self {
            audio_command_tx: Arc::new(Mutex::new(Some(audio_command_tx))),
            playback_command_tx: Arc::new(Mutex::new(Some(playback_command_tx))),
            backend_client,
            encryption_state,
            config,
            active_stream: Arc::new(Mutex::new(None)),
            active_connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a new WebSocket connection
    pub fn register_connection(&self, id: Uuid, sender: Arc<tokio::sync::Mutex<SplitSink<WebSocket, Message>>>) {
        let mut connections = self.active_connections.lock().unwrap();
        connections.insert(id, sender);
        tracing::info!("WebSocket connection registered: {} (total active: {})", id, connections.len());
    }

    /// Unregister a WebSocket connection
    pub fn unregister_connection(&self, id: &Uuid) {
        let mut connections = self.active_connections.lock().unwrap();
        if connections.remove(id).is_some() {
            tracing::info!("WebSocket connection unregistered: {} (total active: {})", id, connections.len());
        } else {
            tracing::warn!("Attempted to unregister non-existent connection: {}", id);
        }
    }

    /// Close all active WebSocket connections
    pub async fn close_all_connections(&self) {
        let connections = {
            let mut conns = self.active_connections.lock().unwrap();
            let connections: Vec<_> = conns.drain().collect();
            connections
        };

        tracing::info!("Closing {} active WebSocket connection(s)", connections.len());

        for (id, sender) in connections {
            let mut sender_lock = sender.lock().await;
            if let Err(e) = sender_lock.send(Message::Close(None)).await {
                tracing::error!("Failed to send close frame to connection {}: {}", id, e);
            } else {
                tracing::debug!("Sent close frame to connection: {}", id);
            }
        }
    }
}

/// RAII guard for WebSocket connections
/// Automatically deregisters connection when dropped (guarantees cleanup)
pub struct ConnectionGuard {
    id: Uuid,
    state: StateForLocalServerHandler,
}

impl ConnectionGuard {
    /// Create a new connection guard and automatically register the connection
    pub fn new(state: StateForLocalServerHandler, sender: WebSocketSender) -> Self {
        let id = Uuid::new_v4();
        state.register_connection(id, sender);
        tracing::debug!("ConnectionGuard created for: {}", id);
        Self { id, state }
    }

    /// Get the connection ID
    pub fn id(&self) -> Uuid {
        self.id
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        tracing::debug!("ConnectionGuard dropping for: {} (auto-deregistering)", self.id);
        self.state.unregister_connection(&self.id);
    }
}
