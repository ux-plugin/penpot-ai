use crate::local_server::audio::{AudioCommand, AudioStreamMessage};
use crate::local_server::encryption::{create_message_format, encrypt_message_with_timestamp, EncryptionState};
use axum::extract::ws::{Message, WebSocket};
use base64::engine::general_purpose;
use base64::Engine as _;
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock, Mutex};

#[derive(Serialize)]
struct AudioChunkPayload {
    id: String,
    #[serde(rename = "type")]
    response_type: String,
    data: String,
}

#[derive(Serialize)]
struct ResponsePayload {
    id: String,
    #[serde(rename = "type")]
    response_type: String,
}

/// Manages a single audio streaming session
/// Handles encryption, WebSocket sending, and stop coordination
pub struct AudioStream {
    audio_manager_tx: mpsc::Sender<AudioCommand>,
    stop_flag: Arc<AtomicBool>,
    request_id: String,
}

impl AudioStream {
    /// Create and start a new audio stream
    /// Ensures only one stream exists globally via state check
    pub async fn create_and_start(
        audio_manager_tx: mpsc::Sender<AudioCommand>,
        encryption_state: Arc<RwLock<EncryptionState>>,
        sender: Arc<Mutex<SplitSink<WebSocket, Message>>>,
        request_id: String,
    ) -> Result<Self, String> {
        let stream = Self {
            audio_manager_tx: audio_manager_tx.clone(),
            stop_flag: Arc::new(AtomicBool::new(false)),
            request_id: request_id.clone(),
        };

        // Create channels for audio data
        let (audio_tx, mut audio_rx) = mpsc::channel::<AudioStreamMessage>(10);
        let (response_tx, response_rx) = oneshot::channel();

        // Request AudioManager to start recording
        audio_manager_tx
            .send(AudioCommand::Start {
                audio_tx,
                response_tx,
            })
            .await
            .map_err(|_| "Failed to send start command to AudioManager".to_string())?;

        // Wait for AudioManager confirmation
        match response_rx.await {
            Ok(Ok(())) => {
                tracing::debug!("AudioStream: Recording started successfully");
            }
            Ok(Err(e)) => {
                return Err(format!("AudioManager rejected start: {}", e));
            }
            Err(_) => {
                return Err("AudioManager did not respond".to_string());
            }
        }

        // Spawn background task to handle audio streaming
        let sender_clone = sender;
        let enc_state_clone = encryption_state;
        let stop_flag_clone = Arc::clone(&stream.stop_flag);
        let request_id_clone = request_id.clone();

        tokio::spawn(async move {
            while let Some(msg) = audio_rx.recv().await {
                // Check if we've been stopped
                if stop_flag_clone.load(Ordering::SeqCst) {
                    break;
                }

                match msg {
                    AudioStreamMessage::Data(bytes) => {
                        // Encrypt the audio chunk with request ID
                        let enc_state = enc_state_clone.read().await;
                        let nonce = enc_state.generate_unique_nonce();
                        
                        if let Some(key) = enc_state.get_key() {
                            // Base64-encode the audio bytes
                            let audio_base64 = general_purpose::STANDARD.encode(&bytes);
                            
                            // Create payload with request ID
                            let payload = AudioChunkPayload {
                                id: request_id_clone.clone(),
                                response_type: "audio-chunk".to_string(),
                                data: audio_base64,
                            };
                            
                            if let Ok(payload_json) = serde_json::to_string(&payload) {
                                // Encrypt the payload using the same format as other responses
                                match encrypt_message_with_timestamp(&key, &nonce, &payload_json) {
                                    Ok(encrypted_response) => {
                                        // Create message format: base64<nonce | encrypted_payload>
                                        match create_message_format(&nonce, &encrypted_response) {
                                            Ok(message) => {
                                                let mut sender_lock = sender_clone.lock().await;
                                                if sender_lock.send(Message::Text(message.into())).await.is_err() {
                                                    tracing::error!("AudioStream: Failed to send audio chunk");
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                tracing::error!("AudioStream: Failed to create message format: {}", e);
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        tracing::error!("AudioStream: Failed to encrypt audio chunk: {}", e);
                                    }
                                }
                            }
                        }
                    }
                    AudioStreamMessage::Error(err) => {
                        tracing::error!("AudioStream: Audio error: {}", err);
                        break;
                    }
                }
            }
            
            tracing::debug!("AudioStream: Streaming task ended");
        });

        Ok(stream)
    }

    /// Stop the audio stream
    /// SINGLE STOP POINT - ensures AudioCommand::Stop is sent exactly once
    pub async fn stop(&self, _sender: Arc<Mutex<SplitSink<WebSocket, Message>>>, _key: &str, _request_id: &str) {
        if !self.stop_flag.swap(true, Ordering::SeqCst) {
            tracing::debug!("AudioStream: Stopping recording");
            let _ = self.audio_manager_tx.send(AudioCommand::Stop).await;
            
            // Note: The actual recording-stopped response is sent by the caller (handle_stop_recording)
            // This method just stops the audio manager
        }
    }

    /// Stop the audio stream without sending a response (for cleanup on disconnect)
    pub async fn stop_silent(&self) {
        if !self.stop_flag.swap(true, Ordering::SeqCst) {
            tracing::debug!("AudioStream: Stopping recording (silent cleanup)");
            let _ = self.audio_manager_tx.send(AudioCommand::Stop).await;
        }
    }
}

impl Drop for AudioStream {
    fn drop(&mut self) {
        // Ensure a stop command is sent if not already stopped
        if !self.stop_flag.load(Ordering::SeqCst) {
            tracing::debug!("AudioStream: Drop detected - sending stop command");
            let tx = self.audio_manager_tx.clone();
            tokio::spawn(async move {
                let _ = tx.send(AudioCommand::Stop).await;
            });
        }
    }
}
