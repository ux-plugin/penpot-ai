use crate::local_server::audio_stream::AudioStream;
use crate::local_server::encryption::{
    create_message_format, decrypt_and_parse_payload, encrypt_message_with_timestamp,
    parse_message_format,
};
use crate::local_server::state::{ConnectionGuard, StateForLocalServerHandler};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

// WebSocket command types with request ID
#[derive(Deserialize)]
struct WsRequest {
    id: String,
    command: WsCommandType,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WsCommandType {
    Init,
    StartRecording,
    StopRecording,
    HealthCheck,
}

// WebSocket response payload structure (to be encrypted)
#[derive(Serialize)]
struct ResponsePayload {
    id: String,
    #[serde(rename = "type")]
    response_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<StateForLocalServerHandler>,
) -> Response {
    print!("New WebSocket connection established\n");
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Decode binary WebSocket message to string
fn decode_binary_message(data: axum::body::Bytes) -> Result<String, String> {
    String::from_utf8(data.to_vec()).map_err(|e| format!("Invalid UTF-8 in binary message: {}", e))
}

/// Send encrypted response via WebSocket in format: base64<nonce | encrypted_data>
async fn send_encrypted_response(
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    response_type: &str,
    data: Option<serde_json::Value>,
) -> Result<(), ()> {
    // Generate unique nonce for response
    let enc_state = state.encryption_state.read().await;
    let response_nonce = enc_state.generate_unique_nonce();
    drop(enc_state);

    // Create response payload
    let payload = ResponsePayload {
        id: request_id.to_string(),
        response_type: response_type.to_string(),
        data,
    };
    
    let payload_json = match serde_json::to_string(&payload) {
        Ok(json) => json,
        Err(_) => return Err(()),
    };

    // Encrypt the payload
    let encrypted_response = match encrypt_message_with_timestamp(key, &response_nonce, &payload_json) {
        Ok(resp) => resp,
        Err(_) => return Err(()),
    };

    // Create message format: base64<nonce | encrypted_payload>
    let response_message = match create_message_format(&response_nonce, &encrypted_response) {
        Ok(msg) => msg,
        Err(_) => return Err(()),
    };

    // Send as text message
    let mut sender_lock = sender.lock().await;
    sender_lock.send(Message::Text(response_message.into())).await.map_err(|_| ())
}

/// Send error response via WebSocket
async fn send_error_response(
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    code: u16,
    message: String,
) -> Result<(), ()> {
    let error_data = serde_json::json!({
        "code": code,
        "message": message,
    });
    
    send_encrypted_response(sender, state, key, request_id, "error", Some(error_data)).await
}

/// Handle WebSocket connection - SINGLE RECEIVER POINT
async fn handle_socket(socket: WebSocket, state: StateForLocalServerHandler) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));
    print!("New WebSocket connection established\n");
    
    // Create connection guard - automatically registers and will auto-deregister on drop
    let _guard = ConnectionGuard::new(state.clone(), sender.clone());
    let connection_id = _guard.id();

    // Process commands in a single loop
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let result = handle_message(&text, &state, sender.clone()).await;
                if let Err(should_break) = result {
                    if should_break {
                        break;
                    }
                }
            }
            Ok(Message::Binary(data)) => {
                match decode_binary_message(data) {
                    Ok(text_str) => {
                        let result = handle_message(&text_str, &state, sender.clone()).await;
                        if let Err(should_break) = result {
                            if should_break {
                                break;
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("Binary decode error - full trace: {}", err);
                        // Can't send encrypted error without key in this context
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => {
                println!("WebSocket connection closed by client ({})", connection_id);
                break;
            }
            Ok(Message::Ping(data)) => {
                let mut sender_lock = sender.lock().await;
                if let Err(e) = sender_lock.send(Message::Pong(data)).await {
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

    println!("WebSocket connection closed for connection: {}", connection_id);
    
    // Cleanup: Stop any active stream on disconnect
    let stream = {
        let mut stream_lock = state.active_stream.lock().unwrap();
        stream_lock.take()
    };
    
    if let Some(stream) = stream {
        // Stop the stream silently (no response sent since connection is closing)
        stream.stop_silent().await;
        println!("Stopped active stream due to connection close");
    }
}

/// Handle incoming WebSocket message
async fn handle_message(
    message: &str,
    state: &StateForLocalServerHandler,
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
) -> Result<(), bool> {
    // Parse base64 message format
    let (nonce, encrypted_payload) = match parse_message_format(message.as_bytes()) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Message format parsing error - full trace: {}", e);
            return Err(true);
        }
    };

    // Get encryption key - try cached key first
    let mut key = {
        let enc_state = state.encryption_state.read().await;
        if enc_state.is_valid() {
            enc_state.get_key().unwrap().to_string()
        } else {
            // Not authenticated - try to get key from backend
            drop(enc_state);
            match state.backend_client.get_key().await {
                Ok(key_response) => key_response.key,
                Err(e) => {
                    eprintln!("Failed to get encryption key - full trace: {}", e);
                    return Err(true);
                }
            }
        }
    };

    // Decrypt and parse payload - with retry logic
    let payload = match decrypt_and_parse_payload(&key, &nonce, &encrypted_payload) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Decryption failed with initial key - full trace: {}", e);
            
            // If we used a cached key and decryption failed, try fetching a fresh key from backend
            eprintln!("Attempting to fetch fresh key from backend and retry decryption...");

            match state.backend_client.get_key().await {
                Ok(key_response) => {
                    key = key_response.key;

                    // Update the encryption state with the fresh key
                    {
                        let mut enc_state = state.encryption_state.write().await;
                        enc_state.set_key(key.clone());
                    }

                    // Retry decryption with fresh key
                    match decrypt_and_parse_payload(&key, &nonce, &encrypted_payload) {
                        Ok(p) => {
                            eprintln!("Decryption succeeded with fresh key from backend");
                            p
                        }
                        Err(retry_err) => {
                            eprintln!("Decryption failed even with fresh key - full trace: {}", retry_err);
                            let _ = send_error_response(sender.clone(), state, &key, "unknown", 403, "Decryption failed".to_string()).await;
                            return Err(false);
                        }
                    }
                }
                Err(backend_err) => {
                    eprintln!("Failed to fetch fresh key from backend - full trace: {}", backend_err);
                    let _ = send_error_response(sender.clone(), state, &key, "unknown", 403, "Decryption failed".to_string()).await;
                    return Err(false);
                }
            }
        }
    };

    // Parse request with ID and command
    let request: WsRequest = match serde_json::from_str(&payload.data) {
        Ok(req) => req,
        Err(e) => {
            eprintln!("Command parsing error - full trace: {}", e);
            // Use a default ID for error responses when parsing fails
            let _ = send_error_response(sender.clone(), state, &key, "unknown", 400, "Invalid command format".to_string()).await;
            return Ok(()); // Continue
        }
    };

    let request_id = request.id.clone();

    // Validate nonce and timestamp for authenticated commands
    let enc_state = state.encryption_state.read().await;
    if enc_state.is_valid() {
        if let Err(e) = enc_state.validate_nonce_and_timestamp(&nonce, &payload) {
            eprintln!("Nonce/timestamp validation failed - full trace: {}", e);
            drop(enc_state);
            let _ = send_error_response(sender.clone(), state, &key, &request_id, 403, "Authentication validation failed".to_string()).await;
            return Err(false); // Break on validation failure
        }
    }
    drop(enc_state);

    // Handle command
    match request.command {
        WsCommandType::Init => handle_init(state, &key, &request_id, sender).await,
        WsCommandType::StartRecording => handle_start_recording(state, &key, &request_id, sender).await,
        WsCommandType::StopRecording => handle_stop_recording(state, &key, &request_id, sender).await,
        WsCommandType::HealthCheck => handle_health_check(state, &key, &request_id, sender).await,
    }
}

/// Handle init command
async fn handle_init(
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
) -> Result<(), bool> {
    // Store the key
    {
        let mut enc_state = state.encryption_state.write().await;
        enc_state.set_key(key.to_string());
    }

    // Send encrypted init response with acknowledgment
    let ack_data = serde_json::json!({
        "message": state.config.acknowledgment_string.clone()
    });
    
    let _ = send_encrypted_response(sender, state, key, request_id, "init", Some(ack_data)).await;
    
    Ok(())
}

/// Handle start-recording command - uses AudioStream
async fn handle_start_recording(
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
) -> Result<(), bool> {
    // Check if a stream is already active (global singleton enforcement)
    let is_active = {
        let stream_lock = state.active_stream.lock().unwrap();
        stream_lock.is_some()
    }; // Lock released here
    
    if is_active {
        let _ = send_error_response(sender.clone(), state, key, request_id, 409, "Recording already in progress".to_string()).await;
        return Ok(());
    }

    // Get audio manager tx
    let audio_manager_tx = {
        let guard = state.audio_command_tx.lock().unwrap();
        guard.as_ref().map(|tx| tx.clone())
    }; // Lock released here
    
    let audio_manager_tx = match audio_manager_tx {
        Some(tx) => tx,
        None => {
            let _ = send_error_response(sender.clone(), state, key, request_id, 500, "Audio system not available".to_string()).await;
            return Ok(());
        }
    };

    // Create and start AudioStream with shared sender and request ID
    match AudioStream::create_and_start(
        audio_manager_tx,
        state.encryption_state.clone(),
        sender.clone(),
        request_id.to_string(),
    ).await {
        Ok(stream) => {
            // Store the stream globally
            {
                let mut stream_lock = state.active_stream.lock().unwrap();
                *stream_lock = Some(stream);
            } // Lock released here
            
            // Send encrypted success response
            let _ = send_encrypted_response(sender, state, key, request_id, "recording-started", None).await;
            
            println!("Started recording - stream stored globally");
        }
        Err(e) => {
            eprintln!("Failed to start recording - full trace: {}", e);
            let _ = send_error_response(sender.clone(), state, key, request_id, 500, "Failed to start recording".to_string()).await;
        }
    }
    
    Ok(())
}

/// Handle stop-recording command - SINGLE STOP POINT
async fn handle_stop_recording(
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
) -> Result<(), bool> {

    // Get and remove the global stream
    let stream = {
        let mut stream_lock = state.active_stream.lock().unwrap();
        stream_lock.take()
    };

    match stream {
        Some(stream) => {
            // SINGLE STOP POINT - AudioStream::stop() handles everything
            stream.stop(sender.clone(), key, request_id).await;
            
            // Send encrypted success response
            let _ = send_encrypted_response(sender, state, key, request_id, "recording-stopped", None).await;
            
            println!("Recording stopped via stop command");
        }
        None => {
            let _ = send_error_response(sender.clone(), state, key, request_id, 404, "No active recording to stop".to_string()).await;
        }
    }
    
    Ok(())
}

/// Handle health-check command
async fn handle_health_check(
    state: &StateForLocalServerHandler,
    key: &str,
    request_id: &str,
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
) -> Result<(), bool> {
    // Send encrypted health-check response with acknowledgment
    let ack_data = serde_json::json!({
        "message": state.config.acknowledgment_string.clone()
    });
    
    let _ = send_encrypted_response(sender, state, key, request_id, "health-check", Some(ack_data)).await;
    
    Ok(())
}
