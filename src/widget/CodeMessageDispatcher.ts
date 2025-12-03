import { UniversalMessageDispatcher } from '@/messaging/messaging/MessageDispatcher.ts';
import { StoreMessaging } from '@/messaging/messaging/StoreMessaging.ts';
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
  GetNodesUnderUIRequest,
  GetNodesUnderUIResponse,
  Message,
  ExtractResultType
} from '@shared-types/messageTypes.ts';
import { platform } from '@widget/platform';
import { IDesignPlatform } from '@widget/platform/IDesignPlatform.ts';
import { AuthStateManagementClass } from '@widget/stores/AuthStateManagementClass.ts';

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

  codeMessageDispatcher.registerHandler<
    GetNodesUnderUIRequest,
    ExtractResultType<GetNodesUnderUIResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.GET_NODES_UNDER_UI,
    async (request: GetNodesUnderUIRequest): Promise<ExtractResultType<GetNodesUnderUIResponse>> => {
      console.log('[CODE] GetNodesUnderUI request received');
      
      // Get UI position in canvas space
      const position = await commands.ui.getPosition();
      console.log('[CODE] UI position:', position);
      
      // Get UI dimensions from the request payload (in screen pixels)
      const screenWidth = request.payload.width;
      const screenHeight = request.payload.height;
      console.log('[CODE] UI dimensions in screen pixels:', { screenWidth, screenHeight });
      
      // Get the current viewport zoom level
      const zoom = commands.viewport.zoom;
      console.log('[CODE] Current viewport zoom:', zoom);
      
      // Convert screen pixels to canvas units using zoom
      // Formula: canvasUnits = screenPixels / zoom
      const canvasWidth = screenWidth / zoom;
      const canvasHeight = screenHeight / zoom;
      console.log('[CODE] UI dimensions in canvas units:', { canvasWidth, canvasHeight });
      
      // Calculate the UI region in canvas space
      const uiRegion = {
        x: position.canvasSpace.x,
        y: position.canvasSpace.y,
        width: canvasWidth,
        height: canvasHeight
      };
      
      console.log('[CODE] UI region in canvas space:', uiRegion);
      
      // Function to check if a node intersects with the UI region
      const isNodeInUIRegion = (node: any): boolean => {
        if (!node || typeof node.x !== 'number' || typeof node.y !== 'number') {
          return false;
        }
        
        const nodeRight = node.x + (node.width || 0);
        const nodeBottom = node.y + (node.height || 0);
        const regionRight = uiRegion.x + uiRegion.width;
        const regionBottom = uiRegion.y + uiRegion.height;
        
        // Check if the node's bounding box intersects with the UI region
        return !(
          nodeRight < uiRegion.x ||
          node.x > regionRight ||
          nodeBottom < uiRegion.y ||
          node.y > regionBottom
        );
      };
      
      // Collect nodes that are under the UI
      const nodesUnderUI: Array<{
        id: string;
        type: string;
        name: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];
      
      // Iterate through all children of the current page
      const pageChildren = commands.currentPage.children as any[];
      for (const node of pageChildren) {
        console.log(`[CODE] Checking node ${node.id || 'unnamed'}...`);
        console.log(`[CODE] Node position: ${node.x}, ${node.y}`);
        console.log(`[CODE] Node dimensions: ${isNodeInUIRegion(node)}`);
        if (isNodeInUIRegion(node)) {
          nodesUnderUI.push({
            id: node.id || '',
            type: node.type || 'UNKNOWN',
            name: node.name || 'Unnamed',
            x: node.x || 0,
            y: node.y || 0,
            width: node.width || 0,
            height: node.height || 0
          });
        }
      }
      
      console.log(`[CODE] Found ${nodesUnderUI.length} nodes under UI`);
      
      // Return structured response with exact type
      return {
        nodes: nodesUnderUI,
        totalCount: nodesUnderUI.length,
        uiRegion: {
          x: uiRegion.x,
          y: uiRegion.y,
          width: uiRegion.width,
          height: uiRegion.height
        }
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
