use crate::local_server::audio::AudioCommand;
use crate::local_server::encryption::{
    encrypt_message_with_timestamp, create_message_format, 
    parse_message_format, decrypt_and_parse_payload, InitResponse
};
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
use serde::Deserialize;
use std::convert::Infallible;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt};

// Request structure for JSON-wrapped encrypted data
#[derive(Deserialize)]
pub struct EncryptedRequest {
    pub encrypted_data: String,
}

pub async fn handshake(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<EncryptedRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    println!("Always fetching fresh encryption key from backend...");

    // Always fetch an encryption key from the backend
    let key_response = state.backend_client.get_key().await
        .map_err(|e| {
            println!("Failed to get encryption key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // Parse message format: base64<nonce(12)|encrypted_payload>
    let (nonce, encrypted_payload) = parse_message_format(request.encrypted_data.as_bytes())
        .map_err(|e| {
            println!("Failed to parse message format: {}", e);
            StatusCode::BAD_REQUEST
        })?;

    // Decrypt and parse payload to get {message, timestamp}
    let payload = decrypt_and_parse_payload(&key_response.key, &nonce, &encrypted_payload)
        .map_err(|e| {
            println!("Failed to decrypt and parse payload: {}", e);
            StatusCode::FORBIDDEN
        })?;

    // Validate message content
    if payload.data != state.config.expected_command_string {
        println!("Invalid command: expected '{}', got '{}'", state.config.expected_command_string, payload.data);
        return Err(StatusCode::FORBIDDEN);
    }

    // Successfully decrypted - store the validated key
    {
        let mut enc_state = state.encryption_state.write().await;
        enc_state.set_key(key_response.key.clone());
    }

    // Generate unique nonce for response
    let enc_state = state.encryption_state.read().await;
    let response_nonce = enc_state.generate_unique_nonce();
    
    // Encrypt response with timestamp
    let encrypted_response = encrypt_message_with_timestamp(
        &key_response.key, 
        &response_nonce, 
        &state.config.acknowledgment_string
    ).map_err(|e| {
        println!("Failed to encrypt response: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // Create response in new format: base64<nonce|encrypted_payload>
    let response_message = create_message_format(&response_nonce, &encrypted_response)
        .map_err(|e| {
            println!("Failed to create response message format: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let response = InitResponse {
        encrypted_data: response_message,
    };

    println!("Handshake successful, key stored and response generated");
    Ok(Json(response))
}

#[debug_handler]
pub async fn start_recording(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<EncryptedRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    // Check if client is authenticated
    let enc_state = state.encryption_state.read().await;
    if !enc_state.is_valid() {
        println!("Unauthorized: No valid encryption key");
        return Err(StatusCode::UNAUTHORIZED);
    }
    
    let key = enc_state.get_key().ok_or(StatusCode::UNAUTHORIZED)?;

    // Parse message format: base64<nonce(12)|encrypted_payload>
    let (nonce, encrypted_payload) = parse_message_format(request.encrypted_data.as_bytes())
        .map_err(|e| {
            println!("Failed to parse message format: {}", e);
            StatusCode::BAD_REQUEST
        })?;

    // Decrypt and parse payload to get {message, timestamp}
    let payload = decrypt_and_parse_payload(key, &nonce, &encrypted_payload)
        .map_err(|e| {
            println!("Failed to decrypt and parse payload: {}", e);
            StatusCode::FORBIDDEN
        })?;

    // Validate message content
    if payload.data != state.config.expected_command_string {
        println!("Invalid command: expected '{}', got '{}'", state.config.expected_command_string, payload.data);
        return Err(StatusCode::FORBIDDEN);
    }

    // Validate nonce and timestamp
    if let Err(e) = enc_state.validate_nonce_and_timestamp(&nonce, &payload) {
        println!("Nonce/timestamp validation failed: {}", e);
        return Err(StatusCode::FORBIDDEN);
    }

    drop(enc_state); // Release the lock

    let (audio_tx, audio_rx) = mpsc::channel::<Bytes>(10);

    // Get the audio command sender
    let audio_command_tx = state
        .audio_command_tx
        .lock()
        .unwrap()
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();

    // Send start recording command
    if audio_command_tx.send(AudioCommand::Start(audio_tx)).await.is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let stream = ReceiverStream::new(audio_rx).map(|bytes| {
        let base64_data = general_purpose::STANDARD.encode(bytes);
        let event = Event::default().data(base64_data);
        Ok(event)
    });

    println!("Start recording validation successful");
    Ok(Sse::new(stream))
}

#[debug_handler]
pub async fn stop_recording(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<EncryptedRequest>,
) -> impl IntoResponse {
    // Check if client is authenticated
    let enc_state = state.encryption_state.read().await;
    if !enc_state.is_valid() {
        println!("Unauthorized: No valid encryption key");
        return (StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    
    let key = enc_state.get_key().unwrap();

    // Parse message format: base64<nonce(12)|encrypted_payload>
    let (nonce, encrypted_payload) = match parse_message_format(request.encrypted_data.as_bytes()) {
        Ok(result) => result,
        Err(e) => {
            println!("Failed to parse message format: {}", e);
            return (StatusCode::BAD_REQUEST, "Invalid message format");
        }
    };

    // Decrypt and parse payload to get {message, timestamp}
    let payload = match decrypt_and_parse_payload(key, &nonce, &encrypted_payload) {
        Ok(payload) => payload,
        Err(e) => {
            println!("Failed to decrypt and parse payload: {}", e);
            return (StatusCode::FORBIDDEN, "Decryption failed");
        }
    };

    // Validate message content
    if payload.data != state.config.expected_command_string {
        println!("Invalid command: expected '{}', got '{}'", state.config.expected_command_string, payload.data);
        return (StatusCode::FORBIDDEN, "Invalid command");
    }

    // Validate nonce and timestamp
    if let Err(e) = enc_state.validate_nonce_and_timestamp(&nonce, &payload) {
        println!("Nonce/timestamp validation failed: {}", e);
        return (StatusCode::FORBIDDEN, "Invalid nonce");
    }

    drop(enc_state); // Release the lock

    // Clone the sender outside the mutex lock
    let audio_command_tx = {
        let guard = state.audio_command_tx.lock().unwrap();
        guard.as_ref().map(|tx| tx.clone())
    };

    // Now use the cloned sender
    match audio_command_tx {
        Some(tx) => {
            let _ = tx.send(AudioCommand::Stop).await;
            println!("Stop recording validation successful");
            (StatusCode::OK, "Recording stopped")
        }
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to stop recording",
        ),
    }
}

#[debug_handler]
pub async fn health_check(
    State(state): State<StateForLocalServerHandler>,
    Json(request): Json<EncryptedRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    // Check if client is authenticated
    let enc_state = state.encryption_state.read().await;
    if !enc_state.is_valid() {
        println!("Unauthorized: No valid encryption key");
        return Err(StatusCode::UNAUTHORIZED);
    }
    
    let key = enc_state.get_key().ok_or(StatusCode::UNAUTHORIZED)?;

    // Parse message format: base64<nonce(12)|encrypted_payload>
    let (nonce, encrypted_payload) = parse_message_format(request.encrypted_data.as_bytes())
        .map_err(|e| {
            println!("Failed to parse message format: {}", e);
            StatusCode::BAD_REQUEST
        })?;

    // Decrypt and parse payload to get {message, timestamp}
    let payload = decrypt_and_parse_payload(key, &nonce, &encrypted_payload)
        .map_err(|e| {
            println!("Failed to decrypt and parse payload: {}", e);
            StatusCode::FORBIDDEN
        })?;

    // Validate message content
    if payload.data != state.config.expected_command_string {
        println!("Invalid command: expected '{}', got '{}'", state.config.expected_command_string, payload.data);
        return Err(StatusCode::FORBIDDEN);
    }

    // Validate nonce and timestamp
    if let Err(e) = enc_state.validate_nonce_and_timestamp(&nonce, &payload) {
        println!("Nonce/timestamp validation failed: {}", e);
        return Err(StatusCode::FORBIDDEN);
    }

    // Generate unique nonce for response
    let response_nonce = enc_state.generate_unique_nonce();
    
    // Encrypt response with timestamp
    let encrypted_response = encrypt_message_with_timestamp(
        key, 
        &response_nonce, 
        &state.config.acknowledgment_string
    ).map_err(|e| {
        println!("Failed to encrypt health check response: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // Create response in new format: base64<nonce|encrypted_payload>
    let response_message = create_message_format(&response_nonce, &encrypted_response)
        .map_err(|e| {
            println!("Failed to create response message format: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let response = InitResponse {
        encrypted_data: response_message,
    };

    println!("Health check validation successful");
    Ok(Json(response))
}
