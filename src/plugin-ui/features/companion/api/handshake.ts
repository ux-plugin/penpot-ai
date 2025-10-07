import { createCompanionMessage, decryptIfValid } from './encryption.ts';

// Constants
const HANDSHAKE_COMMAND = 'CMD';
const HANDSHAKE_ENDPOINT = '/init';
const DEFAULT_TIMEOUT = 10000; // 10 seconds

// Types for new message format
interface HandshakeRequest {
  encrypted_data: string;
}

interface HandshakeResponse {
  encrypted_data: string;
}

/**
 * Creates handshake request with new message format (encrypted_data + nonce)
 */
const createHandshakeRequest = async (
  base64EncryptionKey: string,
  nonce: Uint8Array
): Promise<HandshakeRequest> => {
  const encrypted_data = await createCompanionMessage(HANDSHAKE_COMMAND, base64EncryptionKey, nonce);
  return {
    encrypted_data: encrypted_data
  };
};

/**
 * Sends handshake request to companion app
 */
const sendHandshakeRequest = async (
  port: number, 
  request: HandshakeRequest
): Promise<HandshakeResponse> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  
  try {
    const response = await fetch(`http://localhost:${port}${HANDSHAKE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const responseData = await response.json();
    
    // Validate new message format - only encrypted_data field expected
    if (!responseData || typeof responseData.encrypted_data !== 'string') {
      throw new Error('Invalid response format from companion app');
    }
    
    return responseData as HandshakeResponse;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Handshake request timed out after ${DEFAULT_TIMEOUT}ms`);
    }
    
    throw error;
  }
};

/**
 * Processes and validates handshake response
 */
const processHandshakeResponse = async (
  response: HandshakeResponse,
  base64EncryptionKey: string,
  nonceValidator: (nonce: Uint8Array) => boolean
): Promise<void> => {
  try {
    // Validate the handshake response using new encryption utilities
    const validated = await decryptIfValid(response.encrypted_data, base64EncryptionKey, nonceValidator);
    
    console.log('Handshake response validated successfully');
    console.log('Response data:', validated.data);
    console.log('Response timestamp:', new Date(validated.timestamp_ms).toISOString());
    
  } catch (error) {
    console.error('Handshake response validation failed:', error);
    throw new Error(`Handshake response validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};


/**
 * New handshake function that uses the updated message format
 * This is used internally by the CompanionAppClient
 */
export const executeHandshake = async (
  port: number,
  base64EncryptionKey: string,
  nonce: Uint8Array,
  nonceValidator: (nonce: Uint8Array) => boolean
): Promise<void> => {
  console.log(`Starting handshake with companion app on port ${port} using symmetric encryption`);
  
  try {
    // Create the encrypted handshake request
    const handshakeRequest = await createHandshakeRequest(base64EncryptionKey, nonce);
    console.log('Handshake request created with nonce');
    
    // Send the handshake request
    const handshakeResponse = await sendHandshakeRequest(port, handshakeRequest);
    console.log('Handshake request sent successfully');
    
    // Process and validate the response
    await processHandshakeResponse(handshakeResponse, base64EncryptionKey, nonceValidator);
    console.log('Handshake completed successfully');
    
  } catch (error) {
    console.error('Handshake failed:', error);
    throw error;
  }
};
