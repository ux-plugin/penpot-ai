/**
 * Encryption utilities for companion app communication using symmetric encryption
 * Uses @noble/ciphers library for AES-GCM encryption with compatibility in Figma's plugin sandbox
 */
import { gcm } from '@noble/ciphers/aes.js';
// Message validation constants
const MAX_MESSAGE_AGE_MS = 30000; // 30 seconds in milliseconds
const TIMESTAMP_TOLERANCE_MS = 5000; // 5-second tolerance for clock differences in milliseconds

interface DataPayload {
  data: string;
  timestamp_ms: number;
}

interface DecryptedMessage {
  data: string;
  timestamp_ms: number;
  nonce: Uint8Array;
}

/**
 * Convert base64 string to Uint8Array
 */
const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

/**
 * Convert Uint8Array to base64 string
 */
const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
};

/**
 * Encrypts data with timestamp using AES-GCM encryption
 * The nonce is embedded in the encrypted message for transport
 * Timestamp is expected to be in milliseconds
 */
export const encryptMessage = async (
  base64EncryptionKey: string,
  data: string,
  nonce: Uint8Array,
  timestamp_ms: number
): Promise<string> => {
  const payload: DataPayload = { data, timestamp_ms };
  const payloadString = JSON.stringify(payload);

  // Decode the base64 encryption key
  const keyBytes = base64ToUint8Array(base64EncryptionKey);
  
  // Use first 12 bytes of nonce as IV for GCM
  const iv = nonce.slice(0, 12);

  // Convert plaintext string to Uint8Array
  const plaintextBytes = new TextEncoder().encode(payloadString);

  // Create cipher with AES-GCM mode and encrypt
  // noble/ciphers gcm automatically appends the 16-byte auth tag to the output
  const aes = gcm(keyBytes, iv);
  const encryptedWithTag = aes.encrypt(plaintextBytes);

  // Combine IV + encrypted data with tag
  const combined = new Uint8Array(iv.length + encryptedWithTag.length);
  combined.set(iv, 0);
  combined.set(encryptedWithTag, iv.length);
  
  // Encode as base64
  return uint8ArrayToBase64(combined);
};

/**
 * Decrypts data encrypted with encryptMessage
 * Extracts the nonce from the encrypted message
 */
export const decryptMessage = async (
  base64EncryptionKey: string,
  encryptedMessage: string
): Promise<DecryptedMessage> => {
  // Decode base64
  const combined = base64ToUint8Array(encryptedMessage);
  
  // Extract IV (12 bytes) and encrypted data with tag (remaining bytes)
  const iv = combined.slice(0, 12);
  const encryptedWithTag = combined.slice(12);

  // Decode the base64 encryption key
  const keyBytes = base64ToUint8Array(base64EncryptionKey);

  // Create decipher with AES-GCM mode and decrypt
  // noble/ciphers gcm expects the encrypted data with auth tag appended
  // It will throw an error if authentication fails
  let decryptedBytes: Uint8Array;
  try {
    const aes = gcm(keyBytes, iv);
    decryptedBytes = aes.decrypt(encryptedWithTag);
  } catch (error) {
    throw new Error('Decryption failed - invalid key, corrupted data, or authentication failed');
  }

  // Convert decrypted bytes back to string and parse JSON
  const payloadString = new TextDecoder().decode(decryptedBytes);
  
  if (!payloadString) {
    throw new Error('Decryption failed - empty result');
  }
  
  const payload: DataPayload = JSON.parse(payloadString);

  return {
    ...payload,
    nonce: iv
  };
};

/**
 * Validates if a timestamp is within acceptable range
 * Timestamp is expected to be in milliseconds
 */
export const validateTimestamp = (timestamp_ms: number, maxAgeMs: number = MAX_MESSAGE_AGE_MS): boolean => {
  const now = Date.now();
  const age = now - timestamp_ms;

  // Check if message is too old
  if (age > maxAgeMs) {
    console.warn(`Message too old: ${age}ms > ${maxAgeMs}ms`);
    return false;
  }

  // Check if message is from the future (with tolerance)
  if (age < -TIMESTAMP_TOLERANCE_MS) {
    console.warn(`Message from future: ${age}ms < -${TIMESTAMP_TOLERANCE_MS}ms`);
    return false;
  }

  return true;
};

/**
 * Creates a message with the required structure for companion app communication
 * Returns only the encrypted_data string containing nonce|encrypted_payload{message, timestamp_ms}|tag
 * Timestamp is stored in milliseconds
 */
export const createCompanionMessage = async (
  data: string,
  base64EncryptionKey: string,
  nonce: Uint8Array
): Promise<string> => {
  const timestamp_ms: number = Date.now();
  return await encryptMessage(base64EncryptionKey, data, nonce, timestamp_ms);
};

/**
 * Validates and extracts data from a received companion message
 * Takes the encrypted_data string which contains nonce|encrypted_payload{message, timestamp_ms}|tag
 */
export const decryptIfValid = async (
  encryptedData: string,
  base64EncryptionKey: string,
  nonceValidator: (nonce: Uint8Array) => boolean
): Promise<DecryptedMessage> => {
  // Decrypt the message to get the embedded nonce and payload
  const decrypted = await decryptMessage(base64EncryptionKey, encryptedData);

  // Validate nonce (prevents replay attacks)
  if (!nonceValidator(decrypted.nonce)) {
    throw new Error('Invalid or replayed nonce');
  }

  // Validate timestamp
  if (!validateTimestamp(decrypted.timestamp_ms)) {
    throw new Error('Message timestamp outside acceptable range');
  }

  return decrypted;
};
