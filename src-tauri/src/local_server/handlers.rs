use crate::local_server::audio::{AudioCommand, AudioStreamMessage};
use crate::local_server::encryption::{
    encrypt_message_with_timestamp, create_message_format, 
    parse_message_format, decrypt_and_parse_payload, InitResponse,
    encrypt_audio_chunk
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
use serde::Deserialize;
use std::convert::Infallible;
use tokio::sync::{mpsc, oneshot};
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

    // Clone encryption state and key for use in the stream
    let encryption_state_clone = state.encryption_state.clone();
    let key_clone = key.clone();
    
    drop(enc_state); // Release the lock

    // Create channels for audio data and response
    let (audio_tx, audio_rx) = mpsc::channel::<AudioStreamMessage>(10);
    let (response_tx, response_rx) = oneshot::channel();

    // Get the audio command sender
    let audio_command_tx = state
        .audio_command_tx
        .lock()
        .unwrap()
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();

    // Send start recording command with response channel
    if audio_command_tx.send(AudioCommand::Start { 
        audio_tx: audio_tx.clone(), 
        response_tx 
    }).await.is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Wait for AudioManager to confirm start or reject
    match response_rx.await {
        Ok(Ok(())) => {
            println!("AudioManager confirmed recording started");
        }
        Ok(Err(e)) => {
            println!("AudioManager rejected recording: {}", e);
            return Err(StatusCode::CONFLICT);
        }
        Err(_) => {
            println!("AudioManager response channel closed unexpectedly");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    // Spawn a task to detect client disconnect and auto-stop recording
    let cleanup_state = state.clone();
    let cleanup_audio_tx = audio_tx.clone();
    tokio::spawn(async move {
        // Wait for the audio_tx channel to be closed (all receivers dropped)
        cleanup_audio_tx.closed().await;
        
        println!("Client disconnected - stopping recording automatically");
        
        // Send stop command to AudioManager
        // Clone the sender to avoid holding the lock across await
        let cmd_tx_clone = {
            let guard = cleanup_state.audio_command_tx.lock().unwrap();
            guard.as_ref().map(|tx| tx.clone())
        };
        
        if let Some(cmd_tx) = cmd_tx_clone {
            let _ = cmd_tx.send(AudioCommand::Stop).await;
        }
        
        println!("Cleanup complete - AudioManager handles state reset");
    });

    let stream = ReceiverStream::new(audio_rx).then(move |message| {
        let key = key_clone.clone();
        let enc_state = encryption_state_clone.clone();
        
        async move {
            match message {
                AudioStreamMessage::Data(bytes) => {
                    // Generate unique nonce for this audio chunk
                    let nonce = {
                        let state = enc_state.read().await;
                        state.generate_unique_nonce()
                    };
                    
                    // Encrypt the audio chunk with timestamp
                    match encrypt_audio_chunk(&key, &nonce, &bytes) {
                        Ok(encrypted_data) => {
                            let event = Event::default().data(encrypted_data);
                            Ok(event)
                        }
                        Err(e) => {
                            eprintln!("Failed to encrypt audio chunk: {}", e);
                            // Return empty event on error to keep stream alive
                            let event = Event::default().data("");
                            Ok(event)
                        }
                    }
                }
                AudioStreamMessage::Error(error_msg) => {
                    eprintln!("Audio stream error from AudioManager: {}", error_msg);
                    // Send error as SSE event - client will see this and can close connection
                    let event = Event::default()
                        .event("error")
                        .data("");
                    Ok(event)
                }
            }
        }
    });

    println!("Start recording validation successful");
    Ok(Sse::new(stream))
}

#[debug_handler]
pub async fn stop_recording(
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
        println!("Failed to encrypt stop recording response: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // Create response in new format: base64<nonce|encrypted_payload>
    let response_message = create_message_format(&response_nonce, &encrypted_response)
        .map_err(|e| {
            println!("Failed to create response message format: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

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
            
            println!("Stop recording command sent - AudioManager handles state cleanup");
            
            let response = InitResponse {
                encrypted_data: response_message,
            };
            Ok(Json(response))
        }
        None => {
            println!("Failed to stop recording: no audio command sender");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
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
