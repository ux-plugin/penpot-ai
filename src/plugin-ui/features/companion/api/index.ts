/**
 * Companion API exports
 * Provides singleton instances and main exports for companion app connectivity
 */

import { ConnectionManager } from './ConnectionManager.ts';
import { companionAppClient } from './companionAppClient.ts';
import { encryptionKeyManager } from '@user/api/EncryptionKeyManager.ts';
import { nonceManager } from '@shared/api/NonceManager.ts';
import { useCompanionStore } from '@companion/stores/useCompanionStore.ts';
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore.ts';

// Export types
export type { ConnectionState, ConnectionError, ConnectionErrorType } from './ConnectionManager.ts';
export type { StreamChunk } from './companionAppClient.ts';

// Create and export singleton ConnectionManager instance
export const connectionManager = new ConnectionManager({
  client: companionAppClient,
  keyManager: encryptionKeyManager,
  nonceManager,
  companionStore: useCompanionStore,
  portUpdatesStore: usePortUpdatesStore
});

// Export other modules
export { companionAppClient } from './companionAppClient.ts';
export { ConnectionManager } from './ConnectionManager.ts';

// Export hooks
export {
  useCompanionConnection,
  useCompanionStatus,
  useCompanionQuery,
  useCompanionMutation,
  useCompanionStream,
  companionQueryKeys
} from './companionAppHooks.ts';

// Export hook types
export type {
  UseCompanionQueryOptions,
  UseCompanionMutationOptions,
  UseCompanionStreamOptions
} from './companionAppHooks.ts';
