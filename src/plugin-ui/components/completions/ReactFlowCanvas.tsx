import React, { useEffect, useRef, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  OnMove,
  useViewport,
  Viewport,
  Edge,
} from "@xyflow/react";
import '@xyflow/react/dist/style.css';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  GetViewportBoundsResponse,
  GetAllFrameNodesResponse,
  UpdateViewportResponse,
  UpdateViewportRequest,
} from "@shared-types/messageTypes";
import { Button } from '@/plugin-ui/components/ui/button';
import {
  transformAllFramesToReactFlowNodes,
} from "@/plugin-ui/utils/createReactFlowNode";
import {
  FigmaNodeType,
  ReactFlowFrameNode,
} from "../../../../ReactFlowFrameNode.tsx";

interface ReactFlowCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
}

const ReactFlowCanvasInner: React.FC<ReactFlowCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<FigmaNodeType>([]);
  const [edges, ,onEdgesChange] = useEdgesState<Edge>([]);
  const currentViewport = useRef<Viewport>({x: 0, y:0, zoom: 1} as Viewport);
  const reactFlowInstance = useReactFlow();
  const viewport = useViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const hasSynced = useRef(false);
  const firstSyncRef = useRef(true);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);
  const lastMousePosition = useRef<{ x: number; y: number } | null>(null);

  const nodeTypes = React.useMemo(() => ({
    figmaNode: ReactFlowFrameNode
  }), []);
  // Load all nodes from Figma
  const loadAllNodes = useCallback(async () => {
    try {
      console.log('[ReactFlowCanvas] Loading all frame nodes...');
      
      const result = await uiMessageDispatcher.sendRequest<
        Omit<any, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<GetAllFrameNodesResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.GET_ALL_FRAME_NODES,
        payload: {}
      });
      
      console.log(`[ReactFlowCanvas] Received ${result.totalCount} frames from Figma`);
      
      // Transform FrameProperties to ReactFlow nodes
      const reactFlowNodes = transformAllFramesToReactFlowNodes(result.frames);
      console.log('new nodes:', reactFlowNodes)
      
      // Update nodes state
      setNodes(reactFlowNodes);
      
      console.log('[ReactFlowCanvas] Nodes loaded successfully');
    } catch (error) {
      console.error('[ReactFlowCanvas] Failed to load nodes:', error);
    }
  }, [setNodes]);

  // Handle viewport changes in ReactFlow - sync to Figma
  const handleMove = useCallback<OnMove>((_, viewport) => {
    if (!hasSynced.current) return;
    if (!reactFlowInstance) return;

    if (firstSyncRef.current) {
      firstSyncRef.current = false
      return;
    }

    // Skip sending updates to Figma if we're currently syncing FROM Figma
    // This prevents an infinite loop where periodic sync triggers onMove which triggers Figma update
    if (isSyncingFromFigma.current) {
      console.log('[ReactFlowCanvas] Skipping Figma update - syncing from Figma');
      return;
    }

    // Only sync to Figma when cursor is inside the screen
    if (!isCursorInsideRef.current) {
      console.log('[ReactFlowCanvas] Skipping Figma update - cursor outside screen');
      return;
    }

    const { x, y, zoom } = viewport;
    const oldZoom = currentViewport.current.zoom;
    
    // Detect if this is a zoom operation (zoom changed) or a pan operation (only x/y changed)
    const isZoomOperation = Math.abs(zoom - oldZoom) > 0.0001;

    // Calculate canvas positions from viewports
    // ReactFlow viewport to canvas position: canvas_x = -viewport.x / viewport.zoom
    const oldCanvasPos = {
      x: -currentViewport.current.x / currentViewport.current.zoom,
      y: -currentViewport.current.y / currentViewport.current.zoom
    };
    
    const newCanvasPos = {
      x: -x / zoom,
      y: -y / zoom
    };
    
    // Calculate delta in canvas space (zoom-independent)
    const canvasDelta = {
      x: newCanvasPos.x - oldCanvasPos.x,
      y: newCanvasPos.y - oldCanvasPos.y
    };

    // Use async IIFE to handle the async operations
    (async () => {
      try {
        let zoomFocalPoint: { x: number; y: number } | undefined;
        
        if (isZoomOperation && lastMousePosition.current && containerRef.current) {
          // Get the container's bounding rectangle
          const containerRect = containerRef.current.getBoundingClientRect();
          
          // Convert screen mouse position to position relative to ReactFlow container
          const relativeX = lastMousePosition.current.x - containerRect.left;
          const relativeY = lastMousePosition.current.y - containerRect.top;
          
          // Convert screen position to canvas coordinates using the OLD viewport
          // Formula: canvasPos = screenPos / oldZoom + topLeftCanvasPos
          const mouseFocalPointX = relativeX / oldZoom + oldCanvasPos.x;
          const mouseFocalPointY = relativeY / oldZoom + oldCanvasPos.y;
          
          zoomFocalPoint = { x: mouseFocalPointX, y: mouseFocalPointY };
          
          console.log('[ReactFlowCanvas] Zoom operation detected');
          console.log('[ReactFlowCanvas] Mouse screen pos:', lastMousePosition.current);
          console.log('[ReactFlowCanvas] Mouse canvas pos (focal point):', zoomFocalPoint);
          console.log('[ReactFlowCanvas] Zoom change:', oldZoom, '->', zoom);
        }
        
        // Send update to Figma
        await uiMessageDispatcher.sendRequest<
          Omit<UpdateViewportRequest, 'id' | 'timestamp' | 'source'>,
          ExtractResultType<UpdateViewportResponse>
        >({
          category: MessageCategory.SYSTEM,
          type: SystemMessageType.UPDATE_VIEWPORT,
          payload: {
            transform: canvasDelta,
            zoom: zoom,
            zoomFocalPoint: zoomFocalPoint
          }
        });
        currentViewport.current = viewport;
        console.log('[ReactFlowCanvas] Figma viewport updated successfully');
      } catch (error) {
        console.error('[ReactFlowCanvas] Failed to update Figma viewport:', error);
      }
    })();
  }, [reactFlowInstance]);

  // Handle print viewport bounds button click
  const handlePrintBounds = useCallback(async () => {
    try {
      const result = await uiMessageDispatcher.sendRequest<
        Omit<any, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<GetViewportBoundsResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.GET_VIEWPORT_BOUNDS,
        payload: {}
      });
      
      console.log('[ReactFlowCanvas] ========== VIEWPORT BOUNDS ==========');
      console.log('[ReactFlowCanvas] Bounds:', result.bounds);
      console.log('[ReactFlowCanvas] Center:', result.center);
      console.log('[ReactFlowCanvas] Zoom:', result.zoom);
      console.log('[ReactFlowCanvas] =====================================');
      
      // Also show as alert for user visibility
      alert(`Viewport Bounds:\n\nBounds: x=${result.bounds.x}, y=${result.bounds.y}, width=${result.bounds.width}, height=${result.bounds.height}\n\nCenter: x=${result.center.x}, y=${result.center.y}\n\nZoom: ${result.zoom}\n\nCheck console for details.`);
    } catch (error) {
      console.error('[ReactFlowCanvas] Failed to get viewport bounds:', error);
    }
  }, []);

  // Load all nodes on mount
  useEffect(() => {
    loadAllNodes();
  }, [loadAllNodes]);

  // Sync canvas position on mount
  useEffect(() => {
    const performSync = async () => {
      if (!hasSynced.current && reactFlowInstance) {
        try {
          const newViewport = await syncCanvasWithFigma()

          reactFlowInstance.setViewport( newViewport );
          currentViewport.current = newViewport;
          hasSynced.current = true;

          console.log('[ReactFlowCanvas] Canvas synced successfully on mount');
        } catch (error) {
          console.error('[ReactFlowCanvas] Failed to sync canvas on mount:', error);
        }
      }
    };

    // Wait a bit for ReactFlow to initialize
    const timeoutId = setTimeout(performSync, 100);
    return () => clearTimeout(timeoutId);
  }, [reactFlowInstance]);

  // Track mouse position for zoom focal point calculation
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      lastMousePosition.current = { x: event.clientX, y: event.clientY };
    };

    // Add mouse move listener to track cursor position
    document.addEventListener('mousemove', handleMouseMove);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  // Set up cursor enter/leave event listeners
  useEffect(() => {
    const handleMouseEnter = async () => {
      console.log('[ReactFlowCanvas] Cursor entered window - stopping periodic sync');
      isCursorInsideRef.current = true;

      // Clear the interval when cursor enters the window
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }

      // Sync canvas once when entering
      try {
        isSyncingFromFigma.current = true;
        const newViewport = await syncCanvasWithFigma()
        reactFlowInstance.setViewport( newViewport );
        currentViewport.current = newViewport;
        hasSynced.current = true;
        console.log('[ReactFlowCanvas] Canvas synced successfully on mouse enter');
      } catch (error) {
        console.error('[ReactFlowCanvas] Failed to sync on mouse enter:', error);
      } finally {
        isSyncingFromFigma.current = false;
      }
    };

    const handleMouseLeave = () => {
      console.log('[ReactFlowCanvas] Cursor left window - starting periodic sync');
      isCursorInsideRef.current = false;

      // Start periodic sync when cursor leaves the window
      if (!syncIntervalRef.current && reactFlowInstance) {
        syncIntervalRef.current = setInterval(async () => {
          try {
            // Set flag to prevent onMove from updating Figma during sync
            isSyncingFromFigma.current = true;
            const newViewport = await syncCanvasWithFigma()
            reactFlowInstance.setViewport( newViewport );
            currentViewport.current = newViewport;
            hasSynced.current = true;
          } catch (error) {
            console.error('[ReactFlowCanvas] Periodic sync failed:', error);
          } finally {
            // Always reset the flag after sync completes
            isSyncingFromFigma.current = false;
          }
        }, 1000) as unknown as number; // Sync every 1 second
      }
    };

    // Add event listeners to document to catch cursor leaving window
    document.addEventListener('mouseenter', handleMouseEnter);
    document.addEventListener('mouseleave', handleMouseLeave);

    // Cleanup
    return () => {
      document.removeEventListener('mouseenter', handleMouseEnter);
      document.removeEventListener('mouseleave', handleMouseLeave);

      // Clear interval on unmount
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [reactFlowInstance]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <ReactFlow<FigmaNodeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMove={handleMove}
        fitView={false}
        minZoom={0.02}
        maxZoom={256}
        draggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />
        <Controls
          position="bottom-left"
          className="bg-white border border-gray-200 rounded-lg shadow-sm"
        />
        <MiniMap
          position="bottom-right"
          className="bg-white border border-gray-200 rounded-lg shadow-sm"
          nodeColor="#9ca3af"
          maskColor="rgb(0, 0, 0, 0.1)"
        />
        
        {/* Viewport Coordinates Display with Node List */}
        <Panel position="bottom-center" className="bg-white/95 px-4 py-3 rounded shadow-sm text-xs font-mono max-h-[300px] overflow-y-auto">
          <div className="text-gray-700 font-semibold mb-2 border-b border-gray-300 pb-2">
            Viewport: x={viewport.x.toFixed(0)}, y={viewport.y.toFixed(0)} | Nodes: {nodes.length}
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {nodes.map((node) => (
              <div key={node.id} className="text-gray-600 text-[10px] leading-tight">
                <span className="font-semibold text-gray-800">{node.data.label}</span>
                {' → '}
                <span>x:{node.position.x.toFixed(0)}, y:{node.position.y.toFixed(0)}</span>
                {node.width && node.height && (
                  <span className="text-gray-500"> ({node.width.toFixed(0)}×{node.height.toFixed(0)})</span>
                )}
              </div>
            ))}
          </div>
        </Panel>

        {/* Top Center Buttons */}
        <Panel position="top-center">
          <div className="flex gap-2">
            <Button 
              onClick={loadAllNodes}
              variant="outline"
              size="sm"
              className="bg-white shadow-sm"
            >
              Refresh Nodes
            </Button>
            <Button 
              onClick={handlePrintBounds}
              variant="outline"
              size="sm"
              className="bg-white shadow-sm"
            >
              Print Viewport Bounds
            </Button>
          </div>
        </Panel>
        
        {/* Top-Right Panel for buttons */}
        {topRightContent && (
          <Panel position="top-right">
            {topRightContent}
          </Panel>
        )}
        
        {/* Bottom-Right Panel for help button */}
        {bottomRightContent && (
          <Panel position="bottom-right" className="mb-2">
            {bottomRightContent}
          </Panel>
        )}
        {centerRightContent && (
          <Panel position="center-right" className="mb-2">
            {centerRightContent}
          </Panel>
        )}
        {topLeftContent && (
          <Panel position="top-left" className="mb-2 h-[70%] w-[30%]">
            {topLeftContent}
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
};

export const ReactFlowCanvas: React.FC<ReactFlowCanvasProps> = (props) => {
  return (
    <ReactFlowProvider>
      <ReactFlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
};
