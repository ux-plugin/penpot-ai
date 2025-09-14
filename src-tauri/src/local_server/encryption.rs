use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
    pub nonce: String,
}

// Persistent encryption data structure for keyring storage
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct EncryptionData {
    pub key: Option<String>,
    pub nonce_counter: u64,
}

// Encryption state to store the validated key
#[derive(Clone, Default)]
pub struct EncryptionState {
    key: Option<String>,
    nonce_counter: Arc<AtomicU64>,
}

impl EncryptionState {
    pub fn new() -> Self {
        // Try to load from the keyring, fallback to default if not available
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

        // Use loaded data directly since we no longer validate expiration
        println!("Loaded encryption data from keyring");

        Self {
            key: encryption_data.key,
            nonce_counter: Arc::new(AtomicU64::new(encryption_data.nonce_counter)),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.key.is_some()
    }

    pub fn increment_nonce(&self) -> u64 {
        let new_nonce = self.nonce_counter.fetch_add(1, Ordering::SeqCst);

        // Always persist nonce to keyring after incrementing
        self.persist_nonce_to_keyring();

        new_nonce
    }


    // Helper method to persist nonce to keyring with the current state
    fn persist_nonce_to_keyring(&self) {
        let key = self.key.clone();
        let current_nonce = self.nonce_counter.load(Ordering::SeqCst);

        // Only persist if we have a key
        if let Some(key) = key {
            let encryption_data = EncryptionData {
                key: Some(key),
                nonce_counter: current_nonce,
            };

            if let Err(e) = save_encryption_data_to_keyring_blocking(&encryption_data) {
                eprintln!("Warning: Failed to persist nonce to keyring: {}", e);
            } else {
                println!("Nonce counter persisted to keyring ({})", current_nonce);
            }
        }
    }

    pub fn get_current_nonce(&self) -> u64 {
        self.nonce_counter.load(Ordering::SeqCst)
    }

    pub fn set_nonce(&self, nonce: u64) {
        self.nonce_counter.store(nonce, Ordering::SeqCst);
    }

    pub fn set_key(&mut self, key: String) {
        self.key = Some(key.clone());

        // Persist to keyring - ignore errors to avoid breaking functionality
        let current_nonce = self.nonce_counter.load(Ordering::SeqCst);
        let encryption_data = EncryptionData {
            key: Some(key),
            nonce_counter: current_nonce,
        };

        if let Err(e) = save_encryption_data_to_keyring_blocking(&encryption_data) {
            eprintln!("Warning: Failed to save encryption data to keyring: {}", e);
            eprintln!("Application will continue to function but encryption key won't be persisted");
        } else {
            println!("Encryption key successfully persisted to keyring");
        }
    }

    pub fn get_key(&self) -> Option<&String> {
        self.key.as_ref()
    }

    // Clear encryption state and remove from keyring
    pub async fn clear(&mut self) -> Result<(), EncryptionError> {
        println!("Clearing encryption state...");

        // Clear in-memory state first
        self.key = None;
        self.nonce_counter.store(0, Ordering::SeqCst);

        // Delete from keyring
        delete_encryption_data_from_keyring_blocking()?;

        println!("Encryption state cleared successfully");
        Ok(())
    }
}

// Helper functions for AES-GCM encryption/decryption
pub fn decrypt_message(key_base64: &str, nonce_base64: &str, ciphertext_base64: &str) -> Result<Vec<u8>, String> {
    // Decode base64 inputs
    let key_bytes = general_purpose::STANDARD.decode(key_base64)
        .map_err(|e| format!("Failed to decode key: {}", e))?;
    let nonce_bytes = general_purpose::STANDARD.decode(nonce_base64)
        .map_err(|e| format!("Failed to decode nonce: {}", e))?;
    let ciphertext = general_purpose::STANDARD.decode(ciphertext_base64)
        .map_err(|e| format!("Failed to decode ciphertext: {}", e))?;

    // Create cipher
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Decrypt
    cipher.decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("Decryption failed: {}", e))
}

pub fn encrypt_message(key_base64: &str, nonce: u64, plaintext: &[u8]) -> Result<(String, String), String> {
    // Decode key
    let key_bytes = general_purpose::STANDARD.decode(key_base64)
        .map_err(|e| format!("Failed to decode key: {}", e))?;

    // Create nonce from the counter
    let mut nonce_bytes = vec![0u8; 12];
    nonce_bytes[4..12].copy_from_slice(&nonce.to_be_bytes());

    // Create cipher
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce_obj = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    let ciphertext = cipher.encrypt(nonce_obj, plaintext)
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // Return base64 encoded results
    Ok((
        general_purpose::STANDARD.encode(&ciphertext),
        general_purpose::STANDARD.encode(&nonce_bytes),
    ))
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
    entry
        .set_password(&encryption_json)
        .map_err(|e| EncryptionError::KeyringOperation(e.to_string()))?;

    println!("Encryption data saved to keyring successfully (blocking)");
    Ok(())
}

fn delete_encryption_data_from_keyring_blocking() -> Result<(), EncryptionError> {
    println!("Creating keyring entry for encryption data delete...");
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| EncryptionError::KeyringEntry(e.to_string()))?;

    println!("Deleting encryption data from keyring...");
    entry
        .delete_credential()
        .map_err(|e| EncryptionError::KeyringOperation(e.to_string()))?;

    println!("Encryption data deleted from keyring successfully (blocking)");
    Ok(())
}
