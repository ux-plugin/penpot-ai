# Companion App Communication System

This directory contains the new React Query-based companion app communication system with symmetric encryption, nonce-based replay protection, and clean dependency injection.

## Architecture Overview

### 🏗️ Core Components

```
src/api/companionApp/
├── companionAppClient.ts    # Pure client class (no store dependencies)
├── companionAppHooks.ts     # React Query hooks with store integration
├── encryption.ts           # Updated symmetric encryption utilities
├── handshake.ts            # Handshake logic with new message format
├── examples.ts             # Usage examples and migration guide
└── README.md              # This documentation
```

### 🔐 Message Format

All messages between the UI and companion app use this structure:

```typescript
{
  encrypted_data: string,  // Encrypted JSON: { data: string, timestamp: number }
  nonce: string           // Plain text nonce for replay protection
}
```

### 🔄 Data Flow

1. **Hook Level**: Stores integration (Zustand) + React Query
2. **Client Level**: Pure communication logic with dependency injection
3. **Encryption Level**: Symmetric encryption with timestamp validation
4. **Transport Level**: HTTP with nonce-based replay protection

## Key Features

### ✨ New Capabilities

- **React Query Integration**: Automatic caching, retries, and state management
- **Streaming Support**: Real-time data streams with chunk validation
- **Symmetric Encryption**: Improved security with timestamp validation
- **Nonce-Based Replay Protection**: Automatic nonce management with cleanup
- **Dependency Injection**: Clean, testable architecture
- **Connection State Management**: Automatic connection monitoring
- **TypeScript Support**: Full type safety throughout

### 🛡️ Security Features

- **Message Encryption**: All data encrypted with symmetric key
- **Timestamp Validation**: Messages rejected if too old (30s window)
- **Nonce Replay Protection**: Each nonce used only once within time window
- **Automatic Cleanup**: Expired nonces cleaned up every 5 seconds
- **Key Rotation**: Automatic encryption key refresh when expired

## Usage Guide

### 🚀 Quick Start

```typescript
import { 
  useCompanionQuery, 
  useCompanionMutation, 
  useCompanionStream 
} from '@/api/companionApp/companionAppHooks';

// Simple query
const { data, isLoading, error } = useCompanionQuery({
  endpoint: '/status'
});

// Mutation with callbacks
const mutation = useCompanionMutation({
  endpoint: '/command',
  onSuccess: (data) => console.log('Success:', data),
  onError: (error) => console.error('Error:', error)
});

// Streaming data
const stream = useCompanionStream('/audio-stream', {
  onChunk: (chunk) => console.log('Chunk:', chunk),
  onComplete: (allChunks) => console.log('Stream complete')
});
```

### 📋 Available Hooks

#### `useCompanionQuery<T>(options)`
For GET-like operations with caching.

```typescript
const { data, isLoading, error, refetch } = useCompanionQuery<StatusResponse>({
  endpoint: '/status',
  requestOptions?: RequestInit,
  // Standard React Query options
  refetchInterval: 30000,
  staleTime: 60000,
  enabled: true
});
```

#### `useCompanionMutation<TData, TVariables>(options)`
For POST/PUT operations with optimistic updates.

```typescript
const mutation = useCompanionMutation<ResponseType, RequestType>({
  endpoint: '/command',
  onSuccess: (data, variables) => { /* handle success */ },
  onError: (error, variables) => { /* handle error */ },
  onSettled: (data, error, variables) => { /* cleanup */ }
});

mutation.mutate(requestData);
```

#### `useCompanionStream(endpoint, options)`
For real-time streaming data.

```typescript
const {
  startStream,
  stopStream,
  resetStream,
  isStreaming,
  chunks,
  error,
  isReady
} = useCompanionStream('/stream-endpoint', {
  onChunk: (chunk) => { /* process chunk */ },
  onComplete: (allChunks) => { /* handle completion */ },
  onError: (error) => { /* handle error */ },
  autoStart: true // Start automatically when ready
});
```

#### `useCompanionConnection()`
For handshake and connection management.

```typescript
const {
  performHandshake,
  isConnected,
  isConnecting,
  error,
  isReady
} = useCompanionConnection();
```

#### `useCompanionStatus()`
For monitoring connection status.

```typescript
const {
  hasEncryptionKey,
  hasPort,
  isConnected,
  isReady,
  error,
  keyExpiresAt
} = useCompanionStatus();
```

## Migration Guide

### 📦 From Old System

**OLD (companion-app-fetch.ts):**
```typescript
// Manual state management
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  companionAppFetch('/status')
    .then(response => response.json())
    .then(setData)
    .catch(console.error)
    .finally(() => setLoading(false));
}, []);
```

**NEW (React Query hooks):**
```typescript
// Automatic state management
const { data, isLoading, error } = useCompanionQuery({
  endpoint: '/status'
});
```

### 🔄 Migration Steps

1. **Replace fetch calls** with appropriate hooks
2. **Remove manual state management** (loading, error states)
3. **Update component logic** to use hook return values
4. **Add connection status checks** where needed
5. **Test thoroughly** with the new system

