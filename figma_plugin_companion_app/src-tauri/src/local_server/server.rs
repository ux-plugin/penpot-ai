use crate::backend_client::BackendClient;
use crate::config::AppConfig;
use crate::local_server::audio::{AudioCommand, AudioManager};
use crate::local_server::audio_playback::{AudioPlaybackManager, PlaybackCommand};
use crate::local_server::encryption::EncryptionState;
use crate::local_server::state::StateForLocalServerHandler;
use crate::local_server::ws_handlers::ws_handler;
use axum::{routing::get, Router};
use serde::Serialize;
use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, RwLock};
use tower_http::cors::{Any, CorsLayer};

// Internal mutable state for the LocalServer
struct ServerState {
    // Server state - None = not started, Some(port) = running
    port: Option<u16>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_handle: Option<tokio::task::JoinHandle<()>>,
    handler_state: Option<StateForLocalServerHandler>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    Starting,
    Success,
    Error,
    Stopped,
}

#[derive(Serialize, Clone)]
pub struct ServerStatusPayload {
    pub status: ServerStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// Combined LocalServer structure with integrated state management and dependency injection
pub struct LocalServer {
    // Protected mutable state
    state: AsyncMutex<ServerState>,

    // Immutable dependencies (injected via constructor)
    backend_client: Arc<BackendClient>,
    encryption_state: Arc<RwLock<EncryptionState>>,
    config: Arc<AppConfig>,
    app_handle: Arc<AsyncMutex<Option<AppHandle>>>,
}

impl LocalServer {
    // Constructor with dependency injection
    pub fn new(backend_client: Arc<BackendClient>, encryption_state: Arc<RwLock<EncryptionState>>, config: Arc<AppConfig>) -> Self {
        Self {
            state: AsyncMutex::new(ServerState {
                port: None, // None = not started, Some(port) = running
                shutdown_tx: None,
                server_handle: None,
                handler_state: None,
            }),
            backend_client,
            encryption_state,
            config,
            app_handle: Arc::new(AsyncMutex::new(None)),
        }
    }

    // Set the app handle for emitting events
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.lock().await;
        *app_handle = Some(handle);
    }

    // Emit server status event
    async fn emit_status(&self, status: ServerStatus, error: Option<String>) {
        let app_handle = self.app_handle.lock().await;
        if let Some(handle) = app_handle.as_ref() {
            let payload = ServerStatusPayload { status, error };
            if let Err(e) = handle.emit("server-status-changed", payload) {
                tracing::error!("Failed to emit server status event: {}", e);
            }
        }
    }

    // Check if the server is running
    pub async fn is_running(&self) -> bool {
        let state = self.state.lock().await;
        state.port.is_some()
    }

    // Get the port the server is running on (if running)
    pub async fn port(&self) -> Option<u16> {
        let state = self.state.lock().await;
        state.port
    }

    // This is the main method to start the server
    pub async fn get_or_start(&self) -> Result<u16, String> {
        let mut state = self.state.lock().await;

        // If already running, return existing port
        if let Some(port) = state.port {
            return Ok(port);
        }

        // Emit starting status
        self.emit_status(ServerStatus::Starting, None).await;

        // Start the server
        let port = match self._start(&mut state).await {
            Ok(port) => port,
            Err(e) => {
                // Emit error status
                self.emit_status(ServerStatus::Error, Some(e.clone())).await;
                return Err(e);
            }
        };

        // Update backend client with port - if this fails, clean up the server.
        match self.backend_client.update_port(Some(port)).await {
            Ok(_) => {
                state.port = Some(port);
                tracing::info!("Local server initialized on port {}", port);
                // Emit success status
                self.emit_status(ServerStatus::Success, None).await;
                Ok(port)
            }
            Err(e) => {
                // Clean up the started server
                self._shutdown(&mut state).await;
                // Emit error status
                self.emit_status(ServerStatus::Error, Some(e.clone())).await;
                Err(e)
            }
        }
    }

    // Stop the server if it's running
    pub async fn stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;

