/**
 * Pure TypeScript class for managing nonces (number used once)
 * Handles generation and validation of nonces for secure communication
 * Similar to EncryptionKeyManager pattern
 */

// Nonce expiration time in seconds
const NONCE_EXPIRY_S = 10;
const MAX_NONCE_SIZE = 50;

/**
 * Nonce Manager - Singleton class for nonce management
 * Replaces the Zustand useNonceStore with a pure TypeScript implementation
 */
export class NonceManager {
  // Nonce storage - nonce string (base64) -> expiration timestamp
  // We use string as key since Map can't use Uint8Array directly
  private nonces: Map<string, number> = new Map();

  /**
   * Convert Uint8Array to base64 string for use as Map key
   */
  private nonceToKey(nonce: Uint8Array): string {
    return btoa(String.fromCharCode(...nonce));
  }

  /**
   * Generate a new nonce using 12 bytes as Uint8Array
   */
  private _generateNonce(): Uint8Array {
    const nonceBuffer = new Uint8Array(12);
    crypto.getRandomValues(nonceBuffer);
    return nonceBuffer;
  }

  /**
   * Gets current timestamp in seconds
   */
  private getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Calculates expiration timestamp for a nonce
   */
  private getExpirationTimestamp(): number {
    return this.getCurrentTimestamp() + NONCE_EXPIRY_S;
  }

  /**
   * Cleanup expired nonces
   */
  private cleanupNonces(): void {
    const currentTime = this.getCurrentTimestamp();
    const newNonces = new Map<string, number>();
    
    for (const [nonce, expirationTime] of this.nonces) {
      if (currentTime < expirationTime) {
        newNonces.set(nonce, expirationTime);
      }
    }

    this.nonces = newNonces;
  }

  /**
   * Add nonce to tracking with expiration time
   */
  addNonce(nonce: Uint8Array): void {
    // Cleanup if we've exceeded max size
    if (this.nonces.size > MAX_NONCE_SIZE) {
      this.cleanupNonces();
    }

    const nonceKey = this.nonceToKey(nonce);
    const expirationTime = this.getExpirationTimestamp();
    this.nonces.set(nonceKey, expirationTime);
  }

  /**
   * Check if a nonce exists and is still valid
   * Returns false if nonce doesn't exist or has expired
   */
  hasNonce(nonce: Uint8Array): boolean {
    const nonceKey = this.nonceToKey(nonce);
    const expirationTime = this.nonces.get(nonceKey);
    
    if (!expirationTime) {
      return false;
    }
    
    // Check if nonce has expired
    if (this.getCurrentTimestamp() > expirationTime) {
      // Remove expired nonce immediately
      this.nonces.delete(nonceKey);
      return false;
    }
    
    return true;
  }

  /**
   * Generate a new unique nonce that doesn't exist in the store
   * Automatically adds it to tracking
   */
  generateNonce(): Uint8Array {
    let nonce: Uint8Array;
    let nonceKey: string;
    
    do {
      nonce = this._generateNonce();
      nonceKey = this.nonceToKey(nonce);
    } while (this.nonces.has(nonceKey));
    
    // Add the new nonce to tracking
    this.addNonce(nonce);
    return nonce;
  }

  /**
   * Clear all stored nonces
   * Useful for testing or resetting state
   */
  clearAll(): void {
    this.nonces.clear();
  }

  /**
   * Get the count of currently tracked nonces
   * Useful for debugging
   */
  getCount(): number {
    return this.nonces.size;
  }
}

// Export singleton instance
export const nonceManager = new NonceManager();
