import { UniversalMessageDispatcher } from './MessageDispatcher';
import { StoreMessaging } from './StoreMessaging';
import { 
  MessageCategory, 
  OperationMessageType, 
  SystemMessageType, 
  DrawRectangleRequest,
  DrawRectangleResponse,
  ErrorRequest,
  ErrorResponse,
  WorkerTestRequest,
  WorkerTestResponse,
  ExtractResultType
} from '@/types/messageTypes';
// Create UI message dispatcher
export const uiMessageDispatcher = new UniversalMessageDispatcher(
  'ui',
  (message) => parent.postMessage({ pluginMessage: message }, '*')
);

// Create store messaging
export const uiStoreMessaging = new StoreMessaging(uiMessageDispatcher);

// Setup message listener
window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage;
  if (message) {
    uiMessageDispatcher.handleMessage(message);
  }
};

// Register operation handlers with enhanced type safety
uiMessageDispatcher.registerHandler<
  DrawRectangleRequest,
  ExtractResultType<DrawRectangleResponse>
>(
  MessageCategory.OPERATION,
  OperationMessageType.DRAW_RECTANGLE,
  async (request: DrawRectangleRequest): Promise<ExtractResultType<DrawRectangleResponse>> => {
    console.log('Drawing rectangle request received:', request.payload);
    // Return a response result with exact type
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

// Register system handlers with enhanced type safety
uiMessageDispatcher.registerHandler<
  ErrorRequest,
  ExtractResultType<ErrorResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.ERROR,
  async (request: ErrorRequest): Promise<ExtractResultType<ErrorResponse>> => {
    console.error('System error:', request.payload.message, request.payload.details);
    // Return a response result with exact type
    return {
      logged: true,
      handled: true
    };
  }
);

uiMessageDispatcher.registerHandler<
  WorkerTestRequest,
  ExtractResultType<WorkerTestResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.WORKER_TEST,
  async (request: WorkerTestRequest): Promise<ExtractResultType<WorkerTestResponse>> => {
    console.log('[UI] Worker test message received:', request.payload.message);
    console.log('[UI] Full request payload:', request.payload);
    // Return a response result with exact type
    return {
      received: true,
      echoed: `UI received: "${request.payload.message}"`,
      processedBy: 'ui' as const
    };
  }
);