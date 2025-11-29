import { apiFetch } from "@api/api-fetcher.ts";

/**
 * Response type from the encryption key API
 */
interface EncryptionKeyResponse {
  key: string;
  expiresAt: string;
}

/**
 * Pure TypeScript class for managing user encryption keys
 * Handles generation and lifecycle of encryption keys for backend-user communication
 * Can be passed as a dependency to components that need encryption
 */
export class EncryptionKeyManager {
  private encryptionKey: string | null = null;
  private keyExpiresAt: Date | null = null;

  /**
   * Fetches the current encryption key from the backend via GET /user/key
   * Updates the local key if it differs from the backend
   */
  async fetchCurrentKey(): Promise<void> {
    try {
      const response = await apiFetch("/user/key", {
        method: "GET",
      });

      const data: EncryptionKeyResponse = await response.json();

      this.encryptionKey = data.key;
      this.keyExpiresAt = new Date(data.expiresAt);

      console.log("Encryption key fetched successfully, expires at:", this.keyExpiresAt);
    } catch (error) {
      console.error("Failed to fetch encryption key:", error);
      throw new Error(
        `Failed to fetch encryption key: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Generates a new encryption key by calling POST /user/key
   * Stores the key and expiration date in memory
   */
  async generateKey(): Promise<void> {
    try {
      const response = await apiFetch("/user/key", {
        method: "POST",
      });

      const data: EncryptionKeyResponse = await response.json();

      this.encryptionKey = data.key;
      this.keyExpiresAt = new Date(data.expiresAt);

      console.log("Encryption key generated successfully, expires at:", this.keyExpiresAt);
    } catch (error) {
      console.error("Failed to generate encryption key:", error);
      throw new Error(
        `Failed to generate encryption key: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Returns the current encryption key
   * Returns null if no key has been generated or if key has expired
   */
  getKey(): string | null {
    if (!this.isKeyValid()) {
      return null;
    }
    return this.encryptionKey;
  }

  /**
   * Checks if the current key is valid (exists and not expired)
   */
  isKeyValid(): boolean {
    if (!this.encryptionKey || !this.keyExpiresAt) {
      return false;
    }

    // Check if key has expired
    const now = new Date();
    return now < this.keyExpiresAt;
  }

  /**
   * Returns the expiration date of the current key
   */
  getExpiresAt(): Date | null {
    return this.keyExpiresAt;
  }

  /**
   * Clears the stored encryption key and expiration date
   */
  clearKey(): void {
    this.encryptionKey = null;
    this.keyExpiresAt = null;
  }

  /**
   * Ensures a valid key exists, generating a new one if needed
   * This is a convenience method for automatic key management
   */
  async ensureValidKey(): Promise<string> {
    if (!this.isKeyValid()) {
      await this.generateKey();
    }

    const key = this.getKey();
    if (!key) {
      throw new Error("Failed to obtain valid encryption key");
    }

    return key;
  }
}

// Export singleton instance
export const encryptionKeyManager = new EncryptionKeyManager();
