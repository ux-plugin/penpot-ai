use std::convert::Infallible;
use crate::audio::{AudioCommand, AudioManager};
use axum::{debug_handler, extract::State, http::StatusCode, response::{
    sse::{Event, Sse},
    IntoResponse,
}, routing::get, Router};
use bytes::Bytes;
use std::net::ToSocketAddrs;
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};
use base64::{Engine as _, engine::{general_purpose}};


// Server state that will be shared across handlers
#[derive(Clone)]
pub struct ServerState {
    audio_command_tx: Arc<Mutex<Option<mpsc::Sender<AudioCommand>>>>,
}

// Structure to hold the server instance and shutdown signal
pub struct LocalServer {
    port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl LocalServer {
    // Create a new server instance
    pub fn new() -> Self {
        Self {
            port: 0, // Will be set when the server starts
            shutdown_tx: None,
        }
    }

    // Start the server on localhost with any available port
    pub async fn start(&mut self) -> Result<u16, String> {
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
        let app_state = ServerState {
            audio_command_tx: Arc::new(Mutex::new(Some(audio_command_tx))),
        };

        let app = Router::new()
            .route("/health", get(health_check))
            .route("/start-recording", get(start_recording))
            .route("/stop-recording", get(stop_recording))
            .with_state(app_state);

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
        self.port = local_addr.port();

        // Create a channel for shutdown signal
        let (tx, rx) = oneshot::channel::<()>();
        self.shutdown_tx = Some(tx);

        // Spawn the server in a separate task
        tokio::spawn(async move {
            println!("Local server listening on {}", local_addr);

            // Start the server with graceful shutdown
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

        Ok(self.port)
    }

    // Shutdown the server
    pub async fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            println!("Shutdown signal sent to local server");
        }
    }

    // Get the port the server is running on
    pub fn port(&self) -> u16 {
        self.port
    }
}

// Health check endpoint
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "Server is running")
}

#[debug_handler]
async fn start_recording(
    State(state): State<ServerState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let (audio_tx, audio_rx) = mpsc::channel::<Bytes>(10);

    // First get the sender outside of the await
    let audio_command_tx = state.audio_command_tx.lock().unwrap()
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();  // Clone the sender

    // Now use it after the guard is dropped
    if let Err(_) = audio_command_tx.send(AudioCommand::Start(audio_tx)).await {
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
async fn stop_recording(State(state): State<ServerState>) -> impl IntoResponse {
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
            "Failed to stop recording"
        ),
    }
}

// Default implementation for Drop to ensure server is shutdown
impl Drop for LocalServer {
    fn drop(&mut self) {
        if self.shutdown_tx.is_some() {
            eprintln!("LocalServer dropped without proper shutdown");
        }
    }
}
