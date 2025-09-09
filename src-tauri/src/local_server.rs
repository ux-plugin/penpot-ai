use crate::audio::{AudioCommand, AudioManager};
use crate::backend_client::BackendClient;
use axum::{
    debug_handler,
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::get,
    Router,
};
use base64::{engine::general_purpose, Engine as _};
use bytes::Bytes;
use std::convert::Infallible;
use std::net::ToSocketAddrs;
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};

// Server state that will be shared across handlers
#[derive(Clone)]
pub struct StateForLocalServerHandler {
    audio_command_tx: Arc<Mutex<Option<mpsc::Sender<AudioCommand>>>>,
    backend_client: Arc<BackendClient>,
}

// Internal mutable state for the LocalServer
struct ServerState {
    // Server state - None = not started, Some(port) = running
    port: Option<u16>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_handle: Option<tokio::task::JoinHandle<()>>,
}

// Combined LocalServer structure with integrated state management and dependency injection
pub struct LocalServer {
    // Protected mutable state
    state: AsyncMutex<ServerState>,
    
    // Immutable dependencies (injected via constructor)
    backend_client: Arc<BackendClient>,
}

impl LocalServer {
    // Constructor with dependency injection
    pub fn new(backend_client: Arc<BackendClient>) -> Self {
        Self {
            state: AsyncMutex::new(ServerState {
                port: None, // None = not started, Some(port) = running
                shutdown_tx: None,
                server_handle: None,
            }),
            backend_client,
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

        // Start the server
        let port = self._start(&mut state).await?;

        // Update backend client with port - if this fails, clean up the server
        match self.backend_client.update_port(Some(port)).await {
            Ok(_) => {
                state.port = Some(port);
                println!("Local server initialized on port {}", port);
                Ok(port)
            }
            Err(e) => {
                // Clean up the started server
                self._shutdown(&mut state).await;
                Err(e)
            }
        }
    }

    // Stop the server if it's running
    pub async fn stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        
        if state.port.is_none() {
            println!("⚠️  Warning: Server is not running");
            return Ok(());
        }

        self._shutdown(&mut state).await;
        state.port = None;
        println!("Local server stopped successfully");
        Ok(())
    }

    // Start the server on localhost with any available port
    async fn _start(&self, state: &mut ServerState) -> Result<u16, String> {
        // Create a channel for audio commands
        let (audio_command_tx, audio_command_rx) = mpsc::channel::<AudioCommand>(10);

        // Start the audio manager in a separate thread
        thread::spawn(move || {
            // Create a new audio manager
            let mut audio_manager = AudioManager::new(audio_command_rx);

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

        // Create a simple router with a health check endpoint
        let server_state = StateForLocalServerHandler {
            audio_command_tx: Arc::new(Mutex::new(Some(audio_command_tx))),
            backend_client: self.backend_client.clone(),
        };

        let app = Router::new()
            .route("/init", get(handshake))
            .route("/start-recording", get(start_recording))
            .route("/stop-recording", get(stop_recording))
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
            println!("Local server listening on {}", local_addr);

            // Start the server with a graceful shutdown
            match axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    rx.await.ok();
                    println!("Local server shutting down");
                })
                .await
            {
                Ok(_) => println!("Server terminated normally"),
                Err(e) => eprintln!("Server failed to start: {}", e),
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
            println!("Shutdown signal sent to local server");

            // Wait for the server task to complete
            if let Some(handle) = state.server_handle.take() {
                let _ = handle.await;
                println!("Server shutdown completed");
            }
        }
    }
}

async fn handshake(
    State(state): State<StateForLocalServerHandler>,
) -> impl IntoResponse {
    let backend_client = &state.backend_client;
    // TODO: Implement handshake logic
    "OK"
}

#[debug_handler]
async fn start_recording(
    State(state): State<StateForLocalServerHandler>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let (audio_tx, audio_rx) = mpsc::channel::<Bytes>(10);

    // First, get the sender outside to await
    let audio_command_tx = state
        .audio_command_tx
        .lock()
        .unwrap()
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone(); // Clone the sender

    // Now use it after the guard is dropped
    if (audio_command_tx.send(AudioCommand::Start(audio_tx)).await).is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let stream = ReceiverStream::new(audio_rx).map(|bytes| {
        let base64_data = general_purpose::STANDARD.encode(bytes);
        let event = Event::default().data(base64_data);
        Ok(event)
    });

    Ok(Sse::new(stream))
}

#[debug_handler]
async fn stop_recording(State(state): State<StateForLocalServerHandler>) -> impl IntoResponse {
    // Clone the sender outside the mutex lock
    let audio_command_tx = {
        let guard = state.audio_command_tx.lock().unwrap();
        guard.as_ref().map(|tx| tx.clone())
    };

    // Now use the cloned sender
    match audio_command_tx {
        Some(tx) => {
            let _ = tx.send(AudioCommand::Stop).await;
            (StatusCode::OK, "Recording stopped")
        }
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to stop recording",
        ),
    }
}
