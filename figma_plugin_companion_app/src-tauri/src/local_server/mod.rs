pub mod audio;
pub mod audio_playback;
pub mod audio_stream;
pub mod encryption;
pub mod server;
pub mod state;
pub mod ws_handlers;

// Re-export the main LocalServer struct for external use
pub use server::LocalServer;
