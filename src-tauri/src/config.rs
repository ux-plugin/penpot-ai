use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub backend_base_url: String,
    pub keyring_service: String,
    pub keyring_username: String,
    pub server_port_range: (u16, u16),
    pub app_name: String,
    pub expected_command_string: String,
    pub acknowledgment_string: String,
    pub nonce_timestamp_window_ms: u64,
    pub audio_sample_rate: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            backend_base_url: "http://localhost:8080".to_string(),
            keyring_service: "figma_plugin_companion_app".to_string(),
            keyring_username: "auth_credentials".to_string(),
            server_port_range: (3000, 4000),
            app_name: "figma_plugin_companion_app".to_string(),
            expected_command_string: "CMD".to_string(),
            acknowledgment_string: "ACK".to_string(),
            nonce_timestamp_window_ms: 300000, // 5-minute default (in milliseconds)
            audio_sample_rate: 16000, // 16kHz default
        }
    }
}

impl AppConfig {
    pub fn load() -> Result<Self, String> {
        let mut config = Self::default();
        
        // Load from environment variables
        if let Ok(url) = env::var("VITE_BACKEND_URL") {
            config.backend_base_url = url;
        }
        
        if let Ok(app_name) = env::var("APP_NAME") {
            config.app_name = app_name;
        }
        
        if let Ok(keyring_service) = env::var("KEYRING_SERVICE") {
            config.keyring_service = keyring_service;
        }
        
        if let Ok(keyring_username) = env::var("KEYRING_USERNAME") {
            config.keyring_username = keyring_username;
        }
        
        if let Ok(expected_command) = env::var("EXPECTED_COMMAND_STRING") {
            config.expected_command_string = expected_command;
        }
        
        if let Ok(ack_string) = env::var("ACKNOWLEDGMENT_STRING") {
            config.acknowledgment_string = ack_string;
        }
        
        if let Ok(window_str) = env::var("NONCE_TIMESTAMP_WINDOW_MS") {
            if let Ok(window) = window_str.parse::<u64>() {
                config.nonce_timestamp_window_ms = window;
            }
        }
        
        if let Ok(sample_rate_str) = env::var("AUDIO_SAMPLE_RATE") {
            if let Ok(sample_rate) = sample_rate_str.parse::<u32>() {
                config.audio_sample_rate = sample_rate;
            }
        }
        
        // Try to load from a config file if it exists
        if let Ok(config_str) = std::fs::read_to_string("config.json") {
            match serde_json::from_str::<AppConfig>(&config_str) {
                Ok(file_config) => {
                    // Merge file config with environment variables (env vars take precedence)
                    if env::var("BACKEND_URL").is_err() {
                        config.backend_base_url = file_config.backend_base_url;
                    }
                    if env::var("APP_NAME").is_err() {
                        config.app_name = file_config.app_name;
                    }
                    if env::var("KEYRING_SERVICE").is_err() {
                        config.keyring_service = file_config.keyring_service;
                    }
                    if env::var("KEYRING_USERNAME").is_err() {
                        config.keyring_username = file_config.keyring_username;
                    }
                    if env::var("EXPECTED_COMMAND_STRING").is_err() {
                        config.expected_command_string = file_config.expected_command_string;
                    }
                    if env::var("ACKNOWLEDGMENT_STRING").is_err() {
                        config.acknowledgment_string = file_config.acknowledgment_string;
                    }
                    if env::var("NONCE_TIMESTAMP_WINDOW_MS").is_err() {
                        config.nonce_timestamp_window_ms = file_config.nonce_timestamp_window_ms;
                    }
                    if env::var("AUDIO_SAMPLE_RATE").is_err() {
                        config.audio_sample_rate = file_config.audio_sample_rate;
                    }
                    config.server_port_range = file_config.server_port_range;
                }
                Err(e) => {
                    tracing::warn!("Failed to parse config.json: {}. Using defaults.", e);
                }
            }
        }
        
        Ok(config)
    }
}
