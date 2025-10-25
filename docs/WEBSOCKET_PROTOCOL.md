# WebSocket Protocol Documentation

## Overview

The Figma Plugin Companion App now supports WebSocket communication for secure, real-time interaction with Figma plugins. WebSocket provides enhanced security by encrypting all messages (including error codes) inside WebSocket frames, preventing man-in-the-middle attacks and providing real-time connection state monitoring.

## Endpoints

### `/ws` - General Command WebSocket
Used for general commands: initialization, health checks, and stopping recordings.

### `/ws/recording` - Audio Recording WebSocket  
Dedicated endpoint for audio recording with real-time streaming.

## Message Format

All messages exchanged via WebSocket use the following base64-encoded format:

```
base64<nonce(12)|encrypted_payload>
```

Where:
- `nonce(12)`: 12-byte unique nonce for encryption
- `encrypted_payload`: AES-GCM encrypted payload containing the actual message

The decrypted payload contains a JSON structure:
```json
{
  "data": "<command or message>",
  "timestamp_ms": 1234567890123
}
```

## Commands

Commands are sent as JSON objects within the encrypted payload's `data` field:

### 1. Init Command
Initialize the WebSocket connection and establish encryption key.

**Request:**
```json
{
  "command": "init"
}
```

**Response:**
```json
{
  "type": "init",
  "encrypted_data": "<base64 encrypted acknowledgment>"
}
```

### 2. Health Check Command
Verify the connection is alive and authenticated.

**Request:**
```json
{
  "command": "health-check"
}
```

**Response:**
```json
{
  "type": "health-check",
  "encrypted_data": "<base64 encrypted acknowledgment>"
}
```

### 3. Stop Recording Command
Stop an active audio recording (via `/ws` endpoint).

**Request:**
```json
{
  "command": "stop-recording"
}
```

**Response:**
```json
{
  "type": "recording-stopped"
}
```

### 4. Start Recording (via `/ws/recording`)
Start audio recording with real-time streaming.

**Initial Request:**
```json
{
  "command": "start-recording"
}
```

**Streaming Responses:**
```json
{
  "type": "audio-chunk",
  "data": "<base64 encoded audio data>"
}
```

**Stop Request:**
```json
{
  "command": "stop-recording"
}
```

**Final Response:**
```json
{
  "type": "recording-stopped"
}
```

## Error Handling

All errors are returned as encrypted JSON messages within the WebSocket stream:

```json
{
  "type": "error",
  "code": 401,
  "message": "Unauthorized"
}
```

### Error Codes
- `400` - Bad Request (invalid message format)
- `401` - Unauthorized (no valid encryption key)
- `403` - Forbidden (decryption failed, invalid nonce/timestamp)
- `500` - Internal Server Error

Note: Unlike HTTP, error codes are **not** exposed as plaintext status codes. They are encrypted within the WebSocket message, preventing malicious servers from forging error responses.

## Security Features

### 1. Encrypted Error Codes
All error codes are encrypted inside WebSocket frames, preventing MITM attacks where a malicious localhost server could forge HTTP status codes.

### 2. Nonce Validation
Each message includes a unique 12-byte nonce that:
- Must not be reused within the timestamp window
- Is tracked in-memory to prevent replay attacks
- Is automatically cleaned up after expiration

### 3. Timestamp Validation
Messages include a timestamp that must be within a configurable window (default: configurable via `AppConfig.nonce_timestamp_window_ms`). This prevents replay attacks with old messages.

### 4. Persistent Connection
WebSocket maintains a persistent authenticated connection, making it harder to hijack compared to stateless HTTP requests.

### 5. Real-time Connection State
Clients can monitor connection state via WebSocket `onclose` and `onerror` events for immediate detection of disconnections.

## Example Client Code

### JavaScript/TypeScript WebSocket Client

