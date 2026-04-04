import { UniversalMessageDispatcher } from "@/shared/messaging/MessageDispatcher.ts";
import { StoreMessaging } from "@/shared/messaging/StoreMessaging.ts";
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
  SyncCanvasRequest,
  SyncCanvasResponse,
  UpdateViewportRequest,
  UpdateViewportResponse,
  GetViewportBoundsRequest,
  GetViewportBoundsResponse,
  GetAllNodesRequest,
  GetAllNodesResponse,
  ExportNodeSVGsRequest,
  ExportNodeSVGsResponse,
  RequestPenpotPageRequest,
  RequestPenpotPageResponse,
  SetFigmaSelectionRequest,
  SetFigmaSelectionResponse,
  Message,
  ExtractResultType,
} from "@shared-types/messageTypes.ts";
import { translatePage, reverseLookupFigmaId } from "penpot-exporter/figma-adapter";
import { markIgnoreNextSelectionChange } from "@widget/selectionSyncGuard.ts";
import { platform } from "@widget/platform";
import { IDesignPlatform } from "@widget/platform/IDesignPlatform.ts";
import { AuthStateManagementClass } from "@widget/stores/AuthStateManagementClass.ts";

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
  codeMessageDispatcher = new UniversalMessageDispatcher("code", (message) =>
    commands.ui.postMessage(message),
  );

  // Create store messaging
  codeStoreMessaging = new StoreMessaging(codeMessageDispatcher);

  // Create and register authentication state management
  authStateManager = new AuthStateManagementClass(commands);
  codeStoreMessaging.registerStore("authentication", authStateManager);

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
    async (
      request: DrawRectangleRequest,
    ): Promise<ExtractResultType<DrawRectangleResponse>> => {
      const { x, y, width, height, color } = request.payload;
      const rect = commands.createRectangle();
      rect.x = x;
      rect.y = y;
      rect.resize(width, height);
      if (color) {
        rect.fills = [{ type: "SOLID", color }];
      }

      // Return structured response with exact type
      return {
        nodeId: rect.id,
        created: true,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    ChangeColorRequest,
    ExtractResultType<ChangeColorResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.CHANGE_COLOR,
    async (
      request: ChangeColorRequest,
    ): Promise<ExtractResultType<ChangeColorResponse>> => {
      const { nodeId, color } = request.payload;
      const node = await commands.getNodeByIdAsync(nodeId);
      if (node && "fills" in node) {
        node.fills = [{ type: "SOLID", color }];

        // Return structured response with exact type
        return {
          nodeId,
          colorChanged: true,
          color,
        };
      } else {
        throw new Error(`Node ${nodeId} not found or doesn't support fills`);
      }
    },
  );

  codeMessageDispatcher.registerHandler<
    CreateFrameRequest,
    ExtractResultType<CreateFrameResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.CREATE_FRAME,
    async (
      request: CreateFrameRequest,
    ): Promise<ExtractResultType<CreateFrameResponse>> => {
      const frame = commands.createFrame();
      const { x, y, width, height, name } = request.payload;

      if (x !== undefined) frame.x = x || 0;
      if (y !== undefined) frame.y = y || 0;
      if (width !== undefined && height !== undefined) {
        frame.resize(width || 100, height || 100);
      }
      if (name) frame.name = name;

      // Return structured response with exact type
      return {
        frameId: frame.id,
        created: true,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        name: frame.name,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    GetNodesUnderUIRequest,
    ExtractResultType<GetNodesUnderUIResponse>
  >(
    MessageCategory.OPERATION,
    OperationMessageType.GET_NODES_UNDER_UI,
    async (
      request: GetNodesUnderUIRequest,
    ): Promise<ExtractResultType<GetNodesUnderUIResponse>> => {
      // Get UI position in canvas space
      const position = await commands.ui.getPosition();

      // Get UI dimensions from the request payload (in screen pixels)
      const screenWidth = request.payload.width;
      const screenHeight = request.payload.height;

      // Get the current viewport zoom level
      const zoom = commands.viewport.zoom;

      // Convert screen pixels to canvas units using zoom
      // Formula: canvasUnits = screenPixels / zoom
      const canvasWidth = screenWidth / zoom;
      const canvasHeight = screenHeight / zoom;

      // Calculate the UI region in canvas space
      const uiRegion = {
        x: position.canvasSpace.x,
        y: position.canvasSpace.y,
        width: canvasWidth,
        height: canvasHeight,
      };

      // Function to check if a node intersects with the UI region
      const isNodeInUIRegion = (node: any): boolean => {
        if (!node || typeof node.x !== "number" || typeof node.y !== "number") {
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
        if (isNodeInUIRegion(node)) {
          nodesUnderUI.push({
            id: node.id || "",
            type: node.type || "UNKNOWN",
            name: node.name || "Unnamed",
            x: node.x || 0,
            y: node.y || 0,
            width: node.width || 0,
            height: node.height || 0,
          });
        }
      }

      // Return structured response with exact type
      return {
        nodes: nodesUnderUI,
        totalCount: nodesUnderUI.length,
        uiRegion: {
          x: uiRegion.x,
          y: uiRegion.y,
          width: uiRegion.width,
          height: uiRegion.height,
        },
      };
    },
  );

  // Register system handlers with enhanced type safety
  codeMessageDispatcher.registerHandler<
    ErrorRequest,
    ExtractResultType<ErrorResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.ERROR,
    async (
      request: ErrorRequest,
    ): Promise<ExtractResultType<ErrorResponse>> => {
      console.error(
        "System error in code.ts:",
        request.payload.message,
        request.payload.details,
      );

      // Return structured response with exact type
      return {
        logged: true,
        handled: true,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    WorkerTestRequest,
    ExtractResultType<WorkerTestResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.WORKER_TEST,
    async (
      request: WorkerTestRequest,
    ): Promise<ExtractResultType<WorkerTestResponse>> => {
      // Return structured response with exact type
      return {
        received: true,
        echoed: `Code received: "${request.payload.message}"`,
        processedBy: "code" as const,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    ResizeRequest,
    ExtractResultType<ResizeResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.RESIZE,
    async (
      request: ResizeRequest,
    ): Promise<ExtractResultType<ResizeResponse>> => {
      const { width, height, x, y } = request.payload;

      // Call the platform-specific resize method
      const now = Date.now();
      commands.ui.resize(width, height);
      const endTime = Date.now();
      const duration = endTime - now;
      console.log("[CODE] Resize request completed in", duration, "ms");

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
        y,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    GetPositionRequest,
    ExtractResultType<GetPositionResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.GET_POSITION,
    async (
      _: GetPositionRequest,
    ): Promise<ExtractResultType<GetPositionResponse>> => {
      // Call the platform-specific getPosition method
      const position = await commands.ui.getPosition();

      // Return structured response with exact type
      return position;
    },
  );

  codeMessageDispatcher.registerHandler<
    SyncCanvasRequest,
    ExtractResultType<SyncCanvasResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.SYNC_CANVAS,
    async (
      _: SyncCanvasRequest,
    ): Promise<ExtractResultType<SyncCanvasResponse>> => {
      // Get UI position in both window space and canvas space
      const position = await commands.ui.getPosition();

      // Get viewport zoom level
      const zoom = commands.viewport.zoom;

      // Adjust for the platform-specific header bar above the iframe content area.
      // canvasSpace gives the window's top-left in canvas coordinates; shift down
      // by the header height (converted to canvas units) to get the content origin.
      const headerHeightInCanvasUnits = commands.uiHeaderHeight / zoom;

      // Calculate the adjusted canvas position (where the canvas should start)
      const canvasPosition = {
        x: position.canvasSpace.x,
        y: position.canvasSpace.y + headerHeightInCanvasUnits,
      };

      // Return structured response with exact type
      return {
        canvasPosition,
        zoom,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    RequestPenpotPageRequest,
    ExtractResultType<RequestPenpotPageResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.REQUEST_PENPOT_PAGE,
    async (
      _: RequestPenpotPageRequest,
    ): Promise<ExtractResultType<RequestPenpotPageResponse>> => {
      try {
        const page = await translatePage(commands.currentPage as PageNode);
        return { page: (page ?? null) as unknown as Record<string, unknown> };
      } catch (err) {
        console.warn(
          "[CodeMessageDispatcher] REQUEST_PENPOT_PAGE failed:",
          err,
        );
        return { page: null as unknown as Record<string, unknown> };
      }
    },
  );

  // Set Figma selection from plugin canvas (UI → code)
  codeMessageDispatcher.registerHandler<
    SetFigmaSelectionRequest,
    ExtractResultType<SetFigmaSelectionResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.SET_FIGMA_SELECTION,
    async (
      request: SetFigmaSelectionRequest,
    ): Promise<ExtractResultType<SetFigmaSelectionResponse>> => {
      const { penpotIds } = request.payload;

      const figmaNodes: unknown[] = [];
      for (const penpotId of penpotIds) {
        const figmaId = reverseLookupFigmaId(penpotId);
        if (figmaId) {
          try {
            const node = await commands.getNodeByIdAsync(figmaId);
            if (node) figmaNodes.push(node);
          } catch {
            // Node may have been deleted
          }
        }
      }

      markIgnoreNextSelectionChange();
      commands.currentPage.setSelection?.(figmaNodes);

      return { handled: true };
    },
  );

  codeMessageDispatcher.registerHandler<
    UpdateViewportRequest,
    ExtractResultType<UpdateViewportResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.UPDATE_VIEWPORT,
    async (
      request: UpdateViewportRequest,
    ): Promise<ExtractResultType<UpdateViewportResponse>> => {
      const { transform, zoom, zoomFocalPoint } = request.payload;
      const oldZoom = commands.viewport.zoom;
      const { x: current_x, y: current_y } = commands.viewport.center;

      let new_center: { x: number; y: number };

      if (zoomFocalPoint) {
        // This is a zoom operation with a focal point
        // Calculate new center to keep the focal point fixed on screen
        // Formula: new_center = focal_point + (old_center - focal_point) * (old_zoom / new_zoom)
        const zoomRatio = oldZoom / zoom;
        new_center = {
          x: zoomFocalPoint.x + (current_x - zoomFocalPoint.x) * zoomRatio,
          y: zoomFocalPoint.y + (current_y - zoomFocalPoint.y) * zoomRatio,
        };
      } else {
        // This is a pan operation (no zoom change or no focal point)
        // Transform is already in canvas-space coordinates, add directly to center
        new_center = { x: current_x + transform.x, y: current_y + transform.y };
      }

      // Update Figma viewport center and zoom
      commands.viewport.zoom = zoom;
      commands.viewport.center = new_center;

      // Return structured response with exact type
      return {
        updated: true,
        center: commands.viewport.center,
        zoom: commands.viewport.zoom,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    GetViewportBoundsRequest,
    ExtractResultType<GetViewportBoundsResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.GET_VIEWPORT_BOUNDS,
    async (
      _: GetViewportBoundsRequest,
    ): Promise<ExtractResultType<GetViewportBoundsResponse>> => {
      // Get viewport bounds, center, and zoom
      const bounds = commands.viewport.bounds;
      const center = commands.viewport.center;
      const zoom = commands.viewport.zoom;

      // Return structured response with exact type
      return {
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        center: { x: center.x, y: center.y },
        zoom,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    GetAllNodesRequest,
    ExtractResultType<GetAllNodesResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.GET_ALL_NODES,
    async (
      request: GetAllNodesRequest,
    ): Promise<ExtractResultType<GetAllNodesResponse>> => {
      console.log("[CODE] GetAllNodes request received", {
        includeSVG: request.payload.includeSVG,
      });

      // Get all nodes from the platform implementation (with optional SVG)
      const nodes = await commands.getAllNodes(
        request.payload.includeSVG ?? false,
      );

      // Return structured response with exact type
      return {
        nodes,
        totalCount: nodes.length,
      };
    },
  );

  codeMessageDispatcher.registerHandler<
    ExportNodeSVGsRequest,
    ExtractResultType<ExportNodeSVGsResponse>
  >(
    MessageCategory.SYSTEM,
    SystemMessageType.EXPORT_NODE_SVGS,
    async (
      request: ExportNodeSVGsRequest,
    ): Promise<ExtractResultType<ExportNodeSVGsResponse>> => {
      console.log("[CODE] ExportNodeSVGs request received", {
        nodeIds: request.payload.nodeIds.length,
      });

      // Export SVGs in parallel using the platform implementation
      if (commands.exportNodeSVGs) {
        const svgs = await commands.exportNodeSVGs(request.payload.nodeIds);
        return {
          svgs,
        };
      } else {
        // Fallback: return empty array if method not available
        console.warn("[CODE] exportNodeSVGs not available on platform");
        return {
          svgs: request.payload.nodeIds.map((nodeId) => ({
            nodeId,
            svg: null,
          })),
        };
      }
    },
  );
})();

// Export the initialized instances (they will be available after initPromise resolves)
export {
  codeMessageDispatcher,
  codeStoreMessaging,
  authStateManager,
  setupCodeMessageListener,
};
