pub mod auth_commands;
pub mod server_commands;
pub mod api_commands;

// Re-export commands for easy access
pub use auth_commands::{delete_credentials, get_credentials, logout, set_credentials, is_authenticated};
pub use server_commands::{start_server, stop_server};
pub use api_commands::{login_with_auth0, login_with_figma, login_with_github, fetch_user_config, update_user_config};
