/**
 * useCanvasKit Hook
 *
 * Initializes and caches the CanvasKit (Skia) WASM module.
 * Handles async loading state during initialization.
 */

import { useState, useEffect, useRef } from "react";
import CanvasKitInit, { CanvasKit } from "canvaskit-wasm";
// Import WASM file URL using Vite's ?url suffix - this ensures version match with JS glue code
import canvasKitWasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";

// Singleton instance to avoid reloading WASM
let canvasKitInstance: CanvasKit | null = null;
let initPromise: Promise<CanvasKit> | null = null;

/**
 * Initialize CanvasKit WASM module (singleton pattern)
 */
async function initCanvasKit(): Promise<CanvasKit> {
  if (canvasKitInstance) {
    return canvasKitInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = CanvasKitInit({
    locateFile: (file: string) => {
      // Use the imported WASM URL to ensure version match with JS glue code
      return file.endsWith(".wasm") ? canvasKitWasmUrl : file;
    },
  });

  canvasKitInstance = await initPromise;
  return canvasKitInstance;
}

export interface UseCanvasKitResult {
  /** The CanvasKit instance, null while loading */
  canvasKit: CanvasKit | null;
  /** Whether CanvasKit is currently loading */
  isLoading: boolean;
  /** Error if initialization failed */
  error: Error | null;
}

/**
 * Hook to initialize and use CanvasKit
 *
 * @example
 * ```tsx
 * const { canvasKit, isLoading, error } = useCanvasKit();
 *
 * if (isLoading) return <div>Loading Skia...</div>;
 * if (error) return <div>Failed to load Skia</div>;
 * if (!canvasKit) return null;
 *
 * // Use canvasKit to create surfaces, draw, etc.
 * ```
 */
export function useCanvasKit(): UseCanvasKitResult {
  const [canvasKit, setCanvasKit] = useState<CanvasKit | null>(
    canvasKitInstance,
  );
  const [isLoading, setIsLoading] = useState(!canvasKitInstance);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Already loaded
    if (canvasKitInstance) {
      setCanvasKit(canvasKitInstance);
      setIsLoading(false);
      return;
    }

    // Load CanvasKit
    initCanvasKit()
      .then((ck) => {
        if (mountedRef.current) {
          setCanvasKit(ck);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        console.error("[useCanvasKit] Failed to initialize CanvasKit:", err);
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { canvasKit, isLoading, error };
}

/**
 * Get the current CanvasKit instance (if already loaded)
 * Useful for non-hook contexts
 */
export function getCanvasKit(): CanvasKit | null {
  return canvasKitInstance;
}

export default useCanvasKit;
