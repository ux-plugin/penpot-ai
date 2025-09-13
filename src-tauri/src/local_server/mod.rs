pub mod audio;
pub mod encryption;
pub mod handlers;
pub mod server;
pub mod state;

// Re-export the main LocalServer struct for external use
pub use server::LocalServer;

// Re-export audio types that might be needed by external code
pub use audio::{AudioCommand, AudioManager};