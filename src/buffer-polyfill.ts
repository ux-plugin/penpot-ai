/**
 * Buffer polyfill for browser environment
 * 
 * This file provides the Node.js Buffer API in the browser environment
 * Required by rsocket-composite-metadata library
 */

import { Buffer } from 'buffer';

// Make Buffer available globally
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}

// Also ensure it's available on globalThis
if (typeof globalThis !== 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

export { Buffer };
