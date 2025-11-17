// Worker script that simulates the Figma plugin environment and loads code.ts

// Disable network access to simulate the isolated Figma worker environment
globalThis.fetch = (..._args: any[]) => {
  console.warn('[WORKER] Network access blocked - fetch() not available in Figma worker');
  return Promise.reject(new Error('Network access not available in Figma plugin worker'));
};

globalThis.XMLHttpRequest = class {
  constructor() {
    console.warn('[WORKER] Network access blocked - XMLHttpRequest not available in Figma worker');
    throw new Error('Network access not available in Figma plugin worker');
  }
} as any;

if (globalThis.WebSocket) {
  globalThis.WebSocket = class {
    constructor() {
      console.warn('[WORKER] Network access blocked - WebSocket not available in Figma worker');
      throw new Error('Network access not available in Figma plugin worker');
    }
  } as any;
}

// Set up the __html__ global that code.ts expects
(globalThis as any).__html__ = '<div>Plugin UI HTML content</div>';

// Add localStorage polyfill for worker environment
// Bridge to host's real localStorage to persist across refresh
let nextRequestId = 0;
const pendingStorageRequests = new Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>();

function sendStorageRequest(operation: string, key?: string, value?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingStorageRequests.set(id, { resolve, reject });

    postMessage({
      type: 'localStorage-bridge',
      operation,
      key,
      value,
      id
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (pendingStorageRequests.has(id)) {
        pendingStorageRequests.delete(id);
        reject(new Error(`localStorage ${operation} timeout`));
      }
    }, 5000);
  });
}

(globalThis as any).localStorage = {
  getItem(_key: string): string | null {
    // Synchronous API but internally async - use cached value or return null
    // This is a compromise since localStorage API is sync but we need async bridge
    console.warn('[WORKER] localStorage.getItem called synchronously, this may not work correctly. Use async storage methods instead.');
    return null;
  },
  setItem(_key: string, _value: string): void {
    sendStorageRequest('setItem', _key, _value).catch(err =>
      console.error('[WORKER] localStorage.setItem failed:', err)
    );
  },
  removeItem(_key: string): void {
    sendStorageRequest('removeItem', _key).catch(err =>
      console.error('[WORKER] localStorage.removeItem failed:', err)
    );
  },
  clear(): void {
    sendStorageRequest('clear').catch(err =>
      console.error('[WORKER] localStorage.clear failed:', err)
    );
  },
  get length(): number {
    console.warn('[WORKER] localStorage.length called synchronously, this may not work correctly.');
    return 0;
  },
  key(_index: number): string | null {
    console.warn('[WORKER] localStorage.key called synchronously, this may not work correctly.');
    return null;
  }
};

// Export async versions for proper usage
(globalThis as any).localStorageAsync = {
  async getItem(key: string): Promise<string | null> {
    return await sendStorageRequest('getItem', key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await sendStorageRequest('setItem', key, value);
  },
  async removeItem(key: string): Promise<void> {
    await sendStorageRequest('removeItem', key);
  },
  async clear(): Promise<void> {
    await sendStorageRequest('clear');
  },
  async length(): Promise<number> {
    return await sendStorageRequest('length');
  },
  async key(_index: number): Promise<string | null> {
    return await sendStorageRequest('key', undefined, _index);
  }
};

// Handle messages from the host
addEventListener('message', (event) => {
  const data = event.data;

  // Handle localStorage bridge responses
  if (data.type === 'localStorage-bridge-response') {
    const pending = pendingStorageRequests.get(data.id);
    if (pending) {
      pendingStorageRequests.delete(data.id);
      if (data.error) {
        pending.reject(new Error(data.error));
      } else {
        pending.resolve(data.result);
      }
    }
    return;
  }

  // Handle getPosition responses from host
  if (data.type === 'getPosition-response') {
    // Forward the response back through the worker context
    // This will be picked up by the DevImplementation.getPosition listener
    postMessage(data);
    return;
  }

  if (data.type === 'from-ui' && data.pluginMessage) {
    // Forward message from UI to code.ts via figma.ui.onmessage
    const figmaUi = (globalThis as any).figma.ui;
    if (figmaUi.onmessage) {
      figmaUi.onmessage(data.pluginMessage);
    }
  }
});

// Import and initialize code.ts
async function initializeCodeTs() {
  try {
    console.log('[WORKER] Loading code.ts...');
    await import('../widget/code.ts');
    console.log('[WORKER] code.ts loaded successfully');
    postMessage({ type: 'worker-ready' });
  } catch (error) {
    console.error('[WORKER] Failed to load code.ts:', error);
    postMessage({ 
      type: 'worker-error', 
      message: `Failed to load code.ts: ${(error as Error).message}` 
    });
  }
}

// Initialize
initializeCodeTs();
