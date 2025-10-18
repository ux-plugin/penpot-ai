# Issue: Transition from HTTP/SSE to WebSocket in UI

## Overview
Transition the Figma plugin UI from using HTTP with Server-Sent Events (SSE) to WebSocket for real-time bidirectional communication with the companion app's local server.

## Current Architecture
- **Connection Initiation**: UI receives port from backend via existing backend SSE
- **Handshake**: HTTP POST to `/init` endpoint
- **Recording Start**: HTTP POST to `/start-recording`, returns SSE stream with audio chunks
- **Recording Stop**: HTTP POST to `/stop-recording`
- **Message Format**: `base64<nonce(12)|payload_encrypted>`
- **Encryption**: AES-GCM with key from backend

## Target Architecture
- **Connection Initiation**: UI receives port from backend via existing backend SSE (unchanged)
- **WebSocket Lifecycle**: 
  - Connection established when port is received
  - Connection is persistent bidirectional stream
  - Both sides can close connection (triggers disconnect flow)
- **Message Types**: 4 distinct message types over single WS connection
- **Message Format**: Same `base64<nonce(12)|payload_encrypted>` format

## WebSocket Message Types

### 1. Handshake (UI → Companion, Companion → UI)
**Purpose**: Verify companion app has valid encryption key from backend

**UI sends**:
```json
{
  "type": "handshake",
  "encrypted_data": "base64<nonce(12)|encrypted_payload>"
}
```
Where encrypted_payload contains: `{data: "CMD", timestamp_ms: number}`

**Companion responds**:
```json
{
  "type": "handshake_response",
  "encrypted_data": "base64<nonce(12)|encrypted_payload>"
}
```
Where encrypted_payload contains: `{data: "ACK", timestamp_ms: number}`

### 2. Start Recording (UI → Companion, Companion → UI stream)
**UI sends**:
```json
{
  "type": "start_recording",
  "encrypted_data": "base64<nonce(12)|encrypted_payload>"
}
```

**Companion responds** with continuous stream:
```json
{
  "type": "audio_chunk",
  "encrypted_data": "base64<nonce(12)|encrypted_audio>"
}
```

Or on error:
```json
{
  "type": "error",
  "encrypted_data": "base64<nonce(12)|encrypted_error>"
}
```

### 3. Stop Recording (UI → Companion)
**UI sends**:
```json
{
  "type": "stop_recording",
  "encrypted_data": "base64<nonce(12)|encrypted_payload>"
}
```

**Companion responds**:
```json
{
  "type": "stop_response",
  "encrypted_data": "base64<nonce(12)|encrypted_payload>"
}
```

### 4. Key Rotate (UI → Companion)
**Purpose**: Update encryption key without closing connection

**UI sends**:
```json
{
  "type": "key_rotate",
  "encrypted_data": "base64<nonce(12)|new_key_encrypted_with_old_key>"
}
```

**Companion responds**:
```json
{
  "type": "key_rotate_response",
  "encrypted_data": "base64<nonce(12)|encrypted_acknowledgment>"
}
```

## Connection Lifecycle

### Connection Establishment
1. UI receives port from backend through existing backend SSE
2. UI establishes WebSocket connection to `ws://localhost:{port}/ws`
3. UI sends handshake message
4. Companion validates key and responds
5. Connection marked as ready

### Connection Closure
**If UI closes connection**:
- UI marks companion as disconnected
- Connection manager state → DISCONNECTED
- UI can reconnect when port is available

**If Companion closes connection**:
- Companion app must stop local server completely
- Server shutdown triggers port update (null) sent to backend
- This triggers new SSE event to UI (if connection is maintained)
- When companion restarts → new port → new SSE event → reconnection cycle

