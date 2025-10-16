use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock as AsyncRwLock;
use crate::config::AppConfig;

// Global singleton for encryption state (using async RwLock for handler compatibility)
static ENCRYPTION_STATE: OnceLock<Arc<AsyncRwLock<EncryptionState>>> = OnceLock::new();

// Error types for encryption operations
#[derive(Debug)]
pub enum EncryptionError {
    NoEntry,
    KeyringEntry(String),
    Serialization(String),
    Deserialization(String),
    KeyringOperation(String),
}

impl std::fmt::Display for EncryptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EncryptionError::NoEntry => write!(f, "No encryption data found in keyring"),
            EncryptionError::KeyringEntry(msg) => write!(f, "Failed to create keyring entry: {}", msg),
            EncryptionError::Serialization(msg) => write!(f, "Failed to serialize encryption data: {}", msg),
            EncryptionError::Deserialization(msg) => write!(f, "Failed to deserialize encryption data: {}", msg),
            EncryptionError::KeyringOperation(msg) => write!(f, "Keyring operation failed: {}", msg),
        }
    }
}

impl std::error::Error for EncryptionError {}

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

// Persistent encryption data structure for keyring storage
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct EncryptionData {
    pub key: Option<String>,
}

// Encryption state with nonce tracking maps
#[derive(Clone)]
pub struct EncryptionState {
    key: Option<String>,
    received_nonces: Arc<RwLock<HashMap<[u8; 12], Instant>>>,
    sent_nonces: Arc<RwLock<HashMap<[u8; 12], Instant>>>,
    last_cleanup: Arc<RwLock<Instant>>,
    config: Arc<AppConfig>,
}

impl EncryptionState {
    /// Get or initialize the global singleton encryption state
    pub fn get_or_init(config: Arc<AppConfig>) -> Arc<AsyncRwLock<EncryptionState>> {
        ENCRYPTION_STATE.get_or_init(|| {
            println!("Initializing encryption state singleton...");
            Arc::new(AsyncRwLock::new(Self::new(config)))
        }).clone()
    }

    /// Internal constructor for creating a new encryption state
    fn new(config: Arc<AppConfig>) -> Self {
        // Load only the key from keyring (no nonce data)
        let encryption_data = match load_encryption_data_from_keyring_blocking() {
            Ok(data) => data,
            Err(EncryptionError::NoEntry) => {
                println!("No existing encryption data in keyring, starting fresh");
                EncryptionData::default()
            }
            Err(e) => {
                eprintln!("Warning: Failed to load encryption data from keyring: {}", e);
                eprintln!("Continuing with empty state - will fetch from backend as needed");
                EncryptionData::default()
            }
        };

        println!("Loaded encryption data from keyring");

        Self {
            key: encryption_data.key,
            received_nonces: Arc::new(RwLock::new(HashMap::new())),
            sent_nonces: Arc::new(RwLock::new(HashMap::new())),
            last_cleanup: Arc::new(RwLock::new(Instant::now())),
            config,
        }
    }

