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
    // First check if we have a valid encryption key in memory/keyring
    let (encryption_key, expires_at) = {
        let enc_state = state.encryption_state.read().await;
        if enc_state.is_valid() {
            // We have a valid key, try to use it first
            if let Some(key) = enc_state.get_key() {
                (key.clone(), enc_state.get_expires_at().cloned())
            } else {
                // Key is None but state claims it's valid - this shouldn't happen
                ("".to_string(), None)
            }
        } else {
            // No valid key, need to fetch from backend
            ("".to_string(), None)
        }
    };

    // If we don't have a valid key or decryption fails, fetch from backend
    let (final_key, final_expires_at) = if encryption_key.is_empty() ||
        decrypt_message(&encryption_key, &request.nonce, &request.encrypted_data).is_err() {

        println!("No valid cached key or decryption failed, fetching from backend...");

        // Fetch encryption key from backend
        let key_response = state.backend_client.get_key().await
            .map_err(|e| {
                println!("Failed to get encryption key: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

        // Check if key is expired
        if let Ok(expiry) = key_response.expires_at.parse::<DateTime<Utc>>() {
            if expiry <= Utc::now() {
                println!("Encryption key from backend is expired");
                return Err(StatusCode::UNAUTHORIZED);
            }
        } else {
            println!("Failed to parse key expiration date");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }

        // Try to decrypt with the new key
        match decrypt_message(&key_response.key, &request.nonce, &request.encrypted_data) {
            Ok(_) => {
                // Successfully decrypted - store the validated key
                {
                    let mut enc_state = state.encryption_state.write().await;
                    enc_state.set_key(key_response.key.clone(), key_response.expires_at.clone());
                    enc_state.set_nonce(0); // Initialize nonce counter
                }
                (key_response.key, key_response.expires_at)
            }
            Err(e) => {
                println!("Failed to decrypt init message with backend key: {}", e);
                return Err(StatusCode::FORBIDDEN);
            }
        }
    } else {
        // Use cached key successfully
        println!("Using cached encryption key");
        (encryption_key, expires_at.unwrap_or_default())
    };

    // Prepare response
    let response_data = b"ACK";
    let next_nonce = 1u64; // Next expected nonce

    // Encrypt response
    let (encrypted_response, nonce_str) = encrypt_message(&final_key, next_nonce, response_data)
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