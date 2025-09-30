import { create } from "zustand";

// Nonce expiration time in milliseconds (10 seconds)
const NONCE_EXPIRY_MS = 10 * 1000;
const MAX_NONCE_SIZE = 50;

interface NonceState {
  // Nonce storage - nonce string -> expiration timestamp
  nonces: Map<string, number>;

  // Actions - Nonce management
  addNonce: (nonce: string) => void;
  hasNonce: (nonce: string) => boolean;
  generateNonce: () => Promise<string>;
  generateNewNonce: () => Promise<string>;
}

/**
 * Gets current timestamp in milliseconds
 */
function getCurrentTimestamp(): number {
  return Date.now();
}

/**
 * Calculates expiration timestamp for a nonce
 */
function getExpirationTimestamp(): number {
  return getCurrentTimestamp() + NONCE_EXPIRY_MS;
}

function cleanupNonces(nonces: Map<string, number>): Map<string, number> {
  const currentTime = getCurrentTimestamp();
  const newNonces = new Map<string, number>();
  for (const [nonce, expirationTime] of nonces) {
    if (currentTime < expirationTime) {
      newNonces.set(nonce, expirationTime);
    }
  }

  return newNonces
}

export const useNonceStore = create<NonceState>((set, get) => (
  {
  // Initial state
  nonces: new Map<string, number>(),



  // Add nonce to tracking
  addNonce: (nonce: string) => {
    set((state) => {
      let newNonces: Map<string, number>;

      if (state.nonces.size > MAX_NONCE_SIZE) {
        newNonces = cleanupNonces(state.nonces);
      } else {
        newNonces = new Map(state.nonces);
      }

      const expirationTime = getExpirationTimestamp();
      newNonces.set(nonce, expirationTime);
      return { nonces: newNonces };
    });
  },

  // Check if a nonce exists and is still valid
  hasNonce: (nonce: string) => {
    const state = get();
    const expirationTime = state.nonces.get(nonce);
    
    if (!expirationTime) {
      return false;
    }
    
    // Check if nonce has expired
    if (getCurrentTimestamp() > expirationTime) {
      // Remove expired nonce immediately
      set((state) => {
        const newNonces = new Map(state.nonces);
        newNonces.delete(nonce);
        return { nonces: newNonces };
      });
      return false;
    }
    
    return true;
  },

  // Generate a new unique nonce that doesn't exist in the store
  generateNewNonce: async () => {
    const state = get();
    let nonce: string;
    do {
      nonce = await state.generateNonce();
    } while (state.nonces.has(nonce));
    
    // Add the new nonce to tracking
    state.addNonce(nonce);
    return nonce;
  },

  // Generate a new nonce using 12 bytes
  generateNonce: async () => {
    const nonceBuffer = new Uint8Array(12);
    crypto.getRandomValues(nonceBuffer);

    return Array.from(nonceBuffer, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  },
}));