```typescript
// Connect to WebSocket
const ws = new WebSocket('ws://localhost:<port>/ws');

// Helper function to create encrypted message
async function createEncryptedMessage(command: string, key: string): Promise<string> {
  // 1. Generate unique nonce (12 bytes)
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  
  // 2. Create payload with timestamp
  const payload = {
    data: JSON.stringify({ command }),
    timestamp_ms: Date.now()
  };
  
  // 3. Encrypt payload with AES-GCM
  const encryptedPayload = await encryptAesGcm(
    JSON.stringify(payload),
    key,
    nonce
  );
  
  // 4. Concatenate nonce + encrypted payload
  const message = new Uint8Array(12 + encryptedPayload.length);
  message.set(nonce, 0);
  message.set(encryptedPayload, 12);
  
  // 5. Return as base64
  return btoa(String.fromCharCode(...message));
}

// Initialize connection
ws.onopen = async () => {
  const encryptedInit = await createEncryptedMessage('init', encryptionKey);
  ws.send(encryptedInit);
};

// Handle responses
ws.onmessage = async (event) => {
  const response = JSON.parse(event.data);
  
  if (response.type === 'init') {
    console.log('Connection initialized');
    // Decrypt acknowledgment if needed
  } else if (response.type === 'error') {
    console.error(`Error ${response.code}: ${response.message}`);
  }
};

// Handle connection close
ws.onclose = () => {
  console.log('WebSocket connection closed');
};

// Handle errors
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};
```

### Audio Recording Example

```typescript
// Connect to recording WebSocket
const wsRecording = new WebSocket('ws://localhost:<port>/ws/recording');

wsRecording.onopen = async () => {
  // Send start-recording command
  const encryptedStart = await createEncryptedMessage('start-recording', encryptionKey);
  wsRecording.send(encryptedStart);
};

wsRecording.onmessage = async (event) => {
  const response = JSON.parse(event.data);
  
  if (response.type === 'audio-chunk') {
    // Process base64 audio data
    const audioData = atob(response.data);
    processAudioChunk(audioData);
  } else if (response.type === 'recording-stopped') {
    console.log('Recording stopped');
  } else if (response.type === 'error') {
    console.error(`Error: ${response.message}`);
  }
};

// Stop recording
async function stopRecording() {
  const encryptedStop = await createEncryptedMessage('stop-recording', encryptionKey);
  wsRecording.send(encryptedStop);
}
```

## Backward Compatibility

The HTTP/SSE endpoints are maintained for backward compatibility:
- `POST /init` - HTTP handshake
- `POST /start-recording` - SSE audio streaming
- `POST /stop-recording` - Stop recording

Existing clients will continue to work without modifications. New clients should migrate to WebSocket for enhanced security.

## Migration Path

### Phase 1: WebSocket Available ✅
- WebSocket endpoints available alongside HTTP
- Clients can start testing WebSocket integration
- HTTP endpoints remain fully functional

### Phase 2: Encourage Migration
- Update client libraries to prefer WebSocket
- Provide migration guides and examples
- Monitor WebSocket adoption metrics

### Phase 3: Deprecation (Future)
- Announce HTTP endpoint deprecation timeline
- Provide grace period for migration
- Eventually remove HTTP endpoints

## Testing

To test the WebSocket implementation:

1. Start the companion app
2. Open `docs/websocket-test-client.html` in a web browser
3. Enter the port number (displayed when the companion app starts)
4. Enter your encryption key (base64 encoded)
5. Click "Connect to /ws" to establish connection
6. Send encrypted init command
7. Verify encrypted response
8. Test health check, recording, and error scenarios
9. Verify connection state monitoring

### Using the Test Client

The included HTML test client (`docs/websocket-test-client.html`) provides a simple UI to:
- Connect to both `/ws` and `/ws/recording` endpoints
- Send encrypted commands with proper nonce and timestamp
- View real-time logs of all WebSocket activity
- Test audio recording with chunk counting
- Visualize connection state changes

Simply open the HTML file in any modern web browser (Chrome, Firefox, Safari, Edge) to start testing.

## Troubleshooting

### Connection Refused
- Ensure the companion app is running
- Verify the correct port number
- Check firewall settings

### Authentication Errors (401/403)
- Verify encryption key is correct
- Check nonce generation is working
- Ensure timestamp is within acceptable window

### Message Format Errors (400)
- Verify base64 encoding is correct
- Check nonce length is exactly 12 bytes
- Validate JSON structure of payload

### Audio Streaming Issues
- Use dedicated `/ws/recording` endpoint
- Ensure proper command sequencing
- Handle audio chunks in order
