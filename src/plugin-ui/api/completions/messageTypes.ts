/**
 * RSocket Message Payload Types
 * 
 * Since we're using RSocket instead of WebSocket, we only need the payload types.
 * RSocket handles stream completion via .complete() method, eliminating the need
 * for "End" message types.
 */

// ============================================================================
// AUTH PAYLOADS
// ============================================================================

/**
 * Auth: Refresh Token (Client → Server)
 */
export interface AuthRefreshTokenPayload {
  access_token: string;
}

/**
 * Auth: Refresh Token Response (Server → Client)
 */
export type AuthRefreshTokenResponsePayload = string;

// ============================================================================
// COMPLETIONS PAYLOADS
// ============================================================================

/**
 * Completions: Request (Client → Server)
 * Streams drawing and audio data via RSocket request-channel
 */
export interface CompletionsRequestPayload {
  drawnPath: string;
  audioChunkBase64: string;
  timestamp: number;
}

/**
 * Completions: Action details
 */
export interface CompletionAction {
  action: string;
  target: string;
  params: string;
}

/**
 * Completions: Response (Server → Client)
 * AI-generated component action streamed via RSocket request-channel
 */
export interface CompletionsResponsePayload {
  action?: CompletionAction;
  reasoning?: string;
  text?: string;
}

// ============================================================================
// USER PAYLOADS
// ============================================================================

/**
 * User: Subscribe Ports (Client → Server)
 * Subscribe to port configuration updates
 */
export type UserSubscribePortsPayload = Record<string, never>;

/**
 * User: Unsubscribe Ports (Client → Server)
 * Unsubscribe from port configuration updates
 */
export type UserUnsubscribePortsPayload = Record<string, never>;

/**
 * User: Subscribe Ports Response (Server → Client)
 * Confirmation of port subscription
 */
export type UserSubscribePortsResponsePayload = Record<string, never>;

/**
 * User: Unsubscribe Ports Response (Server → Client)
 * Confirmation of port unsubscription
 */
export type UserUnsubscribePortsResponsePayload = Record<string, never>;
