# Port Updates WebSocket

This module provides WebSocket-based real-time port updates from the backend using the unified `/ws` endpoint.

## Overview

The port updates feature allows the frontend to receive real-time notifications when the companion app port changes. This uses a **shared singleton WebSocket connection** that is also used by other features like completions, ensuring efficient resource usage and consistent bidirectional communication.

## Architecture

### Shared WebSocket Instance
- **Pattern**: Singleton
- **URL**: `ws(s)://<backend>/ws`
- **Authentication**: JWT token passed as query parameter (`?token=<jwt>`)
- **Protocol**: JSON-based message protocol
- **Shared with**: Completions, and other future features

### Message Protocol

#### Subscription Message (Client → Server)
After connecting, the client sends a subscription message:
```json
{
  "event": "user:subscribe_ports"
}
```

#### Port Update Message (Server → Client)
The server sends port updates:
```json
{
  "event": "user:port_update",
  "data": {
    "port": 3000,
    "nonce": 12345
  }
}
```

## Components

### SharedWebSocketClient (Singleton)
A singleton WebSocket client that handles all WebSocket communication.

**Location**: `src/plugin-ui/shared/api/SharedWebSocketClient.ts`

**Features**:
- **Singleton pattern** - Only one WebSocket connection for all features
- Automatic reconnection with exponential backoff
- Event-based message routing
- JWT authentication
- Connection state management
- Multiple callback subscriptions (onOpen, onClose, onError)

**Usage**:
```typescript
import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';

// Get the shared instance
const wsClient = getSharedWebSocket();

// Subscribe to events
const unsubscribe = wsClient.on('user:port_update', (data) => {
  console.log('Port updated:', data.port);
});

// Register connection callbacks
const unsubOpen = wsClient.onOpen(() => {
  console.log('Connected');
});

// Connect (reuses existing connection if already connected)
await wsClient.connect();

// Send a message
wsClient.send({ event: 'user:subscribe_ports' });

// Clean up (only unsubscribe, don't close shared connection)
unsubscribe();
unsubOpen();
```

### portUpdatesWebSocket
Port-specific WebSocket connection wrapper that uses the shared singleton.

**Location**: `src/plugin-ui/features/user/api/portUpdatesWebSocket.ts`

**Usage**:
```typescript
import { createPortUpdatesConnection } from '@user/api/portUpdatesWebSocket';

const connection = createPortUpdatesConnection(
  // onPortUpdate
  (port) => {
    console.log('Port updated to:', port);
  },
  // onConnectionStatusChange
  (connected) => {
    console.log('Connection status:', connected);
  },
  // onError
  (error) => {
    console.error('Connection error:', error);
  }
);

// Later, unsubscribe (doesn't close shared connection)
connection.close();
```

### usePortUpdatesStore
Zustand store for managing port update state.

**Location**: `src/plugin-ui/features/user/stores/usePortUpdatesStore.ts`

**Features**:
- Connection management
- Port state tracking
- Error handling
- Connection status

**Usage**:
```typescript
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore';

function MyComponent() {
  const { currentPort, isConnected, error, connect, disconnect } = usePortUpdatesStore();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, []);

  return (
    <div>
      <p>Port: {currentPort}</p>
      <p>Connected: {isConnected ? 'Yes' : 'No'}</p>
      {error && <p>Error: {error}</p>}
    </div>
  );
}
```

## Connection Lifecycle

1. **Connection Initiation**: Client gets singleton WebSocket instance
2. **Authentication**: Server validates JWT token
3. **Subscription**: Client sends `user:subscribe_ports` message
4. **Port Updates**: Server sends `user:port_update` messages when port changes
5. **Disconnection**: Client unsubscribes from events (shared connection remains open for other features)

## Error Handling

The WebSocket client implements automatic reconnection with exponential backoff:
- Initial retry delay: 1 second
- Maximum retry delay: 30 seconds
- Backoff factor: 1.5x
- Maximum retry attempts: 10

## Shared Connection Benefits

### Resource Efficiency
- Only one WebSocket connection for all features
- Reduced memory and network overhead
- Single authentication and connection management

### Consistency
- All features use the same connection protocol
- Unified error handling and reconnection logic
- Consistent connection state across the application

### Features Sharing the Connection
- **Port Updates**: `user:subscribe_ports`, `user:port_update`
- **Completions**: `completion_request`, `completion_response`, `completion_acknowledgment`
- Future features can easily be added to the shared connection

## Migration from SSE

This implementation replaces the previous SSE-based port updates:

### Old Implementation (SSE)
- Endpoint: `/user/port/listen`
- Protocol: Server-Sent Events
- Files: `eventSource-fetcher.ts`, `sse-parser.ts`, `portUpdates.ts`
- Dependency: `@microsoft/fetch-event-source`
- Separate connections for each feature

### New Implementation (WebSocket)
- Endpoint: `/ws`
- Protocol: WebSocket with JSON messages
- Files: `SharedWebSocketClient.ts`, `portUpdatesWebSocket.ts`
- Dependency: Native WebSocket API (no external dependencies)
- **Shared singleton connection** for all features

### Benefits
- More efficient bidirectional communication
- Reduced overhead (no HTTP headers per message)
- Better connection management
- Unified WebSocket infrastructure
- No external dependencies
- **Single connection** shared across all features
