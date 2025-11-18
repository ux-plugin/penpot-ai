/**
 * TypeScript types for WebSocket messages exchanged with companion app
 * All messages use encrypted format: base64<nonce(12)|encrypted_payload>
 * 
 * New format includes request/response IDs for correlation tracking
 */

// Command types sent from UI to companion
export type WebSocketCommand = 
  | 'init'
  | 'start-recording'
  | 'stop-recording'
  | 'play-audio'
  | 'stop-audio'
  | 'health-check';

// Response types received from companion
export type WebSocketResponseType =
  | 'init'
  | 'health-check'
  | 'recording-started'
  | 'recording-stopped'
  | 'audio-chunk'
  | 'audio-playback-started'
  | 'audio-playback-stopped'
  | 'audio-playback-error'
  | 'error';

// Request structure (Client → Server)
export interface WebSocketRequest {
  id: string;
  command: WebSocketCommand;
  data?: any; // Optional data payload for commands
}

// Response structure (Server → Client)
export interface WebSocketResponse {
  id: string;
  type: WebSocketResponseType;
  data?: any;
}

// Decrypted payload can be either request or response
export type DecryptedPayload = WebSocketRequest | WebSocketResponse;

// Type guard to check if payload is a response
export function isWebSocketResponse(payload: DecryptedPayload): payload is WebSocketResponse {
  return 'type' in payload;
}

// Type guard to check if payload is a request
export function isWebSocketRequest(payload: DecryptedPayload): payload is WebSocketRequest {
  return 'command' in payload;
}

// Specific response data types
export interface InitResponseData {
  message: string;
}

export interface HealthCheckResponseData {
  message: string;
}

export interface AudioChunkData {
  data: string; // base64 audio data
}

export interface ErrorResponseData {
  code: number;
  message: string;
}

// Type guards for runtime validation
export function isInitResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: InitResponseData } {
  return isWebSocketResponse(payload) && payload.type === 'init';
}

export function isHealthCheckResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: HealthCheckResponseData } {
  return isWebSocketResponse(payload) && payload.type === 'health-check';
}

export function isRecordingStartedResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: null } {
  return isWebSocketResponse(payload) && payload.type === 'recording-started';
}

export function isRecordingStoppedResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: null } {
  return isWebSocketResponse(payload) && payload.type === 'recording-stopped';
}

export function isAudioChunkResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: string } {
  return isWebSocketResponse(payload) && payload.type === 'audio-chunk';
}

export function isErrorResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: ErrorResponseData } {
  return isWebSocketResponse(payload) && payload.type === 'error';
}

export function isAudioPlaybackStartedResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: null } {
  return isWebSocketResponse(payload) && payload.type === 'audio-playback-started';
}

export function isAudioPlaybackStoppedResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: null } {
  return isWebSocketResponse(payload) && payload.type === 'audio-playback-stopped';
}

export function isAudioPlaybackErrorResponse(payload: DecryptedPayload): payload is WebSocketResponse & { data: ErrorResponseData } {
  return isWebSocketResponse(payload) && payload.type === 'audio-playback-error';
}
