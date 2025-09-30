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

// Handle messages from the host
addEventListener('message', (event) => {
  const data = event.data;
  
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
