# Port Updates WebSocket

This module provides WebSocket-based real-time port updates from the backend using the unified `/ws` endpoint.

## Overview

The port updates feature allows the frontend to receive real-time notifications when the companion app port changes. This replaces the previous Server-Sent Events (SSE) implementation with a WebSocket-based approach for more efficient bidirectional communication.

## Architecture

### WebSocket Endpoint
- **URL**: `ws(s)://<backend>/ws`
- **Authentication**: JWT token passed as query parameter (`?token=<jwt>`)
- **Protocol**: JSON-based message protocol

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

### SharedWebSocketClient
A reusable WebSocket client that can handle multiple event types.

**Location**: `src/plugin-ui/shared/api/SharedWebSocketClient.ts`

**Features**:
- Automatic reconnection with exponential backoff
- Event-based message routing
- JWT authentication
- Connection state management

### portUpdatesWebSocket
Port-specific WebSocket connection wrapper.

**Location**: `src/plugin-ui/features/user/api/portUpdatesWebSocket.ts`

**Usage**:
```typescript
import { createPortUpdatesConnection } from '@user/api/portUpdatesWebSocket.ts';

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

// Later, close the connection
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
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore.ts';

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

1. **Connection Initiation**: Client creates WebSocket connection to `/ws` with JWT token
2. **Authentication**: Server validates JWT token
3. **Subscription**: Client sends `user:subscribe_ports` message
4. **Port Updates**: Server sends `user:port_update` messages when port changes
5. **Disconnection**: Client closes connection when no longer needed

## Error Handling

The WebSocket client implements automatic reconnection with exponential backoff:
- Initial retry delay: 5 seconds
- Maximum retry delay: 30 seconds
- Backoff factor: 1.5x
- Maximum retry attempts: 5

## Migration from SSE

This implementation replaces the previous SSE-based port updates:

### Old Implementation (SSE)
- Endpoint: `/user/port/listen`
- Protocol: Server-Sent Events
- Files: `eventSource-fetcher.ts`, `sse-parser.ts`, `portUpdates.ts`
- Dependency: `@microsoft/fetch-event-source`

### New Implementation (WebSocket)
- Endpoint: `/ws`
- Protocol: WebSocket with JSON messages
- Files: `SharedWebSocketClient.ts`, `portUpdatesWebSocket.ts`
- Dependency: Native WebSocket API (no external dependencies)

### Benefits
- More efficient bidirectional communication
- Reduced overhead (no HTTP headers per message)
- Better connection management
- Unified WebSocket infrastructure
- No external dependencies
