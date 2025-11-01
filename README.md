# Figma Plugin Companion App

A Tauri desktop application that serves as a companion app for Figma plugins, providing secure communication between Figma plugins and external backend services through a local HTTP and WebSocket server.

## Architecture

The application follows a clean separation of concerns:

- **Frontend (React/TypeScript)**: UI layer that displays state and captures user interactions
- **Backend (Rust/Tauri)**: Handles all business logic, API communication, and system integration
- **Communication**: Frontend triggers backend actions via Tauri commands; backend returns results

### API Communication Pattern

All HTTP/API calls to external services are handled exclusively by the Rust backend. The frontend uses Tauri commands to trigger backend operations:

```typescript
// Frontend example - Login with Figma
const result = await invoke<LoginAuthData>('login_with_figma');

// Frontend example - Fetch user configuration
const config = await invoke<UserConfig>('fetch_user_config');
```

The backend manages:
- Authentication flows (OAuth, token refresh)
- HTTP requests to external APIs
- Credential storage via OS keyring
- Response parsing and error handling

## Features

- **Secure Communication**: AES-GCM encryption with nonce validation
- **HTTP/SSE Endpoints**: Traditional REST API with Server-Sent Events for audio streaming
- **WebSocket Support**: Real-time bidirectional communication with enhanced security
- **Audio Recording**: Real-time audio capture and streaming
- **Authentication**: OAuth flows (Figma, GitHub) with credential management and OS keyring integration
- **System Tray**: Background operation with tray menu
- **Structured Logging**: Production-ready logging with the `tracing` crate

## Logging

The application uses structured logging via the `tracing` crate. You can control log verbosity using the `RUST_LOG` environment variable:

```bash
# Set log level to debug for development
RUST_LOG=debug pnpm tauri dev

# Set log level to info for production
RUST_LOG=info pnpm tauri build

# Set module-specific log levels
RUST_LOG=figma_plugin_companion_app::auth=debug,info pnpm tauri dev
```

For detailed logging configuration and best practices, see [LOGGING.md](docs/LOGGING.md).

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
