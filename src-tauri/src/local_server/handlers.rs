use crate::local_server::audio::AudioCommand;
use crate::local_server::encryption::{decrypt_message, encrypt_message, InitRequest, InitResponse, NonceRequest};
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
use std::convert::Infallible;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};

pub async fn handshake(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<InitRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    println!("Always fetching fresh encryption key from backend...");

    // Always fetch encryption key from backend
    let key_response = state.backend_client.get_key().await
        .map_err(|e| {
            println!("Failed to get encryption key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // Try to decrypt with the key from backend
    match decrypt_message(&key_response.key, &request.nonce, &request.encrypted_data) {
        Ok(decrypted_data) => {
            // Validate that decrypted content matches expected command string
            let decrypted_str = String::from_utf8(decrypted_data)
                .map_err(|e| {
                    println!("Failed to convert decrypted data to string: {}", e);
                    StatusCode::BAD_REQUEST
                })?;
            
            if decrypted_str != state.config.expected_command_string {
                println!("Invalid decrypted content: expected '{}', got '{}'", state.config.expected_command_string, decrypted_str);
                return Err(StatusCode::FORBIDDEN);
            }
            // Successfully decrypted - store the validated key
            {
                let mut enc_state = state.encryption_state.write().await;
                enc_state.set_key(key_response.key.clone());
                enc_state.set_nonce(0); // Initialize nonce counter
            }

            // Prepare response
            let response_data = state.config.acknowledgment_string.as_bytes();
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
            println!("Failed to decrypt init message with backend key: {}", e);
            Err(StatusCode::FORBIDDEN)
        }
    }
}

#[debug_handler]
pub async fn start_recording(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<NonceRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    // Check if client is authenticated and validate nonce
    {
        let enc_state = state.encryption_state.read().await;
        if !enc_state.is_valid() {
            println!("Unauthorized: No valid encryption key");
            return Err(StatusCode::UNAUTHORIZED);
        }
        
        // Decrypt and validate content matches expected command string
        let key = enc_state.get_key().ok_or(StatusCode::UNAUTHORIZED)?;
        match decrypt_message(key, &request.nonce, &request.encrypted_data) {
            Ok(decrypted_data) => {
                let decrypted_str = String::from_utf8(decrypted_data)
                    .map_err(|e| {
                        println!("Failed to convert decrypted data to string: {}", e);
                        StatusCode::BAD_REQUEST
                    })?;
                
                if decrypted_str != state.config.expected_command_string {
                    println!("Invalid decrypted content: expected '{}', got '{}'", state.config.expected_command_string, decrypted_str);
                    return Err(StatusCode::FORBIDDEN);
                }
            }
            Err(e) => {
                println!("Failed to decrypt message: {}", e);
                return Err(StatusCode::FORBIDDEN);
            }
        }
        
        // Validate nonce (must be current_nonce + 1)
        if let Err(e) = enc_state.validate_and_increment_nonce(&request.nonce) {
            println!("Nonce validation failed: {}", e);
            return Err(StatusCode::FORBIDDEN);
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
pub async fn stop_recording(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<NonceRequest>,
) -> impl IntoResponse {
    // Check if client is authenticated and validate nonce
    {
        let enc_state = state.encryption_state.read().await;
        if !enc_state.is_valid() {
            println!("Unauthorized: No valid encryption key");
            return (StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        
        // Decrypt and validate content matches expected command string
        let key = match enc_state.get_key() {
            Some(k) => k,
            None => return (StatusCode::UNAUTHORIZED, "No encryption key"),
        };
        match decrypt_message(key, &request.nonce, &request.encrypted_data) {
            Ok(decrypted_data) => {
                let decrypted_str = match String::from_utf8(decrypted_data) {
                    Ok(s) => s,
                    Err(e) => {
                        println!("Failed to convert decrypted data to string: {}", e);
                        return (StatusCode::BAD_REQUEST, "Invalid encrypted data");
                    }
                };
                
                if decrypted_str != state.config.expected_command_string {
                    println!("Invalid decrypted content: expected '{}', got '{}'", state.config.expected_command_string, decrypted_str);
                    return (StatusCode::FORBIDDEN, "Invalid command");
                }
            }
            Err(e) => {
                println!("Failed to decrypt message: {}", e);
                return (StatusCode::FORBIDDEN, "Decryption failed");
            }
        }
        
        // Validate nonce (must be current_nonce + 1)
        if let Err(e) = enc_state.validate_and_increment_nonce(&request.nonce) {
            println!("Nonce validation failed: {}", e);
            return (StatusCode::FORBIDDEN, "Invalid nonce");
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
