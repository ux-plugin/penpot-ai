# User API

This directory contains API functions and utilities for user-related operations.

## Port Updates

The port updates feature provides real-time notifications when the companion app port changes via WebSocket. See [PORT_UPDATES.md](./PORT_UPDATES.md) for detailed documentation.

**Quick Start:**
```typescript
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore';

// In your component
const { currentPort, isConnected, connect, disconnect } = usePortUpdatesStore();

useEffect(() => {
  connect();
  return () => disconnect();
}, []);
```

## EncryptionKeyManager

The `EncryptionKeyManager` class handles the generation and lifecycle management of encryption keys for backend-user communication.

### Usage

```typescript
import { EncryptionKeyManager } from '@user/api/EncryptionKeyManager.ts';

// Create an instance
const keyManager = new EncryptionKeyManager();

// Generate a new encryption key
await keyManager.generateKey();

// Get the current key
const key = keyManager.getKey(); // Returns null if no key or expired

// Check if key is valid
if (keyManager.isKeyValid()) {
  // Key exists and is not expired
}

// Get expiration date
const expiresAt = keyManager.getExpiresAt();

// Ensure a valid key exists (auto-generates if needed)
const validKey = await keyManager.ensureValidKey();

// Clear the key
keyManager.clearKey();
```

### Integration with CompanionAppClient

The `EncryptionKeyManager` is now integrated with the companion app architecture:

1. **Store Integration**: The `useCompanionStore` holds a singleton instance of `EncryptionKeyManager`
2. **Dependency Injection**: The manager is passed to `CompanionAppClient` through the dependencies interface
3. **Automatic Key Management**: The client retrieves keys via `keyManager.getKey()` when needed

### API Endpoint

The manager calls `POST /user/key` to generate new encryption keys:

**Request:**
```
POST /user/key
Authorization: Bearer <token>
```

**Response:**
```json
{
  "key": "base64-encoded-aes-256-key",
  "expiresAt": "2025-10-02T12:00:00Z"
}
```

### Example: Initializing the Key Manager

```typescript
import { useCompanionStore } from '@companion/stores/useCompanionStore.ts';

// Get the key manager from the store
const { keyManager } = useCompanionStore();

// Generate a new key before establishing companion connection
try {
  await keyManager.generateKey();
  console.log('Encryption key generated successfully');
} catch (error) {
  console.error('Failed to generate encryption key:', error);
}
```

### Architecture Benefits

- **Separation of Concerns**: Key management is independent of React
- **Dependency Injection**: Clear contracts between components
- **Reusability**: Can be used anywhere, not just in React components
- **Type Safety**: Full TypeScript support with proper interfaces
