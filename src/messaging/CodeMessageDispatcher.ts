import { UniversalMessageDispatcher } from './MessageDispatcher';
import { StoreMessaging } from './StoreMessaging';
import { 
  MessageCategory, 
  OperationMessageType, 
  StoreMessageType, 
  SystemMessageType,
  DrawRectangleRequest,
  ChangeColorRequest,
  CreateFrameRequest,
  StoreStateUpdateRequest,
  ErrorRequest,
  WorkerTestRequest,
  Message 
} from '@/types/messageTypes';
import { platform } from '@/platform';
import { AuthStateManagementClass } from '@/stateManagement/AuthStateManagementClass';

// Initialize everything inside an async IIFE to handle top-level await
let codeMessageDispatcher: UniversalMessageDispatcher;
let codeStoreMessaging: StoreMessaging;
let authStateManager: AuthStateManagementClass;
let commands: any;
let setupCodeMessageListener: () => void;

// Initialize async resources
(async () => {
  // Get the platform commands instance
  commands = await platform.getInstance();

  // Create a code message dispatcher
  codeMessageDispatcher = new UniversalMessageDispatcher(
    'code',
    (message) => commands.ui.postMessage(message)
  );

  // Create store messaging
  codeStoreMessaging = new StoreMessaging(codeMessageDispatcher);

  // Create and register authentication state management
  authStateManager = new AuthStateManagementClass();
  codeStoreMessaging.registerStore('authentication', authStateManager);

  // Setup message listener (this will replace the existing onmessage handler in code.ts)
  setupCodeMessageListener = () => {
    commands.ui.onmessage = async (message: Message) => {
      await codeMessageDispatcher.handleMessage(message);
    };
  };

  // Register operation handlers
  codeMessageDispatcher.registerHandler(
  MessageCategory.OPERATION,
  OperationMessageType.DRAW_RECTANGLE,
  async (request: DrawRectangleRequest) => {
    const { x, y, width, height, color } = request.payload;
    const rect = commands.createRectangle();
    rect.x = x;
    rect.y = y;
    rect.resize(width, height);
    if (color) {
      rect.fills = [{ type: 'SOLID', color }];
    }
    console.log('Rectangle created:', rect.id);
    
    // Return structured response
    return {
      nodeId: rect.id,
      created: true,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  }
);

codeMessageDispatcher.registerHandler(
  MessageCategory.OPERATION,
  OperationMessageType.CHANGE_COLOR,
  async (request: ChangeColorRequest) => {
    const { nodeId, color } = request.payload;
    const node = await commands.getNodeByIdAsync(nodeId);
    if (node && 'fills' in node) {
      node.fills = [{ type: 'SOLID', color }];
      console.log('Color changed for node:', nodeId);
      
      // Return structured response
      return {
        nodeId,
        colorChanged: true,
        color
      };
    } else {
      throw new Error(`Node ${nodeId} not found or doesn't support fills`);
    }
  }
);

codeMessageDispatcher.registerHandler(
  MessageCategory.OPERATION,
  OperationMessageType.CREATE_FRAME,
  async (request: CreateFrameRequest) => {
    const frame = commands.createFrame();
    const { x, y, width, height, name } = request.payload;
    
    if (x !== undefined) frame.x = x || 0;
    if (y !== undefined) frame.y = y || 0;
    if (width !== undefined && height !== undefined) {
      frame.resize(width || 100, height || 100);
    }
    if (name) frame.name = name;
    
    console.log('Frame created:', frame.id);
    
    // Return structured response
    return {
      frameId: frame.id,
      created: true,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      name: frame.name
    };
  }
);

// Register store handlers
codeMessageDispatcher.registerHandler(
  MessageCategory.STORE,
  StoreMessageType.STATE_UPDATE,
  async (request: StoreStateUpdateRequest) => {
    console.log(`Store ${request.storeId} updated:`, request.payload);
    
    // Return structured response
    return {
      storeId: request.storeId,
      updated: true,
      payload: request.payload
    };
  }
);

// Register system handlers
codeMessageDispatcher.registerHandler(
  MessageCategory.SYSTEM,
  SystemMessageType.ERROR,
  async (request: ErrorRequest) => {
    console.error('System error in code.ts:', request.payload.message, request.payload.details);
    
    // Return structured response
    return {
      logged: true,
      handled: true
    };
  }
);

  codeMessageDispatcher.registerHandler(
    MessageCategory.SYSTEM,
    SystemMessageType.WORKER_TEST,
    async (request: WorkerTestRequest) => {
      console.log('[CODE] Worker test message received:', request.payload.message);
      console.log('[CODE] Full request payload:', request.payload);
      
      // Return structured response
      return {
        received: true,
        echoed: `Code received: "${request.payload.message}"`,
        processedBy: 'code' as const
      };
    }
  );
})();

// Export the initialized instances (they will be available after initPromise resolves)
export { codeMessageDispatcher, codeStoreMessaging, authStateManager, setupCodeMessageListener };