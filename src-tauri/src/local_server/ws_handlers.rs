use crate::local_server::audio::AudioCommand;
use crate::local_server::encryption::{
    create_message_format, decrypt_and_parse_payload, encrypt_message_with_timestamp,
    parse_message_format,
};
use crate::local_server::state::StateForLocalServerHandler;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use base64::{engine::general_purpose, Engine as _};
use bytes::Bytes;
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

// WebSocket command types
#[derive(Deserialize)]
#[serde(tag = "command")]
enum WsCommand {
    #[serde(rename = "init")]
    Init,
    #[serde(rename = "start-recording")]
    StartRecording,
    #[serde(rename = "stop-recording")]
    StopRecording,
    #[serde(rename = "health-check")]
    HealthCheck,
}

// WebSocket response types
#[derive(Serialize)]
#[serde(tag = "type")]
enum WsResponse {
    #[serde(rename = "init")]
    Init { encrypted_data: String },
    #[serde(rename = "health-check")]
    HealthCheck { encrypted_data: String },
    #[serde(rename = "audio-chunk")]
    AudioChunk { data: String },
    #[serde(rename = "recording-stopped")]
    RecordingStopped,
    #[serde(rename = "error")]
    Error { code: u16, message: String },
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<StateForLocalServerHandler>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Handle WebSocket connection
async fn handle_socket(socket: WebSocket, state: StateForLocalServerHandler) {
    let (mut sender, mut receiver) = socket.split();

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Process text message (base64 encrypted data)
                match handle_message(&text, &state).await {
                    Ok(response) => {
                        // Send response back
                        if let Err(e) = sender.send(Message::Text(response.into())).await {
                            eprintln!("Failed to send WebSocket response: {}", e);
                            break;
                        }
                    }
                    Err((code, message)) => {
                        // Send encrypted error response
                        let error_response = WsResponse::Error { code, message };
                        if let Ok(json) = serde_json::to_string(&error_response) {
                            let _ = sender.send(Message::Text(json.into())).await;
                        }
                        if code == 401 || code == 403 {
                            // Close connection on auth errors
                            break;
                        }
                    }
                }
            }
            Ok(Message::Binary(data)) => {
                // Process binary message (base64 encrypted data as bytes)
                match String::from_utf8(data.to_vec()) {
                    Ok(text) => match handle_message(&text, &state).await {
                        Ok(response) => {
                            if let Err(e) = sender.send(Message::Text(response.into())).await {
                                eprintln!("Failed to send WebSocket response: {}", e);
                                break;
                            }
                        }
                        Err((code, message)) => {
                            let error_response = WsResponse::Error { code, message };
                            if let Ok(json) = serde_json::to_string(&error_response) {
                                let _ = sender.send(Message::Text(json.into())).await;
                            }
                            if code == 401 || code == 403 {
                                break;
                            }
                        }
                    },
                    Err(e) => {
                        eprintln!("Failed to decode binary message: {}", e);
                        let error_response = WsResponse::Error {
                            code: 400,
                            message: "Invalid UTF-8 in binary message".to_string(),
                        };
                        if let Ok(json) = serde_json::to_string(&error_response) {
                            let _ = sender.send(Message::Text(json.into())).await;
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => {
                println!("WebSocket connection closed by client");
                break;
            }
            Ok(Message::Ping(data)) => {
                // Respond to ping with pong
                if let Err(e) = sender.send(Message::Pong(data)).await {
                    eprintln!("Failed to send pong: {}", e);
                    break;
                }
            }
            Ok(Message::Pong(_)) => {
                // Ignore pong messages
            }
            Err(e) => {
                eprintln!("WebSocket error: {}", e);
                break;
            }
        }
    }

    println!("WebSocket connection closed");
}

/// Handle incoming WebSocket message
async fn handle_message(
    message: &str,
    state: &StateForLocalServerHandler,
) -> Result<String, (u16, String)> {
    // Parse base64 message format
    let (nonce, encrypted_payload) = parse_message_format(message.as_bytes())
        .map_err(|e| (400, format!("Invalid message format: {}", e)))?;

    // For init command, fetch key first
    // For other commands, check if authenticated
    let key = {
        let enc_state = state.encryption_state.read().await;
        if enc_state.is_valid() {
            enc_state.get_key().unwrap().to_string()
        } else {
            // Not authenticated - only allow init command
            drop(enc_state);
            // Try to decrypt with temporary key from backend
            let key_response = state
                .backend_client
                .get_key()
                .await
                .map_err(|e| (500, format!("Failed to get encryption key: {}", e)))?;
            key_response.key
        }
    };

    // Decrypt and parse payload
    let payload = decrypt_and_parse_payload(&key, &nonce, &encrypted_payload)
        .map_err(|e| (403, format!("Decryption failed: {}", e)))?;

    // Parse command from decrypted payload
    let command: WsCommand = serde_json::from_str(&payload.data)
        .map_err(|e| (400, format!("Invalid command format: {}", e)))?;

    // Validate nonce and timestamp for authenticated commands
    let enc_state = state.encryption_state.read().await;
    if enc_state.is_valid() {
        if let Err(e) = enc_state.validate_nonce_and_timestamp(&nonce, &payload) {
            return Err((403, format!("Nonce/timestamp validation failed: {}", e)));
        }
    }
    drop(enc_state);

    // Handle command
    match command {
        WsCommand::Init => handle_init(state, &key).await,
        WsCommand::StartRecording => handle_start_recording(state, &key).await,
        WsCommand::StopRecording => handle_stop_recording(state, &key).await,
        WsCommand::HealthCheck => handle_health_check(state, &key).await,
    }
}

/// Handle init command
async fn handle_init(
    state: &StateForLocalServerHandler,
    key: &str,
) -> Result<String, (u16, String)> {
    // Store the key
    {
        let mut enc_state = state.encryption_state.write().await;
        enc_state.set_key(key.to_string());
    }

    // Generate unique nonce for response
    let enc_state = state.encryption_state.read().await;
    let response_nonce = enc_state.generate_unique_nonce();

    // Encrypt acknowledgment response
    let encrypted_response =
        encrypt_message_with_timestamp(key, &response_nonce, &state.config.acknowledgment_string)
            .map_err(|e| (500, format!("Failed to encrypt response: {}", e)))?;

    // Create response in base64 format
    let response_message = create_message_format(&response_nonce, &encrypted_response)
        .map_err(|e| (500, format!("Failed to create response format: {}", e)))?;

    let response = WsResponse::Init {
        encrypted_data: response_message,
    };

    serde_json::to_string(&response).map_err(|e| (500, format!("Failed to serialize: {}", e)))
}

/// Handle start-recording command
async fn handle_start_recording(
    _state: &StateForLocalServerHandler,
    _key: &str,
) -> Result<String, (u16, String)> {
    // This command doesn't return immediately - it streams audio
    // We'll need to handle this differently
    // For now, return an error indicating streaming is not supported via command
    Err((
        400,
        "Start recording requires persistent connection - use streaming mode".to_string(),
    ))
}

/// Handle stop-recording command
async fn handle_stop_recording(
    state: &StateForLocalServerHandler,
    _key: &str,
) -> Result<String, (u16, String)> {
    let audio_command_tx = {
        let guard = state.audio_command_tx.lock().unwrap();
        guard.as_ref().map(|tx| tx.clone())
    };

    match audio_command_tx {
        Some(tx) => {
            let _ = tx.send(AudioCommand::Stop).await;
            println!("Stop recording via WebSocket");
            let response = WsResponse::RecordingStopped;
            serde_json::to_string(&response)
                .map_err(|e| (500, format!("Failed to serialize: {}", e)))
        }
        None => Err((500, "Audio system not available".to_string())),
    }
}

/// Handle health-check command
async fn handle_health_check(
    state: &StateForLocalServerHandler,
    key: &str,
) -> Result<String, (u16, String)> {
    // Generate unique nonce for response
    let enc_state = state.encryption_state.read().await;
    let response_nonce = enc_state.generate_unique_nonce();

    // Encrypt acknowledgment response
    let encrypted_response =
        encrypt_message_with_timestamp(key, &response_nonce, &state.config.acknowledgment_string)
            .map_err(|e| (500, format!("Failed to encrypt response: {}", e)))?;

    // Create response in base64 format
    let response_message = create_message_format(&response_nonce, &encrypted_response)
        .map_err(|e| (500, format!("Failed to create response format: {}", e)))?;

    let response = WsResponse::HealthCheck {
        encrypted_data: response_message,
    };

    serde_json::to_string(&response).map_err(|e| (500, format!("Failed to serialize: {}", e)))
}

/// Handle start-recording with streaming (separate connection handler)
pub async fn ws_recording_handler(
    ws: WebSocketUpgrade,
    State(state): State<StateForLocalServerHandler>,
) -> Response {
    ws.on_upgrade(move |socket| handle_recording_socket(socket, state))
}

/// Handle WebSocket connection for audio recording
async fn handle_recording_socket(socket: WebSocket, state: StateForLocalServerHandler) {
    let (mut sender, mut receiver) = socket.split();

    // Wait for start command
    let start_msg = match receiver.next().await {
        Some(Ok(Message::Text(text))) => text.to_string(),
        Some(Ok(Message::Binary(data))) => match String::from_utf8(data.to_vec()) {
            Ok(text) => text,
            Err(e) => {
                eprintln!("Failed to decode binary message: {}", e);
                return;
            }
        },
        _ => {
            eprintln!("Expected start command");
            return;
        }
    };

    // Validate the start command
    let enc_state = state.encryption_state.read().await;
    if !enc_state.is_valid() {
        let error_response = WsResponse::Error {
            code: 401,
            message: "Unauthorized".to_string(),
        };
        if let Ok(json) = serde_json::to_string(&error_response) {
            let _ = sender.send(Message::Text(json.into())).await;
        }
        return;
    }

    let key = enc_state.get_key().unwrap().to_string();
    drop(enc_state);

    // Parse and validate start message
    let (nonce, encrypted_payload) = match parse_message_format(start_msg.as_bytes()) {
        Ok(result) => result,
        Err(e) => {
            let error_response = WsResponse::Error {
                code: 400,
                message: format!("Invalid message format: {}", e),
            };
            if let Ok(json) = serde_json::to_string(&error_response) {
                let _ = sender.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    let payload = match decrypt_and_parse_payload(&key, &nonce, &encrypted_payload) {
        Ok(payload) => payload,
        Err(e) => {
            let error_response = WsResponse::Error {
                code: 403,
                message: format!("Decryption failed: {}", e),
            };
            if let Ok(json) = serde_json::to_string(&error_response) {
                let _ = sender.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    // Validate command
    let command: Result<WsCommand, _> = serde_json::from_str(&payload.data);
    match command {
        Ok(WsCommand::StartRecording) => {
            // Valid start recording command
        }
        _ => {
            let error_response = WsResponse::Error {
                code: 400,
                message: "Expected start-recording command".to_string(),
            };
            if let Ok(json) = serde_json::to_string(&error_response) {
                let _ = sender.send(Message::Text(json.into())).await;
            }
            return;
        }
    }

    // Start audio recording
    let (audio_tx, mut audio_rx) = mpsc::channel::<Bytes>(10);

    let audio_command_tx = {
        let guard = state.audio_command_tx.lock().unwrap();
        guard.as_ref().map(|tx| tx.clone())
    };

    let audio_command_tx = match audio_command_tx {
        Some(tx) => tx,
        None => {
            let error_response = WsResponse::Error {
                code: 500,
                message: "Audio system not available".to_string(),
            };
            if let Ok(json) = serde_json::to_string(&error_response) {
                let _ = sender.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    if audio_command_tx
        .send(AudioCommand::Start(audio_tx))
        .await
        .is_err()
    {
        let error_response = WsResponse::Error {
            code: 500,
            message: "Failed to start recording".to_string(),
        };
        if let Ok(json) = serde_json::to_string(&error_response) {
            let _ = sender.send(Message::Text(json.into())).await;
        }
        return;
    }

    println!("Started audio recording via WebSocket");

    // Stream audio chunks and listen for stop command
    loop {
        tokio::select! {
            // Audio chunks
            Some(bytes) = audio_rx.recv() => {
                let base64_data = general_purpose::STANDARD.encode(bytes);
                let response = WsResponse::AudioChunk { data: base64_data };
                if let Ok(json) = serde_json::to_string(&response) {
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
            // Stop command from client
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // Try to parse and validate stop command
                        if let Ok((nonce, encrypted_payload)) = parse_message_format(text.as_bytes()) {
                            if let Ok(payload) = decrypt_and_parse_payload(&key, &nonce, &encrypted_payload) {
                                if let Ok(WsCommand::StopRecording) = serde_json::from_str::<WsCommand>(&payload.data) {
                                    let _ = audio_command_tx.send(AudioCommand::Stop).await;
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        let text = String::from_utf8_lossy(&data);
                        // Try to parse and validate stop command
                        if let Ok((nonce, encrypted_payload)) = parse_message_format(text.as_bytes()) {
                            if let Ok(payload) = decrypt_and_parse_payload(&key, &nonce, &encrypted_payload) {
                                if let Ok(WsCommand::StopRecording) = serde_json::from_str::<WsCommand>(&payload.data) {
                                    let _ = audio_command_tx.send(AudioCommand::Stop).await;
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let _ = audio_command_tx.send(AudioCommand::Stop).await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    println!("Stopped audio recording via WebSocket");
    let response = WsResponse::RecordingStopped;
    if let Ok(json) = serde_json::to_string(&response) {
        let _ = sender.send(Message::Text(json.into())).await;
    }
}
