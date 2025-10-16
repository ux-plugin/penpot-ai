# Figma Plugin Companion App

A Tauri desktop application that serves as a companion app for Figma plugins, providing secure communication between Figma plugins and external backend services through a local HTTP and WebSocket server.

## Features

- **Secure Communication**: AES-GCM encryption with nonce validation
- **HTTP/SSE Endpoints**: Traditional REST API with Server-Sent Events for audio streaming
- **WebSocket Support**: Real-time bidirectional communication with enhanced security
- **Audio Recording**: Real-time audio capture and streaming
- **Authentication**: Credential management with OS keyring integration
- **System Tray**: Background operation with tray menu

## WebSocket Support

The app now supports WebSocket connections for enhanced security and real-time communication. WebSocket provides:

- ✅ Encrypted error codes (prevents MITM attacks)
- ✅ Real-time connection state monitoring
- ✅ Persistent authenticated connection
- ✅ Nonce validation for replay attack prevention

### WebSocket Endpoints

- `/ws` - General commands (init, health-check, stop-recording)
- `/ws/recording` - Audio recording with real-time streaming

For detailed WebSocket protocol documentation, see [WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md).

## HTTP/SSE Endpoints (Backward Compatible)

- `POST /init` - Initialize connection and handshake
- `POST /start-recording` - Start audio recording (SSE streaming)
- `POST /stop-recording` - Stop audio recording

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
