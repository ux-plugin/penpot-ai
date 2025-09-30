import { UniversalMessageDispatcher } from './MessageDispatcher';
import { StoreMessaging } from './StoreMessaging';
import { 
  MessageCategory, 
  OperationMessageType, 
  SystemMessageType, 
  DrawRectangleRequest,
  ErrorRequest,
  WorkerTestRequest
} from '@/types/messageTypes';
// Create UI message dispatcher
export const uiMessageDispatcher = new UniversalMessageDispatcher(
  'ui',
  (message) => parent.postMessage({ pluginMessage: message }, '*')
);

// Create store messaging
export const uiStoreMessaging = new StoreMessaging(uiMessageDispatcher);

// Function to initialize store registrations (called after stores are ready)
export const initializeStoreRegistrations = () => {
  // This will be called from the store modules after they're initialized
  // to avoid circular dependency issues
};

// Setup message listener
window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage;
  if (message) {
    uiMessageDispatcher.handleMessage(message);
  }
};

// Register operation handlers
uiMessageDispatcher.registerHandler(
  MessageCategory.OPERATION,
  OperationMessageType.DRAW_RECTANGLE,
  async (request: DrawRectangleRequest) => {
    console.log('Drawing rectangle request received:', request.payload);
    // Return a response result
    return {
      nodeId: 'ui-mock-node-id',
      created: true,
      x: request.payload.x,
      y: request.payload.y,
      width: request.payload.width,
      height: request.payload.height
    };
  }
);

// Register system handlers
uiMessageDispatcher.registerHandler(
  MessageCategory.SYSTEM,
  SystemMessageType.ERROR,
  async (request: ErrorRequest) => {
    console.error('System error:', request.payload.message, request.payload.details);
    // Return a response result
    return {
      logged: true,
      handled: true
    };
  }
);

uiMessageDispatcher.registerHandler(
  MessageCategory.SYSTEM,
  SystemMessageType.WORKER_TEST,
  async (request: WorkerTestRequest) => {
    console.log('[UI] Worker test message received:', request.payload.message);
    console.log('[UI] Full request payload:', request.payload);
    // Return a response result
    return {
      received: true,
      echoed: `UI received: "${request.payload.message}"`,
      processedBy: 'ui' as const
    };
  }
);