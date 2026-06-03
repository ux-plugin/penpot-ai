use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock as AsyncRwLock;
use crate::config::AppConfig;

// Global singleton for encryption state (using async RwLock for handler compatibility)
static ENCRYPTION_STATE: OnceLock<Arc<AsyncRwLock<EncryptionState>>> = OnceLock::new();


// Request/Response structures for encrypted communication
#[derive(Serialize, Deserialize)]
pub struct InitRequest {
    pub encrypted_data: String,
    pub nonce: String,
}

#[derive(Serialize, Deserialize)]
pub struct InitResponse {
    pub encrypted_data: String,
}

// Request structure for handlers that need nonce validation
#[derive(Serialize, Deserialize)]
pub struct NonceRequest {
    pub encrypted_data: String,
    pub nonce: String,
}

// Message payload structure for encrypted communication
#[derive(Serialize, Deserialize)]
pub struct MessagePayload {
    pub data: String,
    pub timestamp_ms: u64, // Unix timestamp in milliseconds
}

// Encryption state with nonce tracking maps
#[derive(Clone)]
pub struct EncryptionState {
    key: Arc<RwLock<Option<String>>>,
    received_nonces: Arc<RwLock<HashMap<[u8; 12], Instant>>>,
    sent_nonces: Arc<RwLock<HashMap<[u8; 12], Instant>>>,
    last_cleanup: Arc<RwLock<Instant>>,
    config: Arc<AppConfig>,
}

impl EncryptionState {
    /// Get or initialize the global singleton encryption state
    pub fn get_or_init(config: Arc<AppConfig>) -> Arc<AsyncRwLock<EncryptionState>> {
        ENCRYPTION_STATE.get_or_init(|| {
            tracing::debug!("Initializing encryption state singleton");
            Arc::new(AsyncRwLock::new(Self::new(config)))
        }).clone()
    }

