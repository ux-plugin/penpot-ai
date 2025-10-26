# WebSocket Infrastructure

This document describes the shared WebSocket infrastructure for the Figma Plugin API.

## Overview

The system provides a unified WebSocket endpoint at `/ws` that supports multiple feature domains through a facade pattern. This replaces the previous approach of having separate endpoints for different features.

## Architecture

### Components

1. **SharedWebSocketHandler** (`/ws`) - Main WebSocket endpoint
   - Manages WebSocket connections
   - Handles authentication via JWT query parameter
   - Routes messages to appropriate facades based on message type prefix
   - Provides lifecycle management (onOpen, onMessage, onClose, onError)

2. **WebSocketFacade** - Base interface for feature-specific handlers
   - Each facade handles messages for a specific namespace (e.g., `completions:`, `user:`)
   - Implements business logic for its domain
   - Receives lifecycle notifications

3. **Message Protocol** - JSON-based protocol with namespaced types
   ```json
   {
     "type": "completions:create" | "user:subscribe_ports" | "user:port_update",
     "payload": { /* feature-specific data */ },
     "requestId": "optional-correlation-id"
   }
   ```

4. **Facades**
   - **CompletionsFacade** - Handles completion streaming (`completions:*` messages)
   - **UserFacade** - Handles port subscriptions and updates (`user:*` messages)

### Message Flow

```
Client → /ws?token=<jwt> (WebSocket connection)
  ↓
SharedWebSocketHandler (authentication & routing)
  ↓
Message type routing by prefix
  ↓
├─→ CompletionsFacade (completions:*)
│     └─→ CommandDispatcher → existing handlers
└─→ UserFacade (user:*)
      └─→ Redis Pub/Sub → Port Updates
```

## Authentication

WebSocket connections are authenticated using JWT tokens passed as query parameters:

```
ws://localhost:8003/ws?token=<your-jwt-token>
```

The `QueryParamJwtAuthMechanism` extracts and validates the token. Both `/ws` and the legacy `/completions/create` endpoints are supported.

## Message Types

### Completions Namespace (`completions:*`)

The completions namespace supports the following message types:

- `completions:refresh_token` - Refresh authentication token
- `completions:request` - Send completion request
- `completions:request_end` - End completion request
- `completions:response` - Receive completion response
- `completions:response_end` - End completion response

These messages are converted to the legacy command format internally for backwards compatibility.

### User Namespace (`user:*`)

The user namespace supports the following message types:

#### Subscribe to Port Updates

Client sends:
```json
{
  "type": "user:subscribe_ports",
  "payload": {},
  "requestId": "req-123"
}
```

Server responds with current port state:
```json
{
  "type": "user:port_update",
  "payload": {
    "port": 3000
  },
  "requestId": "req-123"
}
```

Future port updates are pushed automatically:
```json
{
  "type": "user:port_update",
  "payload": {
    "port": 3001
  }
}
```

#### Unsubscribe from Port Updates

Client sends:
```json
{
  "type": "user:unsubscribe_ports",
  "payload": {},
  "requestId": "req-124"
}
```

Server responds:
```json
{
  "type": "user:unsubscribe_ports",
  "payload": {
    "status": "unsubscribed"
  },
  "requestId": "req-124"
}
```

## Error Handling

Errors are returned in a standardized format:

```json
{
  "type": "error",
  "payload": {},
  "requestId": "req-123",
  "error": "Error message description"
}
```

## Migration from SSE

The SSE endpoint `/user/port/listen` is now **deprecated** but remains available for backwards compatibility.

**Old approach (SSE):**
```
GET /user/port/listen
Authorization: Bearer <token>
```

**New approach (WebSocket):**
```javascript
const ws = new WebSocket(`ws://localhost:8003/ws?token=${token}`);

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "user:subscribe_ports",
    payload: {},
    requestId: "req-1"
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "user:port_update") {
    console.log("Port updated:", message.payload.port);
  }
};
```

## Adding New Features

To add a new feature to the WebSocket infrastructure:

1. Create a new facade implementing `WebSocketFacade`
2. Define message types in `WebSocketMessageType` with your namespace prefix
3. Register the facade in `WebSocketConfiguration.onStart()`
4. Handle messages in your facade's `handleMessage()` method

Example:

```kotlin
@ApplicationScoped
class MyFeatureFacade : WebSocketFacade {
    override fun getMessageTypePrefix(): String = "myfeature:"
    
    override suspend fun handleMessage(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse? {
        return when (message.type) {
            "myfeature:action" -> handleAction(message, session, userId)
            else -> null
        }
    }
}
```

## Configuration

The WebSocket endpoints are configured in `application.yaml`:

```yaml
websocket:
  auth:
    path: "/completions/create"  # Legacy endpoint (still supported)
    token-query-param: "token"
    upgrade-header: "upgrade"
    websocket-value: "websocket"
```

The new `/ws` endpoint is automatically supported without additional configuration.

## Testing

Unit tests are provided in `src/test/kotlin/com/plugin/infrastructure/websocket/`:

- `WebSocketInfrastructureTest` - Tests for protocol, facades, and message handling

Run tests:
```bash
./gradlew test --tests "com.plugin.infrastructure.websocket.*"
```

## Benefits

1. **Single connection per client** - More efficient than multiple SSE connections
2. **Unified protocol** - Consistent message format across features
3. **Better scalability** - WebSocket is more efficient than SSE
4. **Extensibility** - Easy to add new features via facades
5. **Type safety** - Namespaced message types prevent conflicts
6. **Backwards compatibility** - Legacy endpoints remain functional during migration
