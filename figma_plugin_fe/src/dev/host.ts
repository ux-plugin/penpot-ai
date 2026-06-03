// Host script that bridges communication between UI (iframe) and code.ts (worker)


function updateWorkerStatus(message: string, isError: boolean = false) {
  const status = document.getElementById('worker-status');
  if (status) {
    status.textContent = message;
    status.className = `status ${isError ? 'error' : 'success'}`;
  }
}

function updateUIStatus(message: string, isError: boolean = false) {
  const status = document.getElementById('ui-status');
  if (status) {
    status.textContent = message;
    status.className = `status ${isError ? 'error' : 'success'}`;
  }
}

function initWorker() {
  let worker: Worker;
  try {
    updateWorkerStatus('Starting worker...');
    
    // Create the worker
    worker = new Worker(new URL('./worker.ts', import.meta.url), { 
      type: 'module' 
    });

    // Listen to messages from the worker
    worker.onmessage = (event) => {
      const data = event.data;
      
      if (data.type === 'worker-ready') {
        updateWorkerStatus('Worker ready - code.ts loaded');
        return;
      }
      
      if (data.type === 'worker-error') {
        updateWorkerStatus(`Worker error: ${data.message}`, true);
        return;
      }
    };

    worker.onerror = (error) => {
      updateWorkerStatus(`Worker error: ${error.message}`, true);
      console.error('Worker error:', error);
    };

    return worker;

  } catch (error) {
    updateWorkerStatus(`Failed to create worker: ${(error as Error).message}`, true);
    console.error('Failed to create worker:', error);
  }
}

function initIframe() {
  let iframe: HTMLIFrameElement;
  iframe = document.getElementById('plugin-iframe') as HTMLIFrameElement;
  
  if (!iframe) {
    updateUIStatus('Failed to find iframe', true);
    return;
  }

  iframe.onload = () => {
    updateUIStatus('UI loaded successfully');
  };

  iframe.onerror = () => {
    updateUIStatus('Failed to load UI', true);
  };

  return iframe;
}

function wireCommunications(iframe: HTMLIFrameElement, worker: Worker) {
  // Forward messages from iframe to worker
  window.addEventListener('message', (event: MessageEvent) => {
    // Check if message came from our iframe
    if (event.source === iframe.contentWindow) {
      // console.log('Forwarding iframe → worker:', event.data);
      worker.postMessage(event.data);
    }
  });

  // Forward messages from worker to iframe
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;

    // Handle localStorage bridge messages from worker
    if (data.type === 'localStorage-bridge') {
      handleLocalStorageBridge(worker, data);
      return;
    }

    // Handle resize messages from worker (ui.resize calls from code.ts)
    if (data.type === 'resize') {
      handleResize(data);
      return;
    }

    // Handle getPosition messages from worker
    if (data.type === 'getPosition') {
      handleGetPosition(worker, data);
      return;
    }

    // Handle reposition messages from worker (ui.reposition calls from code.ts)
    if (data.type === 'reposition') {
      handleReposition(data);
      return;
    }

    // console.log('Forwarding worker → iframe:', event.data);
    iframe.contentWindow?.postMessage(event.data, '*');
  });
}

function handleLocalStorageBridge(worker: Worker, message: any) {
  const { operation, key, value, id } = message;
  let result: any = null;
  let error: string | null = null;

  try {
    switch (operation) {
      case 'getItem':
        result = localStorage.getItem(key);
        break;
      case 'setItem':
        localStorage.setItem(key, value);
        result = true;
        break;
      case 'removeItem':
        localStorage.removeItem(key);
        result = true;
        break;
      case 'clear':
        localStorage.clear();
        result = true;
        break;
      case 'length':
        result = localStorage.length;
        break;
      case 'key':
        result = localStorage.key(value); // value contains the index
        break;
      default:
        error = `Unknown operation: ${operation}`;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // Send response back to worker
  worker.postMessage({
    type: 'localStorage-bridge-response',
    id,
    result,
    error
  });
}

function handleResize(message: any) {
  const { width, height } = message;
  
  console.log('[HOST] Handling resize request:', { width, height });
  
  // Get the plugin window element
  const pluginWindow = document.getElementById('plugin-window');
  
  if (!pluginWindow) {
    console.error('[HOST] Plugin window not found');
    return;
  }
  
  // Apply minimum size constraints
  const minWidth = 300;
  const minHeight = 200;
  const constrainedWidth = Math.max(width, minWidth);
  const constrainedHeight = Math.max(height, minHeight);
  
  // Update the plugin window dimensions
  pluginWindow.style.width = constrainedWidth + 'px';
  pluginWindow.style.height = constrainedHeight + 'px';
  
  console.log('[HOST] Resized plugin window to:', { 
    width: constrainedWidth, 
    height: constrainedHeight 
  });
}

function handleReposition(message: any) {
  const { x, y } = message;
  
  console.log('[HOST] Handling reposition request:', { x, y });
  
  // Get the plugin window element
  const pluginWindow = document.getElementById('plugin-window');
  
  if (!pluginWindow) {
    console.error('[HOST] Plugin window not found');
    return;
  }
  
  // Keep window within viewport bounds
  const maxX = window.innerWidth - pluginWindow.offsetWidth;
  const maxY = window.innerHeight - pluginWindow.offsetHeight;
  
  const constrainedX = Math.max(0, Math.min(x, maxX));
  const constrainedY = Math.max(0, Math.min(y, maxY));
  
  // Update position
  pluginWindow.style.left = constrainedX + 'px';
  pluginWindow.style.top = constrainedY + 'px';
  pluginWindow.style.right = 'auto'; // Override the CSS right positioning
  
  console.log('[HOST] Repositioned plugin window to:', { 
    x: constrainedX, 
    y: constrainedY 
  });
}

function handleGetPosition(worker: Worker, message: any) {
  const { requestId } = message;
  
  console.log('[HOST] Handling getPosition request:', requestId);
  
  // Get the plugin window element
  const pluginWindow = document.getElementById('plugin-window');
  
  if (!pluginWindow) {
    console.error('[HOST] Plugin window not found');
    worker.postMessage({
      type: 'getPosition-response',
      requestId,
      position: {
        windowSpace: { x: 0, y: 0 },
        canvasSpace: { x: 0, y: 0 }
      }
    });
    return;
  }
  
  // Get the bounding rect to get accurate position
  const rect = pluginWindow.getBoundingClientRect();
  
  const position = {
    windowSpace: { x: rect.left, y: rect.top },
    canvasSpace: { x: rect.left, y: rect.top } // Same as windowSpace in dev environment
  };
  
  console.log('[HOST] Sending position:', position);
  
  // Send response back to worker
  worker.postMessage({
    type: 'getPosition-response',
    requestId,
    position
  });
}

// Initialize everything when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('[HOST] Initializing Figma plugin development environment');
  let worker = initWorker();
  let iframe = initIframe();
  if (!worker || !iframe) {
    console.error('[HOST] Failed to initialize Figma plugin development environment');
    return;
  }
  wireCommunications(iframe, worker)

  window.addEventListener('beforeunload', () => {
    if (worker) {
      worker.terminate();
    }
  });
});
