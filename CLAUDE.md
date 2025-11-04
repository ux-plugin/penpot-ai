# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Frontend (React + TypeScript + Vite)
- `pnpm dev` - Start development server (runs on localhost:1420)
- `pnpm build` - Build frontend for production
- `pnpm start` - Start Vite development server
- `pnpm serve` - Preview production build

### Tauri (Rust Backend)
- `pnpm tauri dev` - Start Tauri development mode (builds Rust backend + starts frontend)
- `pnpm tauri build` - Build complete Tauri application
- `cargo build` (in src-tauri/) - Build only Rust backend
- `cargo run` (in src-tauri/) - Run Rust backend directly

### Package Management
- `pnpm install` - Install dependencies
- Uses pnpm as package manager (not npm/yarn)

## Architecture Overview

This is a **Tauri desktop application** that serves as a companion app for a Figma plugin. It bridges communication between Figma plugins and external backend services through a local HTTP server.

### Key Architecture Components

**Frontend (React/TypeScript)**
- React Router for navigation with authentication-based route protection
- Zustand stores for state management (authentication, user settings)
- Tailwind CSS with Radix UI components for styling
- Path alias `@/*` maps to `./src/*`
- **NO DIRECT API CALLS** - All API communication through Tauri commands

**Backend (Rust/Tauri)**
- **Dependency Injection System**: `AppDependencies` with lazy initialization using `Arc<OnceLock<T>>`
- **Local HTTP Server**: Axum-based server with audio recording capabilities and SSE streaming
- **Backend Client**: HTTP client for external API communication with authentication
- **Authentication**: OAuth flows (Figma, GitHub) with credential management and OS keyring integration
- **Audio Manager**: Real-time audio capture and streaming via CPAL
- **System Tray**: Menu and tray functionality for background operation

### Core Modules (Rust)

- `dependencies.rs` - Centralized dependency injection container
- `local_server.rs` - Local HTTP server (handshake, audio recording endpoints)
- `backend_client.rs` - External API communication client with OAuth flows
- `auth.rs` - Authentication state and credential management
- `audio.rs` - Audio recording and streaming functionality
- `commands/` - Tauri commands (auth_commands, server_commands, api_commands)
- `window_utils.rs` - Window management utilities
- `config.rs` - Application configuration management

### Frontend Structure

- `App.tsx` - Main router with ProtectedRoute/PublicRoute wrappers
- `views/` - Main application views (Login, Home)
- `stores/` - Zustand state stores
- `providers/` - React context providers
- `components/ui/` - Reusable UI components (Radix-based)

### API Communication Pattern

**ALL API calls to external services are handled by the Rust backend.** The frontend NEVER makes direct HTTP requests to external APIs.

Frontend triggers backend operations via Tauri commands:
```typescript
// Login with Figma
const result = await invoke<LoginAuthData>('login_with_figma');

// Fetch user configuration
const config = await invoke<UserConfig>('fetch_user_config');

// Update user configuration
await invoke('update_user_config', { updateData });
```

The backend handles:
- Complete OAuth flows (initialize, poll, get tokens)
- Token refresh on 401 errors
- All HTTP communication with external APIs
- Response parsing and error handling

### Authentication Flow

1. User clicks login button in Login view
2. Frontend invokes `login_with_figma` or `login_with_github` Tauri command
3. Backend initializes OAuth flow and opens browser
4. Backend polls for access token
5. Backend retrieves refresh token
6. Backend returns LoginAuthData to frontend
7. Frontend updates Zustand store and stores credentials via Tauri commands
8. Credentials persisted in OS keyring by backend

### Local Server Architecture

The app runs a local HTTP server for plugin communication:
- **GET /init** - Handshake endpoint
- **GET /start-recording** - Start audio recording with SSE streaming
- **GET /stop-recording** - Stop audio recording

Server uses dependency injection pattern with `StateForLocalServerHandler` sharing audio command channels and backend client across handlers.

## Important Patterns

### Tauri Commands
All Rust functions exposed to frontend are in `commands/` modules and registered in `lib.rs` via `tauri::generate_handler![]`

### State Management
- **Frontend**: Zustand stores with TypeScript
- **Backend**: Arc-wrapped shared state with tokio async mutexes
- **Cross-language**: Tauri commands bridge React and Rust

### API Communication
- **ALL external API calls handled by Rust backend**
- Frontend triggers operations via Tauri commands: `invoke('command_name', params)`
- Backend handles OAuth flows, token refresh, HTTP requests
- Frontend never makes direct fetch/HTTP calls to external services

### Error Handling
- Rust functions return `Result<T, String>` for Tauri command compatibility
- Frontend catches errors from invoke() calls and displays to user

### Window Behavior
App hides to system tray on close instead of exiting (see `setup_window_behavior` in lib.rs)

## Environment Configuration

- Uses `.env` file for configuration (not committed)
- `AppConfig` loads environment variables in Rust
- Frontend connects to local server on localhost:1420
- memorise the name of repos that you have access to in ux-plugin
- always make the issues created in any ux-plugin related repo appear in ux-plugin project
- make all the issues created have a tag companion app