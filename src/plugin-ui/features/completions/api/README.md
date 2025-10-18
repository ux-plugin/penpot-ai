# WebSocket Audio Streaming Implementation

This implementation provides a complete solution for streaming audio chunks from the companion app to the backend WebSocket endpoint. The endpoint URL is automatically constructed from the `VITE_BACKEND_URL` environment variable.

## 📁 Files Created

### 1. `CompletionsWebSocketManager.ts`
**Purpose**: Core WebSocket connection manager

**Features**:
- Establishes WebSocket connection with JWT authentication
- Sends audio chunks in the correct JSON format
- Handles connection lifecycle (open, close, error)
- Automatic reconnection with exponential backoff (up to 3 attempts)
- Proper cleanup and resource management

**Key Methods**:
- `connect()`: Opens WebSocket with JWT token
- `sendAudioChunk(base64Audio)`: Sends audio chunk to backend
- `close()`: Closes WebSocket connection
- `isConnected()`: Checks connection status

### 2. `useCompletionsWebSocket.ts`
**Purpose**: React hook for unified audio recording and WebSocket streaming

**Features**:
- Synchronizes audio recording lifecycle with WebSocket connection
- Automatically forwards audio chunks to WebSocket
- Provides simple start/stop interface
- Comprehensive error handling
- Automatic cleanup on unmount

**Key Methods**:
- `startRecordingAndStreaming()`: Starts both recording and WebSocket
- `stopRecordingAndStreaming()`: Stops both recording and WebSocket

**State Exposed**:
- `isRecording`: Whether audio is being recorded
- `isWebSocketConnected`: Whether WebSocket is connected
- `recordingError`: Any error from audio recording
- `webSocketError`: Any error from WebSocket
- `isReady`: Whether prerequisites are met (authenticated + companion connected)

### 3. `AudioStreamingDemo.tsx`
**Purpose**: Example component demonstrating usage

**Features**:
- Visual status indicators
- Real-time acknowledgement counter
- Error display
- Comprehensive usage guide
- Ready-to-use button controls

### 4. `WEBSOCKET_USAGE.md`
**Purpose**: Complete usage documentation

**Includes**:
- Basic usage examples
- Advanced usage with callbacks
- How it works explanations
- Error handling guide
- Troubleshooting section

## 🚀 Quick Start

```typescript
import { useCompletionsWebSocket } from '@companion/api';

function MyComponent() {
  const {
    startRecordingAndStreaming,
    stopRecordingAndStreaming,
    isRecording,
    isReady
  } = useCompletionsWebSocket();

  return (
    <button 
      onClick={isRecording ? stopRecordingAndStreaming : startRecordingAndStreaming}
      disabled={!isReady}
    >
      {isRecording ? 'Stop' : 'Start'}
    </button>
  );
}
```

## 🔄 Flow Diagram

```
User clicks "Start"
    ↓
Validate prerequisites (auth + companion)
    ↓
Connect WebSocket (with JWT token)
    ↓
Start audio recording
    ↓
Audio chunks received from companion app
    ↓
Forward chunks to WebSocket in JSON format
    {
      "timestamp": 1734041923456,
      "drawnPath": "",
      "audioChunk": "base64_audio_data"
    }
    ↓
Backend acknowledges with "OK"
    ↓
User clicks "Stop"
    ↓
Stop audio recording
    ↓
Close WebSocket
    ↓
Backend saves audio as WAV file
```

## 🔐 Authentication

The WebSocket uses JWT authentication:
- JWT token is retrieved from `useAuthenticationStore`
- Token is passed as a query parameter in the WebSocket URL: `?token=YOUR_JWT_TOKEN`
- This is necessary because browsers don't support custom headers for WebSocket connections
- Backend validates the JWT and extracts user ID from the subject claim

## 📦 Message Format

### Client → Server (Audio Chunk)

```json
{
  "timestamp": 1734041923456,
  "drawnPath": "",
  "audioChunk": "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="
}
```

- `timestamp`: Unix timestamp in milliseconds
- `drawnPath`: Empty string (not needed for audio-only)
- `audioChunk`: Base64-encoded audio data

### Server → Client (Acknowledgment)

```
"OK"
```

Simple text acknowledgment for each successful chunk.

## 🛠️ Error Handling

The implementation handles multiple error scenarios:

1. **Authentication Errors**: User not logged in
2. **Connection Errors**: Companion app not connected
3. **WebSocket Errors**: Backend not available, connection drops
4. **Recording Errors**: Audio recording fails

Each error type is properly caught, logged, and exposed to the UI.

## 🔄 Reconnection Logic

WebSocket automatically attempts to reconnect:
- Maximum 3 retry attempts
- Exponential backoff: 1s, 2s, 4s
- Manual close prevents reconnection
- Reconnection resets on successful connection

## 🧹 Cleanup

The implementation ensures proper cleanup:
- WebSocket closes when component unmounts
- Recording stops when WebSocket fails
- All resources are released properly
- No memory leaks

## 📝 Backend Integration

According to the AsyncAPI specification:

**On Connection Close**:
- Backend saves accumulated audio as WAV file
- Format: 16kHz, mono, 16-bit PCM
- Naming: `audio_{timestamp}_{sessionId}.wav`
- Session mappings and buffers are cleaned up

## ✅ Prerequisites

Before using this feature:
1. User must be authenticated (JWT token available)
2. Companion app must be connected
3. Backend WebSocket server must be running at `ws://localhost:8080/completions/create`

Check `isReady` property to verify all prerequisites are met.

## 🎯 Use Cases

This implementation is designed for:
- Real-time audio streaming to backend AI services
- Voice-based component creation in Figma
- Continuous audio capture with immediate processing
- Streaming large audio sessions without memory constraints

## 🔧 Customization

You can customize:
- WebSocket URL via `wsUrl` option
- Callbacks for open, close, error, acknowledgment events
- Reconnection behavior (modify `CompletionsWebSocketManager`)
- Message format (modify `sendAudioChunk` method)

## 📚 Additional Resources

- See `WEBSOCKET_USAGE.md` for detailed usage guide
- See `AudioStreamingDemo.tsx` for complete example
- Check AsyncAPI specification for backend contract
- Review `useAudioRecording` hook for companion app integration
