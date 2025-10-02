/**
 * Pure TypeScript class for managing nonces (number used once)
 * Handles generation and validation of nonces for secure communication
 * Similar to EncryptionKeyManager pattern
 */

// Nonce expiration time in milliseconds (10 seconds)
const NONCE_EXPIRY_MS = 10 * 1000;
const MAX_NONCE_SIZE = 50;

/**
 * Nonce Manager - Singleton class for nonce management
 * Replaces the Zustand useNonceStore with a pure TypeScript implementation
 */
export class NonceManager {
  // Nonce storage - nonce string -> expiration timestamp
  private nonces: Map<string, number> = new Map();

  /**
   * Generate a new nonce using 12 bytes
   */
  private _generateNonce(): string {
    const nonceBuffer = new Uint8Array(12);
    crypto.getRandomValues(nonceBuffer);

    return Array.from(nonceBuffer, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  /**
   * Gets current timestamp in milliseconds
   */
  private getCurrentTimestamp(): number {
    return Date.now();
  }

  /**
   * Calculates expiration timestamp for a nonce
   */
  private getExpirationTimestamp(): number {
    return this.getCurrentTimestamp() + NONCE_EXPIRY_MS;
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
  addNonce(nonce: string): void {
    // Cleanup if we've exceeded max size
    if (this.nonces.size > MAX_NONCE_SIZE) {
      this.cleanupNonces();
    }

    const expirationTime = this.getExpirationTimestamp();
    this.nonces.set(nonce, expirationTime);
  }

  /**
   * Check if a nonce exists and is still valid
   * Returns false if nonce doesn't exist or has expired
   */
  hasNonce(nonce: string): boolean {
    const expirationTime = this.nonces.get(nonce);
    
    if (!expirationTime) {
      return false;
    }
    
    // Check if nonce has expired
    if (this.getCurrentTimestamp() > expirationTime) {
      // Remove expired nonce immediately
      this.nonces.delete(nonce);
      return false;
    }
    
    return true;
  }

  /**
   * Generate a new unique nonce that doesn't exist in the store
   * Automatically adds it to tracking
   */
  generateNonce(): string {
    let nonce: string;
    do {
      nonce = this._generateNonce();
    } while (this.nonces.has(nonce));
    
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
