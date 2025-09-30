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
    // console.log('Forwarding worker → iframe:', event.data);
    iframe.contentWindow?.postMessage(event.data, '*');
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

