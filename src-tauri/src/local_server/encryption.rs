use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use keyring::Entry;
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

// Persistent encryption data structure for keyring storage
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct EncryptionData {
    pub key: Option<String>,
    pub expires_at: Option<String>,
    pub nonce_counter: u64,
    pub last_persisted_nonce: u64, // Always kept in sync with nonce_counter
}

// Encryption state to store the validated key
#[derive(Clone, Default)]
pub struct EncryptionState {
    key: Option<String>,
    expires_at: Option<String>,
    nonce_counter: Arc<AtomicU64>,
    last_persisted_nonce: Arc<AtomicU64>, // Track what was last persisted
}

impl EncryptionState {
    pub fn new() -> Self {
        // Try to load from keyring, fallback to default if not available
        let encryption_data = load_encryption_data_from_keyring_blocking()
            .unwrap_or_else(|e| {
                // Only log as info for "No entry" errors, warn for others
                match e.as_str() {
                    s if s.contains("No entry") => {
                        println!("No existing encryption data in keyring, starting fresh");
                    }
                    _ => {
                        eprintln!("Warning: Failed to load encryption data from keyring: {}", e);
                        eprintln!("Continuing with empty state - will fetch from backend as needed");
                    }
                }
                EncryptionData::default()
            });

        // Validate loaded data
        let validated_data = if let (Some(ref key), Some(ref expires_at)) =
            (&encryption_data.key, &encryption_data.expires_at) {
            // Check if the loaded key is expired
            if let Ok(expiry) = expires_at.parse::<DateTime<Utc>>() {
                if expiry <= Utc::now() {
                    println!("Loaded encryption key is expired, will fetch fresh from backend");
                    EncryptionData::default()
                } else {
                    println!("Loaded valid encryption key from keyring (expires: {})", expires_at);
                    encryption_data
                }
            } else {
                eprintln!("Warning: Invalid expiry date in stored encryption data, resetting");
                EncryptionData::default()
            }
        } else {
            encryption_data
        };

        Self {
            key: validated_data.key,
            expires_at: validated_data.expires_at,
            nonce_counter: Arc::new(AtomicU64::new(validated_data.nonce_counter)),
            last_persisted_nonce: Arc::new(AtomicU64::new(validated_data.last_persisted_nonce)),
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
        let new_nonce = self.nonce_counter.fetch_add(1, Ordering::SeqCst);

        // Always persist nonce to keyring (no batching optimization)
        self.persist_nonce_to_keyring();

        new_nonce
    }

    // Helper method to persist nonce to keyring with current state
    fn persist_nonce_to_keyring(&self) {
        let key = self.key.clone();
        let expires_at = self.expires_at.clone();
        let current_nonce = self.nonce_counter.load(Ordering::SeqCst);
        let last_persisted_nonce = self.last_persisted_nonce.clone();

        // Only persist if we have a key
        if let (Some(key), Some(expires_at)) = (key, expires_at) {
            tokio::spawn(async move {
                let encryption_data = EncryptionData {
                    key: Some(key),
                    expires_at: Some(expires_at),
                    nonce_counter: current_nonce,
                    last_persisted_nonce: current_nonce,
                };

                if let Err(e) = save_encryption_data_to_keyring(&encryption_data).await {
                    eprintln!("Warning: Failed to persist nonce to keyring: {}", e);
                    // Don't update last_persisted_nonce on failure
                } else {
                    // Update the last persisted nonce on successful save
                    last_persisted_nonce.store(current_nonce, Ordering::SeqCst);
                    println!("Nonce counter persisted to keyring ({})", current_nonce);
                }
            });
        }
    }

    pub fn get_current_nonce(&self) -> u64 {
        self.nonce_counter.load(Ordering::SeqCst)
    }

    pub fn set_nonce(&self, nonce: u64) {
        self.nonce_counter.store(nonce, Ordering::SeqCst);
    }

    pub fn set_key(&mut self, key: String, expires_at: String) {
        self.key = Some(key.clone());
        self.expires_at = Some(expires_at.clone());

        // Persist to keyring - ignore errors to avoid breaking functionality
        let current_nonce = self.nonce_counter.load(Ordering::SeqCst);
        let encryption_data = EncryptionData {
            key: Some(key),
            expires_at: Some(expires_at),
            nonce_counter: current_nonce,
            last_persisted_nonce: current_nonce,
        };

        // Save to keyring in the background (non-blocking)
        tokio::spawn(async move {
            if let Err(e) = save_encryption_data_to_keyring(&encryption_data).await {
                eprintln!("Warning: Failed to save encryption data to keyring: {}", e);
                eprintln!("Application will continue to function but encryption key won't be persisted");
            } else {
                println!("Encryption key successfully persisted to keyring");
            }
        });

        // Update last persisted nonce counter
        self.last_persisted_nonce.store(current_nonce, Ordering::SeqCst);
    }

    pub fn get_key(&self) -> Option<&String> {
        self.key.as_ref()
    }

    pub fn get_expires_at(&self) -> Option<&String> {
        self.expires_at.as_ref()
    }

    // Clear encryption state and remove from keyring
    pub async fn clear(&mut self) -> Result<(), String> {
        println!("Clearing encryption state...");

        // Clear in-memory state first
        self.key = None;
        self.expires_at = None;
        self.nonce_counter.store(0, Ordering::SeqCst);
        self.last_persisted_nonce.store(0, Ordering::SeqCst);

        // Delete from keyring
        delete_encryption_data_from_keyring().await?;

        println!("Encryption state cleared successfully");
        Ok(())
    }

    // Ensure final nonce state is persisted (call on shutdown)
    pub async fn persist_final_state(&self) -> Result<(), String> {
        if let (Some(key), Some(expires_at)) = (&self.key, &self.expires_at) {
            let current_nonce = self.nonce_counter.load(Ordering::SeqCst);
            let encryption_data = EncryptionData {
                key: Some(key.clone()),
                expires_at: Some(expires_at.clone()),
                nonce_counter: current_nonce,
                last_persisted_nonce: current_nonce,
            };

            save_encryption_data_to_keyring(&encryption_data).await?;
            self.last_persisted_nonce.store(current_nonce, Ordering::SeqCst);
            println!("Final encryption state persisted to keyring");
        }
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

// Helper functions for keyring operations - following the pattern from auth.rs
fn load_encryption_data_from_keyring_blocking() -> Result<EncryptionData, String> {
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    match entry.get_password() {
        Ok(password) => serde_json::from_str::<EncryptionData>(&password)
            .map_err(|e| format!("Failed to deserialize encryption data: {}", e)),
        Err(keyring::Error::NoEntry) => {
            // Return empty encryption data if no entry exists
            Ok(EncryptionData::default())
        }
        Err(e) => Err(format!("Failed to get encryption data from keyring: {}", e)),
    }
}

async fn save_encryption_data_to_keyring(encryption_data: &EncryptionData) -> Result<(), String> {
    println!("Starting async keyring save operation for encryption data...");
    // Use tokio::task::spawn_blocking for keyring operations in an async context
    let encryption_data_clone = encryption_data.clone();
    println!("Spawning blocking task for encryption keyring save...");
    let result = tokio::task::spawn_blocking(move || {
        save_encryption_data_to_keyring_blocking(&encryption_data_clone)
    })
    .await
    .map_err(|e| format!("Failed to spawn blocking task: {}", e))?;

    println!("Blocking task completed for encryption keyring save");
    result
}

async fn delete_encryption_data_from_keyring() -> Result<(), String> {
    println!("Starting async keyring delete operation for encryption data...");
    // Use tokio::task::spawn_blocking for keyring operations in an async context
    println!("Spawning blocking task for encryption keyring delete...");
    let result = tokio::task::spawn_blocking(|| {
        delete_encryption_data_from_keyring_blocking()
    })
    .await
    .map_err(|e| format!("Failed to spawn blocking task: {}", e))?;

    println!("Blocking task completed for encryption keyring delete");
    result
}

fn save_encryption_data_to_keyring_blocking(encryption_data: &EncryptionData) -> Result<(), String> {
    println!("Creating keyring entry for encryption data save...");
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    println!("Serializing encryption data to JSON...");
    let encryption_json = serde_json::to_string(encryption_data)
        .map_err(|e| format!("Failed to serialize encryption data: {}", e))?;

    println!("Setting password in keyring for encryption data...");
    entry
        .set_password(&encryption_json)
        .map_err(|e| format!("Failed to set encryption data in keyring: {}", e))?;

    println!("Encryption data saved to keyring successfully (blocking)");
    Ok(())
}

fn delete_encryption_data_from_keyring_blocking() -> Result<(), String> {
    println!("Creating keyring entry for encryption data delete...");
    let entry = Entry::new("figma_plugin_companion_app", "encryption_state")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    println!("Deleting encryption data from keyring...");
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete encryption data from keyring: {}", e))?;

    println!("Encryption data deleted from keyring successfully (blocking)");
    Ok(())
}