### 📝 Migration Checklist

- [ ] Identify all `companionAppFetch` calls
- [ ] Choose appropriate hook for each use case
- [ ] Update component state management
- [ ] Add proper error handling
- [ ] Test connection scenarios
- [ ] Verify streaming functionality
- [ ] Update TypeScript types

## Advanced Usage

### 🎛️ Custom Hooks

Create domain-specific hooks for common operations:

```typescript
export function useDeviceStatus() {
  return useCompanionQuery<DeviceStatus>({
    endpoint: '/device/status',
    refetchInterval: 5000, // Update every 5 seconds
    staleTime: 3000,
  });
}

export function useExecuteCommand() {
  return useCompanionMutation<CommandResult, Command>({
    endpoint: '/execute',
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries(['companion', '/device/status']);
    }
  });
}
```

### 🌊 Streaming Best Practices

```typescript
const audioStream = useCompanionStream('/audio-recording', {
  onChunk: useCallback((chunk) => {
    // Process audio chunk efficiently
    audioProcessor.processChunk(chunk.data);
  }, [audioProcessor]),
  
  onError: useCallback((error) => {
    // Handle stream errors gracefully
    toast.error(`Stream error: ${error.message}`);
  }, []),
  
  onComplete: useCallback((allChunks) => {
    // Handle completion
    const audioData = combineChunks(allChunks);
    saveRecording(audioData);
  }, [])
});
```

### 🔗 Query Key Management

Use consistent query keys for proper caching:

```typescript
import { companionQueryKeys } from './companionAppHooks';

// Manual invalidation
queryClient.invalidateQueries({
  queryKey: companionQueryKeys.endpoint('/status')
});

// Prefetch data
queryClient.prefetchQuery({
  queryKey: companionQueryKeys.endpoint('/config'),
  queryFn: () => companionQuery('/config')
});
```

## Troubleshooting

### 🔍 Common Issues

#### Connection Not Ready
```typescript
const status = useCompanionStatus();

if (!status.isReady) {
  return <div>
    <p>Connection Status:</p>
    <ul>
      <li>Encryption Key: {status.hasEncryptionKey ? '✓' : '✗'}</li>
      <li>Port: {status.hasPort ? '✓' : '✗'}</li>
      <li>Connected: {status.isConnected ? '✓' : '✗'}</li>
    </ul>
  </div>;
}
```

#### Query Not Executing
- Check if `enabled` option is set correctly
- Verify connection state with `useCompanionStatus()`
- Ensure encryption key and port are available

#### Stream Not Starting
- Verify `isReady` state before calling `startStream()`
- Check for error messages in `stream.error`
- Ensure endpoint supports streaming

#### Nonce Replay Errors
- This should be handled automatically
- If persistent, check system clock synchronization
- Verify nonce store is working correctly

### 🐛 Debugging

Enable detailed logging by adding to your component:

```typescript
useEffect(() => {
  console.log('Companion Status:', useCompanionStatus());
}, []);
```

Monitor React Query dev tools for cache and network state.

## Security Considerations

### 🔒 Best Practices

1. **Key Management**: Encryption keys are managed by the store system
2. **Nonce Validation**: Automatic replay protection with time windows
3. **Timestamp Checks**: Messages rejected if outside acceptable time range
4. **Error Handling**: Sensitive information not exposed in error messages
5. **Connection State**: Always verify connection before sensitive operations

### ⚠️ Security Notes

- The current encryption uses base64 placeholder - implement proper AES-GCM encryption
- Nonce cleanup happens automatically but can be manually triggered
- Key rotation is handled by the backend key refresh system
- All communication is over localhost only

## Performance Optimization

### ⚡ Tips

1. **Query Keys**: Use consistent keys for proper caching
2. **Stale Time**: Set appropriate `staleTime` for data freshness
3. **Refetch Intervals**: Use sparingly to avoid unnecessary requests
4. **Stream Processing**: Process chunks efficiently to avoid backpressure
5. **Error Boundaries**: Implement proper error boundaries for graceful degradation

### 📊 Monitoring

Monitor the following metrics:
- Query cache hit rate
- Network request frequency
- Stream chunk processing time
- Connection state changes
- Error rates by endpoint

---

## API Reference

### Types

```typescript
interface CompanionClientDependencies {
  encryptionKey: string;
  nonce: string;
  currentPort: number;
  nonceValidator: (nonce: string) => boolean;
  onConnectionStateChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}

interface StreamChunk {
  data: any;
  timestamp: number;
}
```

### Constants

```typescript
// Encryption
const MAX_MESSAGE_AGE_MS = 30000;  // 30 seconds
const TIMESTAMP_TOLERANCE_MS = 5000;  // 5 seconds

// Client
const DEFAULT_TIMEOUT = 10000;  // 10 seconds
const MAX_RETRIES = 3;
```

For more examples, see `examples.ts` in this directory.