### Disconnect Flow
```
Connection Close (either side)
  ↓
UI: Mark as DISCONNECTED
  ↓
Companion: Stop server, close port
  ↓
Companion: Update backend (port = null)
  ↓
Backend: Emit port update via SSE
  ↓
UI: Receives port update (null)
  ↓
UI: Confirms disconnection
  ↓
--- Reconnection ---
Companion: Restart server (new port)
  ↓
Companion: Update backend (port = {new_port})
  ↓
Backend: Emit port update via SSE
  ↓
UI: Receives port, establishes new WS connection
```

## Implementation Tasks

### 1. Create WebSocket Client (`companionWebSocketClient.ts`)
- [ ] Implement WebSocket connection manager
- [ ] Handle connection lifecycle (open, close, error)
- [ ] Implement message type routing
- [ ] Handle automatic reconnection on disconnect
- [ ] Implement ping/pong for connection health
- [ ] Add connection state tracking (connecting, connected, disconnected)

### 2. Update Connection Manager (`ConnectionManager.ts`)
- [ ] Replace HTTP client calls with WebSocket client
- [ ] Update `performHandshake()` to use WS handshake message
- [ ] Implement WS connection establishment on port update
- [ ] Handle WS close event → mark as disconnected
- [ ] Remove SSE-specific logic for recording stream
- [ ] Update `startRecording()` to send WS message instead of HTTP
- [ ] Update `stopRecording()` to send WS message instead of HTTP
- [ ] Add key rotation method

### 3. Update Companion Store (`useCompanionStore.ts`)
- [ ] Add WS connection state properties
- [ ] Add WS instance reference
- [ ] Update connection state management for WS
- [ ] Add cleanup for WS on unmount

### 4. Update Encryption Module (`encryption.ts`)
- [ ] Add message type wrapper for WS messages
- [ ] Add key rotation encryption logic
- [ ] Update message format to include type field

### 5. Remove Old SSE Code
- [ ] Remove `companionSSE-fetcher.ts` (SSE implementation)
- [ ] Remove SSE-specific code from `companionAppClient.ts`
- [ ] Update imports across the codebase
- [ ] Clean up unused SSE utilities

### 6. Update UI Components
- [ ] Update recording controls to use new WS messages
- [ ] Update connection status indicators
- [ ] Add reconnection UI feedback
- [ ] Handle key rotation in UI

### 7. Error Handling
- [ ] Handle WS connection errors
- [ ] Handle message parsing errors
- [ ] Handle encryption/decryption errors
- [ ] Handle unexpected disconnections
- [ ] Implement retry logic with exponential backoff

### 8. Testing
- [ ] Test handshake flow
- [ ] Test start/stop recording over WS
- [ ] Test connection close from both sides
- [ ] Test key rotation
- [ ] Test reconnection after disconnect
- [ ] Test error scenarios
- [ ] Test concurrent operations

## File Changes Required

### New Files
- `src/plugin-ui/features/companion/api/companionWebSocketClient.ts`
- `src/plugin-ui/features/companion/api/websocketMessageTypes.ts`

### Modified Files
- `src/plugin-ui/features/companion/api/ConnectionManager.ts`
- `src/plugin-ui/features/companion/api/companionAppClient.ts`
- `src/plugin-ui/features/companion/api/encryption.ts`
- `src/plugin-ui/features/companion/stores/useCompanionStore.ts`

### Removed Files
- `src/plugin-ui/features/companion/api/companionSSE-fetcher.ts`

## Dependencies
- No new external dependencies required (WebSocket is native)
- Maintain existing encryption dependencies

## Notes
- **Encryption format remains unchanged**: `base64<nonce(12)|payload_encrypted>`
- **Backend SSE for port updates remains unchanged**
- **Key management through backend API remains unchanged**
- Only local server communication (UI ↔ Companion) uses WebSocket
- WebSocket provides better real-time communication and reduces complexity

## References
- Current implementation: `src/plugin-ui/features/companion/api/ConnectionManager.ts`
- SSE implementation: `src/plugin-ui/features/companion/api/companionSSE-fetcher.ts`
- Encryption: `src/plugin-ui/features/companion/api/encryption.ts`
