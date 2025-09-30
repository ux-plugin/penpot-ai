/**
 * Companion App Communication System
 * 
 * This is the main entry point for the new React Query-based companion app
 * communication system with symmetric encryption and nonce-based replay protection.
 * 
 * @example
 * ```typescript
 * import { useCompanionQuery, useCompanionMutation, useCompanionStream } from '@/api/companionApp';
 * 
 * // Simple query
 * const { data, isLoading } = useCompanionQuery({ endpoint: '/status' });
 * 
 * // Mutation
 * const mutation = useCompanionMutation({ endpoint: '/command' });
 * 
 * // Streaming
 * const stream = useCompanionStream('/audio', { onChunk: handleChunk });
 * ```
 */

// Main hooks - most commonly used exports
export {
  useCompanionQuery,
  useCompanionMutation,
  useCompanionStream,
  useCompanionConnection,
  useCompanionStatus,
  companionQueryKeys
} from './companionAppHooks';

// Client class - for advanced usage
export {
  companionAppClient,
  CompanionAppClient,
  type CompanionClientDependencies,
  type StreamChunk
} from './companionAppClient';

// Encryption utilities - for custom implementations
export {
  encryptMessage,
  decryptMessage,
  validateTimestamp,
  createCompanionMessage,
  decryptIfValid
} from '@/api/companionApp/encryption.ts';

// Handshake functions - for custom connection management
export {
  performHandshakeWithDependencies
} from './handshake';

// Hook options types - for TypeScript users
export type {
  UseCompanionQueryOptions,
  UseCompanionMutationOptions,
  UseCompanionStreamOptions
} from './companionAppHooks';
