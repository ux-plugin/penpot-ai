pub mod auth_commands;
pub mod server_commands;

// Re-export commands for easy access
pub use auth_commands::{delete_credentials, get_credentials, logout, set_credentials, is_authenticated};
pub use server_commands::{start_server, stop_server};
