/**
 * Encryption utilities for companion app communication using symmetric encryption
 */

// Message validation constants
const MAX_MESSAGE_AGE_MS = 30000; // 30 seconds
const TIMESTAMP_TOLERANCE_MS = 5000; // 5-second tolerance for clock differences

interface DataPayload {
  data: string;
  timestamp: number;
}

interface DecryptedMessage {
  data: string;
  timestamp: number;
  nonce: string;
}

/**
 * Encrypts data with timestamp using AES-GCM encryption
 * The nonce is embedded in the encrypted message for transport
 */
export const encryptMessage = async (
  encryptionKey: string,
  data: string,
  nonce: string,
  timestamp: number = Date.now()
): Promise<string> => {
  const payload: DataPayload = { data, timestamp };
  const payloadString = JSON.stringify(payload);

  // Convert the encryption key to a CryptoKey
  const keyData = new TextEncoder().encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData.slice(0, 32), // AES-256 requires 32 bytes
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Convert nonce to Uint8Array (12 bytes for GCM)
  // If nonce is base64, decode it; otherwise encode it
  let iv: Uint8Array;
  try {
    // Try to decode as base64 first
    const decodedNonce = atob(nonce);
    iv = new Uint8Array(decodedNonce.split('').map(char => char.charCodeAt(0))).slice(0, 12);
  } catch {
    // If not base64, encode as string
    iv = new TextEncoder().encode(nonce).slice(0, 12);
  }

  // Encrypt the payload
  const encryptedData = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    cryptoKey,
    new TextEncoder().encode(payloadString)
  );

  // Combine IV and encrypted data, then encode as base64
  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);

  return btoa(String.fromCharCode(...combined));
};

/**
 * Decrypts data encrypted with encryptMessage
 * Extracts the nonce from the encrypted message
 */
export const decryptMessage = async (
  encryptionKey: string,
  encryptedMessage: string
): Promise<DecryptedMessage> => {
  // Decode base64 and extract IV and encrypted data
  const combined = new Uint8Array(
    atob(encryptedMessage)
      .split('')
      .map(char => char.charCodeAt(0))
  );

  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);

  // Convert the encryption key to a CryptoKey
  const keyData = new TextEncoder().encode(encryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData.slice(0, 32), // AES-256 requires 32 bytes
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt the data
  const decryptedData = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    cryptoKey,
    encryptedData
  );

  // Convert back to string and parse JSON
  const payloadString = new TextDecoder().decode(decryptedData);
  const payload: DataPayload = JSON.parse(payloadString);

  // Convert IV back to base64 nonce for consistency
  const nonce = btoa(String.fromCharCode(...iv));

  return {
    ...payload,
    nonce
  };
};

/**
 * Validates if a timestamp is within acceptable range
 */
export const validateTimestamp = (timestamp: number, maxAgeMs: number = MAX_MESSAGE_AGE_MS): boolean => {
  const now = Date.now();
  const age = now - timestamp;

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
 * Returns only the encrypted_data string containing nonce|encrypted_payload{message, timestamp}
 */
export const createCompanionMessage = async (
  data: string,
  encryptionKey: string,
  nonce: string
): Promise<string> => {
  const timestamp = Date.now();
  return await encryptMessage(encryptionKey, data, nonce, timestamp);
};

/**
 * Validates and extracts data from a received companion message
 * Takes the encrypted_data string which contains nonce|encrypted_payload{message, timestamp}
 */
export const decryptIfValid = async (
  encryptedData: string,
  encryptionKey: string,
  nonceValidator: (nonce: string) => boolean
): Promise<DecryptedMessage> => {
  // Decrypt the message to get the embedded nonce and payload
  const decrypted = await decryptMessage(encryptionKey, encryptedData);

  // Validate nonce (prevents replay attacks)
  if (!nonceValidator(decrypted.nonce)) {
    throw new Error('Invalid or replayed nonce');
  }

  // Validate timestamp
  if (!validateTimestamp(decrypted.timestamp)) {
    throw new Error('Message timestamp outside acceptable range');
  }

  return decrypted;
};