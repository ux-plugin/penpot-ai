# Architecture Overview

## Design Principle

The Figma Plugin Companion App follows a clean separation of concerns with all business logic and API communication centralized in the Rust backend. The TypeScript frontend acts purely as a presentation layer.

## Layers

### Frontend (React/TypeScript)

**Responsibilities:**
- Display UI and application state
- Capture user interactions (button clicks, form inputs)
- Trigger backend actions via Tauri commands
- Display results returned from backend

**What it does NOT do:**
- Direct HTTP/API calls to external services
- Business logic processing
- Data transformation or validation
- Authentication flows

**Example Usage:**
```typescript
// Login with Figma
const handleFigmaLogin = async () => {
    const result = await invoke<LoginAuthData>('login_with_figma');
    // Update UI state with result
    setAccessToken(result.access_token);
};

// Fetch user config
const config = await invoke<UserConfig>('fetch_user_config');
```

### Backend (Rust/Tauri)

**Responsibilities:**
- Handle all HTTP/API communication with external services
- Manage authentication flows (OAuth, token refresh)
- Store and retrieve credentials via OS keyring
- Parse and validate API responses
- Implement business logic
- Manage local server for plugin communication

**Key Modules:**

1. **`backend_client.rs`** - HTTP client for external API calls
   - `login_with_figma()` - Complete Figma OAuth flow
   - `login_with_github()` - Complete GitHub OAuth flow
   - `fetch_user_config()` - Get user configuration with 401 handling
   - `update_user_config()` - Update user configuration with 401 handling
   - Automatic token refresh on 401 errors

2. **`commands/api_commands.rs`** - Tauri commands exposed to frontend
   - `login_with_figma` - Login flow + browser opening
   - `login_with_github` - Login flow + browser opening
   - `fetch_user_config` - Get user info
   - `update_user_config` - Update user info

3. **`auth.rs`** - Authentication state management
   - Credential storage in OS keyring
   - Token management

4. **`local_server/`** - Local HTTP/WebSocket server
   - Audio recording
   - Plugin communication
   - Encryption handling

## Communication Flow

### Authentication Example

```
User clicks "Login with Figma"
    ↓
Frontend: invoke('login_with_figma')
    ↓
Backend: login_with_figma() command
    ↓
Backend: Initialize OAuth flow (HTTP GET /auth/figma/login)
    ↓
Backend: Open browser with login URL
    ↓
Backend: Poll for access token (HTTP GET /auth/figma/access-token)
    ↓
Backend: Get refresh token (HTTP GET /auth/plugin-ui/refresh-token)
    ↓
Backend: Return LoginAuthData to frontend
    ↓
Frontend: Update UI state and store credentials
```

### API Call with Token Refresh

```
Frontend: invoke('fetch_user_config')
    ↓
Backend: fetch_user_config() command
    ↓
Backend: HTTP GET /user/info with access token
    ↓
If 401: Refresh token automatically
    ↓
Backend: Retry request with new token
    ↓
Backend: Return UserConfig to frontend
    ↓
Frontend: Display user info
```

## Benefits of This Architecture

1. **Security**: Sensitive operations (API calls, credential storage) isolated in Rust
2. **Maintainability**: Clear separation makes code easier to understand and modify
3. **Performance**: Rust's performance for I/O and network operations
4. **Type Safety**: Strong typing in both Rust and TypeScript layers
5. **Testing**: Backend logic can be tested independently of UI
6. **Platform Features**: Direct access to OS keyring, system tray, etc. from Rust

## Available Tauri Commands

### Authentication
- `is_authenticated()` - Check if user is authenticated
- `get_credentials()` - Get stored credentials
- `set_credentials(credentials)` - Store credentials
- `delete_credentials()` - Clear credentials
- `logout()` - Complete logout flow

### API Operations
- `login_with_figma()` - Figma OAuth login
- `login_with_github()` - GitHub OAuth login
- `fetch_user_config()` - Get user configuration
- `update_user_config(data)` - Update user configuration

### Server Management
- `start_server()` - Start local server
- `stop_server()` - Stop local server

## Migration Notes

This architecture represents a migration from a previous design where the frontend made direct API calls. All API communication has been moved to the Rust backend to improve:

- Security (no exposed credentials in frontend)
- Separation of concerns
- Code maintainability
- Leverage Rust's performance and safety features

For historical reference, the following frontend modules were removed:
- `src/api/api-fetcher.ts` - Generic fetch wrapper with token refresh
- `src/api/auth/loginFigma.ts` - Figma login flow
- `src/api/auth/loginGithub.ts` - GitHub login flow
- `src/api/user/fetchUserConfig.ts` - User config fetching
- `src/api/user/updateUserConfig.ts` - User config updates

These have been replaced with Tauri commands that call the corresponding Rust backend methods.
