use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// Request/Response structures for encrypted communication
#[derive(Serialize, Deserialize)]
pub struct InitRequest {
    pub encrypted_data: String, // Base64 encoded encrypted data
    pub nonce: String,         // Base64 encoded nonce
}

#[derive(Serialize, Deserialize)]
pub struct InitResponse {
    pub encrypted_data: String, // Base64 encoded encrypted response
    pub nonce: String,         // Base64 encoded nonce for next request
}

// Encryption state to store the validated key
#[derive(Clone, Default)]
pub struct EncryptionState {
    key: Option<String>,
    expires_at: Option<String>,
    nonce_counter: Arc<AtomicU64>,
}

impl EncryptionState {
    pub fn new() -> Self {
        Self {
            key: None,
            expires_at: None,
            nonce_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn is_valid(&self) -> bool {
        if self.key.is_none() {
            return false;
        }

        if let Some(expires_at) = &self.expires_at {
            // Parse and check expiration
            if let Ok(expiry) = expires_at.parse::<DateTime<Utc>>() {
                return expiry > Utc::now();
            }
        }

        false
    }

    pub fn increment_nonce(&self) -> u64 {
        self.nonce_counter.fetch_add(1, Ordering::SeqCst)
    }

    pub fn get_current_nonce(&self) -> u64 {
        self.nonce_counter.load(Ordering::SeqCst)
    }

    pub fn set_nonce(&self, nonce: u64) {
        self.nonce_counter.store(nonce, Ordering::SeqCst);
    }

    pub fn set_key(&mut self, key: String, expires_at: String) {
        self.key = Some(key);
        self.expires_at = Some(expires_at);
    }

    pub fn get_key(&self) -> Option<&String> {
        self.key.as_ref()
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

    // Create nonce from counter
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