    /// Internal constructor for creating a new encryption state
    fn new(config: Arc<AppConfig>) -> Self {
        tracing::debug!("Initializing encryption state with in-memory key storage only");

        Self {
            key: Arc::new(RwLock::new(None)),
            received_nonces: Arc::new(RwLock::new(HashMap::new())),
            sent_nonces: Arc::new(RwLock::new(HashMap::new())),
            last_cleanup: Arc::new(RwLock::new(Instant::now())),
            config,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.key.read().unwrap().is_some()
    }

    // Generate a cryptographically secure unique nonce
    pub fn generate_unique_nonce(&self) -> [u8; 12] {
        use rand::RngCore;
        let mut rng = rand::thread_rng();
        
        loop {
            let mut nonce = [0u8; 12];
            rng.fill_bytes(&mut nonce);
        
            // Acquire write lock once and check + insert atomically
            let mut sent = self.sent_nonces.write().unwrap();
            if !sent.contains_key(&nonce) {
                sent.insert(nonce, Instant::now());
                drop(sent);
            
                // Trigger cleanup if needed
                self.cleanup_if_needed();
                
                return nonce;
            }
            // If collision, release lock and try again
        }
    }

    // Validate nonce and timestamp for incoming messages
    pub fn validate_nonce_and_timestamp(&self, nonce: &[u8; 12], payload: &MessagePayload) -> Result<(), String> {
        // 1. Validate timestamp within configured window
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let time_diff_ms = (now_ms as i64 - payload.timestamp_ms as i64).abs() as u64;
        
        if time_diff_ms > self.config.nonce_timestamp_window_ms {
            return Err(format!("Message timestamp outside acceptable window: {} ms", time_diff_ms));
        }
        
        // 2. Check for nonce replay
        {
            let received = self.received_nonces.read().unwrap();
            if received.contains_key(nonce) {
                return Err("Nonce replay detected".to_string());
            }
        }
        
        // 3. Add nonce to tracking
        {
            let mut received = self.received_nonces.write().unwrap();
            received.insert(*nonce, Instant::now());
        }
        
        // 4. Trigger cleanup if needed
        self.cleanup_if_needed();
        
        Ok(())
    }

    // Check if cleanup is needed and perform it
    fn cleanup_if_needed(&self) {
        let should_cleanup = {
            let last_cleanup = self.last_cleanup.read().unwrap();
            let window_duration_ms = Duration::from_millis(self.config.nonce_timestamp_window_ms);
            last_cleanup.elapsed() >= window_duration_ms
        };
        
        if should_cleanup {
            self.cleanup_old_nonces();
        }
    }

    // Clean up expired nonces from memory
    fn cleanup_old_nonces(&self) {
        let window_duration_ms = Duration::from_millis(self.config.nonce_timestamp_window_ms);
        let cutoff = Instant::now() - window_duration_ms;
        
        // Clean received nonces
        {
            let mut received = self.received_nonces.write().unwrap();
            let before_count = received.len();
            received.retain(|_, instant| *instant > cutoff);
            if before_count > received.len() {
                tracing::trace!("Cleaned {} expired received nonces", before_count - received.len());
            }
        }
        
        // Clean sent nonces
        {
            let mut sent = self.sent_nonces.write().unwrap();
            let before_count = sent.len();
            sent.retain(|_, instant| *instant > cutoff);
            if before_count > sent.len() {
                tracing::trace!("Cleaned {} expired sent nonces", before_count - sent.len());
            }
        }
        
        *self.last_cleanup.write().unwrap() = Instant::now();
    }

    pub fn set_key(&mut self, key: String) {
        *self.key.write().unwrap() = Some(key);
        tracing::trace!("Encryption key set in memory (not persisted)");
    }

    pub fn get_key(&self) -> Option<String> {
        self.key.read().unwrap().clone()
    }

    // Clear encryption state from memory
    pub async fn clear(&mut self) {
        tracing::debug!("Clearing encryption state from memory");

        // Clear in-memory state
        *self.key.write().unwrap() = None;
        self.received_nonces.write().unwrap().clear();
        self.sent_nonces.write().unwrap().clear();

        tracing::debug!("Encryption state cleared successfully");
    }
}

// Helper functions for AES-GCM encryption/decryption

// Encryption function with timestamp in payload
pub fn encrypt_message_with_timestamp(key_base64: &str, nonce: &[u8; 12], message: &str) -> Result<String, String> {
    let payload = MessagePayload {
        data: message.to_string(),
        timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64,
    };
    
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize payload: {}", e))?;
    
    // AES-GCM encryption
    let key_bytes = general_purpose::STANDARD.decode(key_base64)
        .map_err(|e| format!("Failed to decode key: {}", e))?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce_obj = Nonce::from_slice(nonce);
    
    let ciphertext = cipher.encrypt(nonce_obj, payload_json.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;
    
    Ok(general_purpose::STANDARD.encode(&ciphertext))
}

// Decrypt and parse message payload
pub fn decrypt_and_parse_payload(key_base64: &str, nonce: &[u8; 12], ciphertext_base64: &str) -> Result<MessagePayload, String> {
    // Decode key and ciphertext
    let key_bytes = general_purpose::STANDARD.decode(key_base64)
        .map_err(|e| format!("Failed to decode key: {}", e))?;
    let ciphertext = general_purpose::STANDARD.decode(ciphertext_base64)
        .map_err(|e| format!("Failed to decode ciphertext: {}", e))?;

    // Create cipher
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce_obj = Nonce::from_slice(nonce);

    // Decrypt
    let plaintext = cipher.decrypt(nonce_obj, ciphertext.as_ref())
        .map_err(|e| format!("Decryption failed: {}", e))?;
    
    // Parse JSON payload
    let payload_json = String::from_utf8(plaintext)
        .map_err(|e| format!("Failed to convert decrypted data to string: {}", e))?;
    
    serde_json::from_str::<MessagePayload>(&payload_json)
        .map_err(|e| format!("Failed to parse message payload: {}", e))
}

// Parse message format: base64<nonce(12)|encrypted_payload>
pub fn parse_message_format(body: &[u8]) -> Result<([u8; 12], String), String> {
    // Decode base64 body
    let decoded = general_purpose::STANDARD.decode(body)
        .map_err(|e| format!("Failed to decode base64 message: {}", e))?;
    
    if decoded.len() < 12 {
        return Err("Message too short: missing nonce".to_string());
    }
    
    // Extract nonce (first 12 bytes)
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&decoded[0..12]);
    
    // Extract encrypted payload (remaining bytes)
    let encrypted_payload = general_purpose::STANDARD.encode(&decoded[12..]);
    
    Ok((nonce, encrypted_payload))
}

// Create message format: base64<nonce(12)|encrypted_payload>
pub fn create_message_format(nonce: &[u8; 12], encrypted_payload: &str) -> Result<String, String> {
    let payload_bytes = general_purpose::STANDARD.decode(encrypted_payload)
        .map_err(|e| format!("Failed to decode encrypted payload: {}", e))?;
    
    let mut message = Vec::with_capacity(12 + payload_bytes.len());
    message.extend_from_slice(nonce);
    message.extend_from_slice(&payload_bytes);
    
    Ok(general_purpose::STANDARD.encode(&message))
}

// Encrypt audio chunk with timestamp in the format: base64<nonce|encrypted_payload>
// where payload is {timestamp: timestamp_ms, data: audio_chunk_base64}
pub fn encrypt_audio_chunk(key_base64: &str, nonce: &[u8; 12], audio_bytes: &[u8]) -> Result<String, String> {
    // Base64-encode the audio bytes
    let audio_base64 = general_purpose::STANDARD.encode(audio_bytes);
    
    // Create payload with timestamp and audio data
    let payload = MessagePayload {
        data: audio_base64,
        timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64,
    };
    
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize audio payload: {}", e))?;
    
    // AES-GCM encryption
    let key_bytes = general_purpose::STANDARD.decode(key_base64)
        .map_err(|e| format!("Failed to decode key: {}", e))?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce_obj = Nonce::from_slice(nonce);
    
    let ciphertext = cipher.encrypt(nonce_obj, payload_json.as_bytes())
        .map_err(|e| format!("Audio encryption failed: {}", e))?;
    
    let encrypted_payload = general_purpose::STANDARD.encode(&ciphertext);
    
    // Create message format: base64<nonce|encrypted_payload>
    create_message_format(nonce, &encrypted_payload)
}
