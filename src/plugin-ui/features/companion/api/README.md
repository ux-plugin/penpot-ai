# Companion App Connection Architecture

## Overview

The companion app connection system has been refactored to use a **ConnectionManager** pattern that centralizes all connection logic and provides intelligent error handling with automatic reconnection on port updates.

## Architecture

### ConnectionManager (Central Orchestrator)

The `ConnectionManager` class is the **single entry point** for all companion app connectivity operations. It manages the connection lifecycle through a state machine and coordinates between multiple components.

**Connection State Machine:**
```
disconnected → key_ready → connected
     ↑            ↑            ↓
     └────────────┴────────────┘
```

**Key Features:**
- Centralized connection state management
- Automatic key generation on port updates (companion restart)
- Intelligent error classification (404, network, timeout, etc.)
- No automatic retries on 404/network errors (waits for user action or port update)
- Wraps all API calls with connection validation and error handling

### Component Responsibilities

#### ConnectionManager
- **Role:** Central orchestrator and single public API
- **Responsibilities:**
  - Manages connection lifecycle and state transitions
  - Coordinates encryption key generation and handshake
  - Handles port updates with automatic reconnection
  - Provides intelligent error handling
  - Wraps API calls with connection validation

#### CompanionAppClient
- **Role:** HTTP operations implementation
- **Responsibilities:**
  - Low-level HTTP requests with encryption
  - Handshake protocol implementation
  - Streaming support
  - **Should only be called by ConnectionManager**

#### React Hooks
- **Role:** React adapter layer
- **Responsibilities:**
  - Bridge between React components and ConnectionManager
  - Provide React-friendly state management
  - Handle React-specific concerns (loading states, cache invalidation)

## Usage

### Connecting to Companion App

```typescript
import { connectionManager } from '@companion/api';

// Connect (generates key if needed + performs handshake)
await connectionManager.connect();

// Disconnect
connectionManager.disconnect();

// Check connection status
const isConnected = connectionManager.isConnected();
```

### Using React Hooks

```typescript
import { useCompanionConnection, useCompanionStatus } from '@companion/api';

function MyComponent() {
  const { connect, disconnect, isConnected, error } = useCompanionConnection();
  const status = useCompanionStatus();
  
  return (
    <button onClick={connect} disabled={!status.canConnect}>
      Connect
    </button>
  );
}
```

### Making API Calls

```typescript
import { useCompanionQuery } from '@companion/api';

function MyComponent() {
  // Query is automatically wrapped with connection validation
  const { data, error } = useCompanionQuery({
    endpoint: '/api/data',
    enabled: true
  });
  
  return <div>{data}</div>;
}
```

## Connection Lifecycle Events

### User Initiates Connection
```
User clicks "Connect"
  → connectionManager.connect()
  → Ensure valid key (generate if needed)
  → State: key_ready
  → Perform handshake
  → State: connected
```

### Port Update (Companion Restart)
```
Port update received
  → connectionManager.onPortUpdate(newPort)
  → State: disconnected
  → Generate NEW encryption key (security)
  → State: key_ready
  → Perform handshake automatically
  → State: connected (or disconnected if 404)
```

### API Call Error
```
API call fails
  → connectionManager.apiCall() detects error
  → Classify error type (404, network, timeout, etc.)
  → If 404 or network: State: disconnected, no auto-retry
  → User must manually reconnect or wait for port update
```

## Security Features

### Key Rotation on Companion Restart
When a port update is detected (indicating companion app restart), the system:
1. Resets connection state
2. **Generates a new encryption key** (ensures session isolation)
3. Attempts handshake with the new key

This provides:
- Session isolation between companion restarts
- Natural key rotation
- Prevention of replay attacks across sessions

### Connection Validation
Every API call is validated to ensure:
- Valid encryption key exists and hasn't expired
- Successful handshake has been performed
- Companion app port is available

## Error Handling

The system classifies errors into types for intelligent handling:

- **404 Error:** Companion app doesn't exist, mark as disconnected, wait for user/port update
- **Network Error:** Connection failed, mark as disconnected, wait for user/port update  
- **Timeout Error:** Request timed out, mark as disconnected
- **Handshake Error:** Handshake failed, mark as disconnected
- **Other Error:** Propagate error but may maintain connection state

## API Reference

### ConnectionManager Methods

```typescript
// Connection operations
connect(): Promise<void>
disconnect(): void
isConnected(): boolean
getState(): ConnectionState
canConnect(): boolean

// Event handlers
onPortUpdate(newPort: number): Promise<void>
onKeyGenerated(): void

// API call wrappers
apiCall<T>(fn: () => Promise<T>): Promise<T>
streamCall<T>(fn: () => Promise<T>): Promise<T>

// Status information
getConnectionInfo(): ConnectionInfo
```

### React Hooks

```typescript
// Connection management
useCompanionConnection()
  → { connect, disconnect, isConnected, isConnecting, error, connectionState, canConnect }

// Status monitoring
useCompanionStatus()
  → { state, isConnected, hasKey, hasPort, canConnect, port, keyExpiresAt, isConnecting, error }

// Data fetching
useCompanionQuery<TData>(options)
useCompanionMutation<TData, TVariables>(options)
useCompanionStream(endpoint, options)
```

## Files Structure

```
companion/api/
  ├── ConnectionManager.ts       (Central orchestrator)
  ├── companionAppClient.ts      (HTTP operations)
  ├── companionAppHooks.ts       (React hooks)
  ├── handshake.ts               (Handshake protocol)
  ├── encryption.ts              (Encryption utilities)
  ├── index.ts                   (Public exports)
  └── README.md                  (This file)

companion/stores/
  └── useCompanionStore.ts       (Connection state store)

user/stores/
  └── usePortUpdatesStore.ts     (Port monitoring with ConnectionManager integration)
```

## Migration Guide

### Old Code
```typescript
// ❌ Old way - direct client access
const { performHandshake } = useCompanionConnection();
await performHandshake();
```

### New Code
```typescript
// ✅ New way - through ConnectionManager
const { connect } = useCompanionConnection();
await connect();
```

## Benefits

1. **Single Source of Truth:** All connection logic in one place
2. **Automatic Key Management:** Keys generated on demand and rotated on restart
3. **Intelligent Error Handling:** Distinguishes between error types
4. **Smart Reconnection:** Auto-reconnect on port update, but no infinite retries
5. **Type-Safe:** Strong typing throughout the system
6. **Testable:** Easy to mock ConnectionManager for testing
7. **Clean Separation:** Each component has single responsibility