        if state.port.is_none() {
            tracing::warn!("Server is not running");
            return Ok(());
        }

        // Close all active WebSocket connections before shutting down the server
        if let Some(handler_state) = &state.handler_state {
            tracing::debug!("Closing active WebSocket connections");
            handler_state.close_all_connections().await;
        }

        self._shutdown(&mut state).await;
        state.port = None;
        state.handler_state = None;
        // Emit stopped status
        self.emit_status(ServerStatus::Stopped, None).await;
        tracing::info!("Local server stopped successfully");
        Ok(())
    }

    // Start the server on localhost with any available port
    async fn _start(&self, state: &mut ServerState) -> Result<u16, String> {
        // Create a channel for audio recording commands
        let (audio_command_tx, audio_command_rx) = mpsc::channel::<AudioCommand>(10);

        // Clone config for the audio manager thread
        let audio_sample_rate = self.config.audio_sample_rate;
        
        // Start the audio manager in a separate thread
        thread::spawn(move || {
            // Create a new audio manager with a configured sample rate
            let mut audio_manager = AudioManager::new(audio_command_rx, audio_sample_rate);

            // Create a tokio runtime for the audio manager
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create Tokio runtime for audio manager");

            // Run the audio manager
            rt.block_on(async {
                audio_manager.run().await;
            });
        });

        // Create a channel for audio playback commands
        let (playback_command_tx, playback_command_rx) = mpsc::channel::<PlaybackCommand>(10);
        
        // Start the playback manager in a separate thread
        thread::spawn(move || {
            // Create a new playback manager
            let mut playback_manager = AudioPlaybackManager::new(playback_command_rx);

            // Create a tokio runtime for the playback manager
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create Tokio runtime for playback manager");

            // Run the playback manager
            rt.block_on(async {
                playback_manager.run().await;
            });
        });

        // Create a server state with injected dependencies
        // (encryption_state is already Arc<RwLock<>>)
        let server_state = StateForLocalServerHandler::new(
            audio_command_tx,
            playback_command_tx,
            self.backend_client.clone(),
            self.encryption_state.clone(),
            self.config.clone(),
        );

        // Store the handler state for shutdown access
        state.handler_state = Some(server_state.clone());

        // Configure CORS to allow cross-origin requests from Figma plugin
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::OPTIONS,
            ])
            .allow_headers([axum::http::header::CONTENT_TYPE]);

        let app = Router::new()
            // WebSocket endpoint
            .route("/companion", get(ws_handler))
            .layer(cors)
            .with_state(server_state);

        // Bind to localhost with port 0 (any available port)
        let addr = match ("localhost", 0).to_socket_addrs() {
            Ok(mut addrs) => addrs
                .next()
                .ok_or_else(|| "Failed to resolve localhost".to_string())?,
            Err(e) => return Err(format!("Failed to resolve localhost: {}", e)),
        };
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("Failed to bind server: {}", e))?;

        // Get the actual port that was assigned
        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?;
        let port = local_addr.port();

        // Create a channel for shutdown signal
        let (tx, rx) = oneshot::channel::<()>();
        state.shutdown_tx = Some(tx);

        // Spawn the server in a separate task and store the handle
        let server_handle = tokio::spawn(async move {
            tracing::info!("Local server listening on {}", local_addr);

            // Start the server with a graceful shutdown
            match axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    rx.await.ok();
                    tracing::debug!("Local server shutting down");
                })
                .await
            {
                Ok(_) => tracing::info!("Server terminated normally"),
                Err(e) => tracing::error!("Server failed to start: {}", e),
            }
        });

        // Store the server handle
        state.server_handle = Some(server_handle);

        Ok(port)
    }

    // Shutdown the server
    async fn _shutdown(&self, state: &mut ServerState) {
        if let Some(tx) = state.shutdown_tx.take() {
            let _ = tx.send(());
            tracing::debug!("Shutdown signal sent to local server");

            // Wait for the server task to complete
            if let Some(handle) = state.server_handle.take() {
                let _ = handle.await;
                tracing::debug!("Server shutdown completed");
            }
        }
    }
}
