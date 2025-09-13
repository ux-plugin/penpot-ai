use crate::local_server::audio::AudioCommand;
use crate::local_server::encryption::{decrypt_message, encrypt_message, InitRequest, InitResponse};
use crate::local_server::state::StateForLocalServerHandler;
use axum::{
    debug_handler,
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use base64::{engine::general_purpose, Engine as _};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use std::convert::Infallible;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};

pub async fn handshake(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<InitRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    // Fetch encryption key from backend
    let key_response = state.backend_client.get_key().await
        .map_err(|e| {
            println!("Failed to get encryption key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // Check if key is expired
    if let Ok(expiry) = key_response.expires_at.parse::<DateTime<Utc>>() {
        if expiry <= Utc::now() {
            println!("Encryption key is expired");
            return Err(StatusCode::UNAUTHORIZED);
        }
    } else {
        println!("Failed to parse key expiration date");
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Try to decrypt the incoming message
    match decrypt_message(&key_response.key, &request.nonce, &request.encrypted_data) {
        Ok(_decrypted_data) => {
            // Successfully decrypted - key is valid
            // Store the validated key in the encryption state
            {
                let mut enc_state = state.encryption_state.write().await;
                enc_state.set_key(key_response.key.clone(), key_response.expires_at);
                enc_state.set_nonce(0); // Initialize nonce counter
            }

            // Prepare response
            let response_data = b"ACK";
            let next_nonce = 1u64; // Next expected nonce

            // Encrypt response
            let (encrypted_response, nonce_str) = encrypt_message(&key_response.key, next_nonce, response_data)
                .map_err(|e| {
                    println!("Failed to encrypt response: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR
                })?;

            // Update nonce counter
            {
                let enc_state = state.encryption_state.read().await;
                enc_state.increment_nonce(); // Set to 1 for next request
            }

            let response = InitResponse {
                encrypted_data: encrypted_response,
                nonce: nonce_str,
            };

            Ok(Json(response))
        }
        Err(e) => {
            println!("Failed to decrypt init message: {}", e);
            Err(StatusCode::FORBIDDEN)
        }
    }
}

#[debug_handler]
pub async fn start_recording(
    State(state): State<StateForLocalServerHandler>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    // Check if client is authenticated
    {
        let enc_state = state.encryption_state.read().await;
        if !enc_state.is_valid() {
            println!("Unauthorized: No valid encryption key");
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

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
    if audio_command_tx.send(AudioCommand::Start(audio_tx)).await.is_err() {
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
pub async fn stop_recording(State(state): State<StateForLocalServerHandler>) -> impl IntoResponse {
    // Check if client is authenticated
    {
        let enc_state = state.encryption_state.read().await;
        if !enc_state.is_valid() {
            println!("Unauthorized: No valid encryption key");
            return (StatusCode::UNAUTHORIZED, "Unauthorized");
        }
    }

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