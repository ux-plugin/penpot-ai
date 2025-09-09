pub mod auth_commands;
pub mod server_commands;

pub(crate) use crate::auth::{AuthCredentials, AuthState};

// Re-export commands for easy access
pub use auth_commands::{delete_credentials, get_credentials, logout, set_credentials};
pub use server_commands::{start_server, stop_server};
pub use crate::window_utils::show_or_create_main_window;
