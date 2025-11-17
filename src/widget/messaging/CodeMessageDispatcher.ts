import { UniversalMessageDispatcher } from '@shared-core/messaging/MessageDispatcher';
import { StoreMessaging } from '@shared-core/messaging/StoreMessaging';
import { 
  MessageCategory, 
  OperationMessageType, 
  SystemMessageType,
  DrawRectangleRequest,
  DrawRectangleResponse,
  ChangeColorRequest,
  ChangeColorResponse,
  CreateFrameRequest,
  CreateFrameResponse,
  ErrorRequest,
  ErrorResponse,
  WorkerTestRequest,
  WorkerTestResponse,
  ResizeRequest,
  ResizeResponse,
  GetPositionRequest,
  GetPositionResponse,
  Message,
  ExtractResultType
} from '@shared-core/types/messageTypes';
import { platform } from '@widget/platform';
import { IDesignPlatform } from '@widget/platform/IDesignPlatform';
import { AuthStateManagementClass } from '@widget/stores/AuthStateManagementClass';

// Initialize everything inside an async IIFE to handle top-level await
let codeMessageDispatcher: UniversalMessageDispatcher;
let codeStoreMessaging: StoreMessaging;
let authStateManager: AuthStateManagementClass;
let commands: IDesignPlatform;
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
  authStateManager = new AuthStateManagementClass(commands);
  codeStoreMessaging.registerStore('authentication', authStateManager);

  // Setup message listener (this will replace the existing onmessage handler in code.ts)
  setupCodeMessageListener = () => {
    commands.ui.onmessage = async (message: Message) => {
      await codeMessageDispatcher.handleMessage(message);
    };
  };

  // Register operation handlers with enhanced type safety
  codeMessageDispatcher.registerHandler<
    DrawRectangleRequest, 
    ExtractResultType<DrawRectangleResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.DRAW_RECTANGLE,
    async (request: DrawRectangleRequest): Promise<ExtractResultType<DrawRectangleResponse>> => {
      const { x, y, width, height, color } = request.payload;
      const rect = commands.createRectangle();
      rect.x = x;
      rect.y = y;
      rect.resize(width, height);
      if (color) {
        rect.fills = [{ type: 'SOLID', color }];
      }
      console.log('Rectangle created:', rect.id);
      
      // Return structured response with exact type
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

codeMessageDispatcher.registerHandler<
    ChangeColorRequest,
    ExtractResultType<ChangeColorResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.CHANGE_COLOR,
    async (request: ChangeColorRequest): Promise<ExtractResultType<ChangeColorResponse>> => {
      const { nodeId, color } = request.payload;
      const node = await commands.getNodeByIdAsync(nodeId);
      if (node && 'fills' in node) {
        node.fills = [{ type: 'SOLID', color }];
        console.log('Color changed for node:', nodeId);
        
        // Return structured response with exact type
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

codeMessageDispatcher.registerHandler<
    CreateFrameRequest,
    ExtractResultType<CreateFrameResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.CREATE_FRAME,
    async (request: CreateFrameRequest): Promise<ExtractResultType<CreateFrameResponse>> => {
      const frame = commands.createFrame();
      const { x, y, width, height, name } = request.payload;
      
      if (x !== undefined) frame.x = x || 0;
      if (y !== undefined) frame.y = y || 0;
      if (width !== undefined && height !== undefined) {
        frame.resize(width || 100, height || 100);
      }
      if (name) frame.name = name;
      
      console.log('Frame created:', frame.id);
      
      // Return structured response with exact type
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


// Register system handlers with enhanced type safety
codeMessageDispatcher.registerHandler<
    ErrorRequest,
    ExtractResultType<ErrorResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.ERROR,
    async (request: ErrorRequest): Promise<ExtractResultType<ErrorResponse>> => {
      console.error('System error in code.ts:', request.payload.message, request.payload.details);
      
      // Return structured response with exact type
      return {
        logged: true,
        handled: true
      };
    }
  );

  codeMessageDispatcher.registerHandler<
    WorkerTestRequest,
    ExtractResultType<WorkerTestResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.WORKER_TEST,
    async (request: WorkerTestRequest): Promise<ExtractResultType<WorkerTestResponse>> => {
      console.log('[CODE] Worker test message received:', request.payload.message);
      console.log('[CODE] Full request payload:', request.payload);
      
      // Return structured response with exact type
      return {
        received: true,
        echoed: `Code received: "${request.payload.message}"`,
        processedBy: 'code' as const
      };
    }
  );

  codeMessageDispatcher.registerHandler<
    ResizeRequest,
    ExtractResultType<ResizeResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.RESIZE,
    async (request: ResizeRequest): Promise<ExtractResultType<ResizeResponse>> => {
      const { width, height, x, y } = request.payload;
      console.log('[CODE] Resize request received:', { width, height, x, y });
      
      // Call the platform-specific resize method
      commands.ui.resize(width, height);
      
      // If position is provided, reposition the window
      if (x !== undefined && y !== undefined) {
        commands.ui.reposition(x, y);
      }
      
      // Return structured response with exact type
      return {
        resized: true,
        width,
        height,
        x,
        y
      };
    }
  );

  codeMessageDispatcher.registerHandler<
    GetPositionRequest,
    ExtractResultType<GetPositionResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.GET_POSITION,
    async (_: GetPositionRequest): Promise<ExtractResultType<GetPositionResponse>> => {
      console.log('[CODE] GetPosition request received');
      
      // Call the platform-specific getPosition method
      const position = await commands.ui.getPosition();
      
      console.log('[CODE] Position retrieved:', position);
      
      // Return structured response with exact type
      return position;
    }
  );
})();

// Export the initialized instances (they will be available after initPromise resolves)
export { codeMessageDispatcher, codeStoreMessaging, authStateManager, setupCodeMessageListener };
