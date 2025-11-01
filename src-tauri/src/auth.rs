use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

// Authentication error messages
pub mod auth_errors {
    pub const NOT_AUTHENTICATED: &str = "Unauthorized: User is not authenticated";
    pub const NOT_CURRENTLY_AUTHENTICATED: &str = "Unauthorized: User is not currently authenticated";
}

// Authentication credentials structure
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AuthCredentials {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub aes_gcm: Option<String>,
    pub refresh_token_expires_at: Option<String>,
    pub user_id: Option<String>,
}

// Authentication state manager
pub struct AuthState {
    credentials: Arc<RwLock<AuthCredentials>>,
}

impl Default for AuthState {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthState {
    // Create a new AuthState instance with immediate initialization
    pub fn new() -> Self {
        let initial_credentials = load_credentials_from_keyring_blocking()
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to load credentials from keyring: {}", e);
                AuthCredentials::default()
            });

        Self {
            credentials: Arc::new(RwLock::new(initial_credentials)),
        }
    }

    // Get current credentials (blocks if initialization not complete)
    pub async fn get(&self) -> Result<AuthCredentials, String> {
        let credentials = self.credentials.read().await;
        Ok(credentials.clone())
    }

    // Set credentials and persist to keyring
    pub async fn set(&self, new_credentials: AuthCredentials) -> Result<(), String> {
        tracing::debug!("Setting credentials");
        
        // Update in-memory credentials first
        {
            tracing::trace!("Acquiring write lock for setting credentials");
            let mut credentials = self.credentials.write().await;
            tracing::trace!("Write lock acquired, updating in-memory credentials");
            *credentials = new_credentials.clone();
            tracing::trace!("In-memory credentials updated");
            save_credentials_to_keyring(&new_credentials).await?;
            tracing::debug!("Credentials saved to keyring successfully");
        } // Lock is released here
        
        Ok(())
    }

    // Update specific fields and persist to keyring
    pub async fn update<F>(&self, update_fn: F) -> Result<(), String>
    where
        F: FnOnce(&mut AuthCredentials),
    {
        tracing::debug!("Updating credentials");
        
        // Update in-memory credentials and clone for keyring save
        {
            tracing::trace!("Acquiring write lock for updating credentials");
            let mut credentials = self.credentials.write().await;
            tracing::trace!("Write lock acquired, applying update function");
            update_fn(&mut credentials);
            tracing::trace!("Update function applied, cloning credentials");
            save_credentials_to_keyring(&credentials.clone()).await?;
            tracing::debug!("Updated credentials saved to keyring successfully");
        }; // Lock is released here

        Ok(())
    }

    // Clear credentials and delete from the keyring
    pub async fn clear(&self) -> Result<(), String> {
        tracing::debug!("Clearing credentials");
        
        // Clear in-memory credentials first
        {
            tracing::trace!("Acquiring write lock for clearing credentials");
            let mut credentials = self.credentials.write().await;
            tracing::trace!("Write lock acquired, clearing in-memory credentials");
            *credentials = AuthCredentials::default();
            tracing::trace!("In-memory credentials cleared");
            delete_credentials_from_keyring().await?;
            tracing::debug!("Credentials deleted from keyring successfully");
        } // Lock is released here

        Ok(())
    }

    // Check if a user is authenticated by validating refresh token expiration
    pub async fn is_authenticated(&self) -> Result<bool, String> {
        let credentials = self.credentials.read().await;
        
        // Check if refresh_token_expires_at exists and hasn't expired
        match &credentials.refresh_token_expires_at {
            Some(expires_at_str) => {
                // Parse the expiration time string
                match expires_at_str.parse::<i64>() {
                    Ok(expires_at_timestamp) => {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_err(|e| format!("Failed to get current time: {}", e))?
                            .as_secs() as i64;
                        
                        // Token is valid if it hasn't expired
                        Ok(expires_at_timestamp > now)
                    }
                    Err(_) => {
                        // Try parsing as an ISO format if timestamp parsing fails
                        match chrono::DateTime::parse_from_rfc3339(expires_at_str) {
                            Ok(expires_at) => {
                                let now = chrono::Utc::now();
                                Ok(expires_at > now)
                            }
                            Err(_) => {
                                // If both parsing methods fail, consider unauthenticated
                                Ok(false)
                            }
                        }
                    }
                }
            }
            None => Ok(false), // No expiration time means not authenticated
        }
    }
}

// Helper functions for keyring operations
fn load_credentials_from_keyring_blocking() -> Result<AuthCredentials, String> {
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    match entry.get_password() {
        Ok(password) => serde_json::from_str::<AuthCredentials>(&password)
            .map_err(|e| format!("Failed to deserialize credentials: {}", e)),
        Err(keyring::Error::NoEntry) => {
            // Return empty credentials if no entry exists
            Ok(AuthCredentials::default())
        }
        Err(e) => Err(format!("Failed to get credentials from keyring: {}", e)),
    }
}

async fn save_credentials_to_keyring(credentials: &AuthCredentials) -> Result<(), String> {
    tracing::trace!("Starting async keyring save operation");
    // Use tokio::task::spawn_blocking for keyring operations in an async context
    let credentials_clone = credentials.clone();
    tracing::trace!("Spawning blocking task for keyring save");
    let result = tokio::task::spawn_blocking(move || {
        save_credentials_to_keyring_blocking(&credentials_clone)
    })
    .await
    .map_err(|e| format!("Failed to spawn blocking task: {}", e))?;

    tracing::trace!("Blocking task completed for keyring save");
    result
}

async fn delete_credentials_from_keyring() -> Result<(), String> {
    tracing::trace!("Starting async keyring delete operation");
    // Use tokio::task::spawn_blocking for keyring operations in an async context
    tracing::trace!("Spawning blocking task for keyring delete");
    let result = tokio::task::spawn_blocking(|| {
        delete_credentials_from_keyring_blocking()
    })
    .await
    .map_err(|e| format!("Failed to spawn blocking task: {}", e))?;
    
    tracing::trace!("Blocking task completed for keyring delete");
    result
}

fn save_credentials_to_keyring_blocking(credentials: &AuthCredentials) -> Result<(), String> {
    tracing::trace!("Creating keyring entry for save");
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    tracing::trace!("Serializing credentials to JSON");
    let credentials_json = serde_json::to_string(credentials)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    tracing::trace!("Setting password in keyring");
    entry
        .set_password(&credentials_json)
        .map_err(|e| format!("Failed to set credentials in keyring: {}", e))?;
    
    tracing::trace!("Credentials saved to keyring successfully (blocking)");
    Ok(())
}

fn delete_credentials_from_keyring_blocking() -> Result<(), String> {
    tracing::trace!("Creating keyring entry for delete");
    let entry = Entry::new("figma_plugin_companion_app", "auth_credentials")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;

    tracing::trace!("Deleting credentials from keyring");
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete credentials from keyring: {}", e))?;
    
    tracing::trace!("Credentials deleted from keyring successfully (blocking)");
    Ok(())
}
