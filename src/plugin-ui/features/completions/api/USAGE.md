# WebSocket Audio Streaming Usage

This document explains how to use the `useCompletionsWebSocket` hook to stream audio from the companion app to the backend WebSocket endpoint.

**Note**: The WebSocket URL is automatically constructed from the `VITE_BACKEND_URL` environment variable.

## Overview

The `useCompletionsWebSocket` hook provides a unified interface for:
1. Starting audio recording from the companion app
2. Opening a WebSocket connection to the backend
3. Streaming audio chunks in real-time
4. Stopping recording and closing the WebSocket connection

## Prerequisites

- User must be authenticated (JWT token available)
- Companion app must be connected
- Backend WebSocket server must be running at `ws://localhost:8080/completions/create`

## Basic Usage

```typescript
import { useCompletionsWebSocket } from '@companion/api';

function MyComponent() {
  const {
    startRecordingAndStreaming,
    stopRecordingAndStreaming,
    isRecording,
    isWebSocketConnected,
    recordingError,
    webSocketError,
    isReady
  } = useCompletionsWebSocket();

  const handleToggle = async () => {
    if (isRecording) {
      // Stop recording and close WebSocket
      stopRecordingAndStreaming();
    } else {
      // Start recording and open WebSocket
      try {
        await startRecordingAndStreaming();
      } catch (error) {
        console.error('Failed to start:', error);
      }
    }
  };

  return (
    <div>
      <button 
        onClick={handleToggle}
        disabled={!isReady}
      >
        {isRecording ? 'Stop Recording' : 'Start Recording'}
      </button>
      
      <div>
        Status: {isRecording ? 'Recording...' : 'Idle'}
      </div>
      
      <div>
        WebSocket: {isWebSocketConnected ? 'Connected' : 'Disconnected'}
      </div>
      
      {recordingError && <div>Recording Error: {recordingError.message}</div>}
      {webSocketError && <div>WebSocket Error: {webSocketError.message}</div>}
    </div>
  );
}
```

## Advanced Usage with Callbacks

```typescript
import { useCompletionsWebSocket } from '@companion/api';

function AdvancedComponent() {
  const completions = useCompletionsWebSocket({
    // Optional: Override default WebSocket URL
    wsUrl: 'ws://custom-host:8080/completions/create',
    
    // Optional: Handle WebSocket open event
    onWebSocketOpen: () => {
      console.log('WebSocket connection established');
      // Show notification to user
    },
    
    // Optional: Handle WebSocket close event
    onWebSocketClose: () => {
      console.log('WebSocket connection closed');
      // Update UI state
    },
    
    // Optional: Handle WebSocket errors
    onWebSocketError: (event) => {
      console.error('WebSocket error:', event);
      // Show error to user
    },
    
    // Optional: Handle acknowledgment messages from server
    onAcknowledgment: (message) => {
      console.log('Server acknowledged:', message); // Should be "OK"
    }
  });

  // ... rest of component
}
```

## How It Works

### 1. Starting Recording and Streaming

When you call `startRecordingAndStreaming()`:

1. **Validation**: Checks if user is authenticated and companion app is connected
2. **WebSocket Connection**: Opens WebSocket to backend with JWT token
3. **Audio Recording**: Starts recording audio from companion app
4. **Audio Streaming**: Forwards each audio chunk to the WebSocket in real-time

### 2. Audio Chunk Format

Each audio chunk is sent to the WebSocket as a JSON message:

```json
{
  "timestamp": 1734041923456,
  "drawnPath": "",
  "audioChunk": "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="
}
```

- `timestamp`: Current time in milliseconds
- `drawnPath`: Empty string (not needed for audio-only streaming)
- `audioChunk`: Base64-encoded audio data

### 3. Server Acknowledgments

The backend responds with "OK" for each successfully received chunk.

### 4. Stopping Recording and Streaming

When you call `stopRecordingAndStreaming()`:

1. **Stop Recording**: Stops audio recording from companion app
2. **Close WebSocket**: Closes WebSocket connection (triggers backend to save audio as WAV file)
3. **Cleanup**: Releases all resources

## Error Handling

The hook provides two separate error states:

- `recordingError`: Errors from the companion app audio recording
- `webSocketError`: Errors from the WebSocket connection

Both are reset when starting a new recording session.

## Connection Readiness

The `isReady` property indicates if all prerequisites are met:
- User is authenticated (has JWT token)
- Companion app is connected

Always check `isReady` before allowing the user to start recording.

## Lifecycle Management

The hook automatically:
- Synchronizes recording and WebSocket states
- Cleans up resources on component unmount
- Handles reconnection attempts (up to 3 times with exponential backoff)
- Closes WebSocket if recording fails

## Backend Integration

According to the AsyncAPI specification, when the WebSocket closes:
- Backend saves the accumulated audio as a WAV file
- File format: 16kHz, mono, 16-bit PCM
- File naming: `audio_{timestamp}_{sessionId}.wav`

## Troubleshooting

### "Not authenticated" Error
- Ensure user is logged in
- Check that JWT token is available in auth store

### "Companion app not connected" Error
- Connect to companion app first using `useCompanionConnection` hook

### WebSocket Connection Fails
- Verify backend server is running at the correct URL
- Check JWT token is valid and not expired
- Ensure CORS is configured correctly on backend

### Audio Chunks Not Sending
- Check WebSocket is connected (`isWebSocketConnected === true`)
- Verify companion app is sending audio chunks
- Check browser console for errors