    pub fn is_valid(&self) -> bool {
        self.key.is_some()
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
                println!("Cleaned {} expired received nonces", before_count - received.len());
            }
        }
        
        // Clean sent nonces
        {
            let mut sent = self.sent_nonces.write().unwrap();
            let before_count = sent.len();
            sent.retain(|_, instant| *instant > cutoff);
            if before_count > sent.len() {
                println!("Cleaned {} expired sent nonces", before_count - sent.len());
            }
        }
        
        *self.last_cleanup.write().unwrap() = Instant::now();
    }

    pub fn set_key(&mut self, key: String) {
        self.key = Some(key.clone());

        // Persist only the key to keyring using spawn_blocking
        let encryption_data = EncryptionData {
            key: Some(key),
        };

        tokio::task::spawn_blocking(move || {
            if let Err(e) = save_encryption_data_to_keyring_blocking(&encryption_data) {
                eprintln!("Warning: Failed to save encryption data to keyring: {}", e);
                eprintln!("Application will continue to function but encryption key won't be persisted");
            } else {
                println!("Encryption key successfully persisted to keyring");
            }
        });
    }

    pub fn get_key(&self) -> Option<&String> {
        self.key.as_ref()
    }

    // Clear encryption state and remove from keyring
    pub async fn clear(&mut self) -> Result<(), EncryptionError> {
        println!("Clearing encryption state...");

        // Clear in-memory state first
        self.key = None;
        self.received_nonces.write().unwrap().clear();
        self.sent_nonces.write().unwrap().clear();

        // Attempt to delete from keyring, but don't fail if keychain access is denied
        match delete_encryption_data_from_keyring().await {
            Ok(()) => {
                println!("Encryption data successfully removed from keyring");
            }
            Err(EncryptionError::KeyringOperation(ref msg)) if msg.contains("Keychain access restricted") => {
                // Keychain access denied - log warning but continue
                eprintln!("Warning: Could not remove encryption data from keyring due to access restrictions");
                eprintln!("In-memory encryption state has been cleared successfully");
            }
            Err(e) => {
                // Other keyring errors - log warning but continue
                eprintln!("Warning: Failed to remove encryption data from keyring: {}", e);
                eprintln!("In-memory encryption state has been cleared successfully");
            }
        }

        println!("Encryption state cleared successfully");
        Ok(())
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


// Async wrapper functions for keyring operations - following the pattern from auth.rs
async fn delete_encryption_data_from_keyring() -> Result<(), EncryptionError> {
    println!("Starting async keyring delete operation...");
    println!("Spawning blocking task for keyring delete...");
    
    let result = tokio::task::spawn_blocking(|| {
        delete_encryption_data_from_keyring_blocking()
    })
    .await
    .map_err(|e| EncryptionError::KeyringOperation(format!("Failed to spawn blocking task: {}", e)))?;
    
    println!("Blocking task completed for keyring delete");
    result
}

async fn save_encryption_data_to_keyring(encryption_data: &EncryptionData) -> Result<(), EncryptionError> {
    println!("Starting async keyring save operation...");
    let data = encryption_data.clone();
    println!("Spawning blocking task for keyring save...");
    
    let result = tokio::task::spawn_blocking(move || {
        save_encryption_data_to_keyring_blocking(&data)
    })
    .await
    .map_err(|e| EncryptionError::KeyringOperation(format!("Failed to spawn blocking task: {}", e)))?;
    
    println!("Blocking task completed for keyring save");
    result
}

// Helper functions for keyring operations - following the pattern from auth.rs
fn load_encryption_data_from_keyring_blocking() -> Result<EncryptionData, EncryptionError> {
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| EncryptionError::KeyringEntry(e.to_string()))?;

    match entry.get_password() {
        Ok(password) => serde_json::from_str::<EncryptionData>(&password)
            .map_err(|e| EncryptionError::Deserialization(e.to_string())),
        Err(keyring::Error::NoEntry) => {
            Err(EncryptionError::NoEntry)
        }
        Err(e) => Err(EncryptionError::KeyringOperation(e.to_string())),
    }
}

fn save_encryption_data_to_keyring_blocking(encryption_data: &EncryptionData) -> Result<(), EncryptionError> {
    println!("Creating keyring entry for encryption data save...");
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| EncryptionError::KeyringEntry(e.to_string()))?;

    println!("Serializing encryption data to JSON...");
    let encryption_json = serde_json::to_string(encryption_data)
        .map_err(|e| EncryptionError::Serialization(e.to_string()))?;

    println!("Setting password in keyring for encryption data...");
    match entry.set_password(&encryption_json) {
        Ok(()) => {
            println!("Encryption data saved to keyring successfully (blocking)");
            Ok(())
        }
        Err(keyring::Error::PlatformFailure(platform_error)) => {
            // Handle macOS keychain access denied (-25300) and other platform errors gracefully
            eprintln!("Warning: Keychain access denied or restricted ({})", platform_error);
            eprintln!("This may happen if you denied keychain access or have restricted permissions.");
            eprintln!("The application will continue to function but encryption keys won't be persisted.");
            Err(EncryptionError::KeyringOperation(format!("Keychain access restricted: {}", platform_error)))
        }
        Err(e) => {
            Err(EncryptionError::KeyringOperation(e.to_string()))
        }
    }
}

fn delete_encryption_data_from_keyring_blocking() -> Result<(), EncryptionError> {
    println!("Creating keyring entry for encryption data delete...");
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| EncryptionError::KeyringEntry(e.to_string()))?;

    println!("Deleting encryption data from keyring...");
    match entry.delete_credential() {
        Ok(()) => {
            println!("Encryption data deleted from keyring successfully (blocking)");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            // Not an error - entry doesn't exist, which is fine for delete operations
            println!("No encryption data found in keyring to delete (already clean)");
            Ok(())
        }
        Err(keyring::Error::PlatformFailure(platform_error)) => {
            // Handle macOS keychain access denied (-25300) and other platform errors gracefully
            eprintln!("Warning: Keychain access denied or restricted during delete ({})", platform_error);
            eprintln!("This may happen if you denied keychain access or have restricted permissions.");
            eprintln!("The application will continue to function normally.");
            Err(EncryptionError::KeyringOperation(format!("Keychain access restricted during delete: {}", platform_error)))
        }
        Err(e) => {
            Err(EncryptionError::KeyringOperation(e.to_string()))
        }
    }
}
