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
  Viewport,
  Edge,
} from "@xyflow/react";
import '@xyflow/react/dist/style.css';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { loadAllNodes } from '@/plugin-ui/utils/loadNodes';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportResponse,
  UpdateViewportRequest,
} from "@shared-types/messageTypes";
import {
  ReactFlowFrameNode,
  ReactFlowTextNode,
  ReactFlowSVGNode,
} from "@/plugin-ui/components/nodes";
import { DesignNode } from "@shared-types/types.ts";

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
  const [nodes, setNodes, onNodesChange] = useNodesState<DesignNode>([]);
  const [edges, , onEdgesChange] = useEdgesState<Edge>([]);
  const currentViewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 } as Viewport);
  const reactFlowInstance = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const hasSynced = useRef(false);
  const firstSyncRef = useRef(true);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);
  const lastMousePosition = useRef<{ x: number; y: number } | null>(null);

  const nodeTypes = React.useMemo(() => ({
    figmaNode: ReactFlowFrameNode,
    textNode: ReactFlowTextNode,
    svgNode: ReactFlowSVGNode
  }), []);

  // Load all nodes from Figma (SVGs are loaded lazily by individual node components)
  const loadNodes = useCallback(async () => {
    try {
      // Load nodes with basic properties only (fast, no SVG)
      // SVGs will be loaded on-demand by individual node components when they render
      console.log('[ReactFlowCanvas] Loading nodes with basic properties...');
      const result = await loadAllNodes(false);

      const newNodes = result.nodes.map((node) => {
        // Ensure nodes are selectable
        node.selectable = true;
        return node;
      });

      // Render nodes immediately with basic properties
      // Nodes with renderMode === 'svg' will request their SVG via useLazySVG hook
      setNodes(newNodes);
      console.log(`[ReactFlowCanvas] ${newNodes.length} nodes rendered with basic properties. SVGs will load on-demand.`);

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
      return;
    }

    // Only sync to Figma when cursor is inside the screen
    if (!isCursorInsideRef.current) {
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
      } catch (error) {
        console.error('[ReactFlowCanvas] Failed to update Figma viewport:', error);
      }
    })();
  }, [reactFlowInstance]);

  // Load all nodes on mount
  useEffect(() => {
    loadNodes();
  }, [loadNodes]);

  // Sync canvas position on mount
  useEffect(() => {
    const performSync = async () => {
      if (!hasSynced.current && reactFlowInstance) {
        try {
          const newViewport = await syncCanvasWithFigma()

          reactFlowInstance.setViewport(newViewport);
          currentViewport.current = newViewport;
          hasSynced.current = true;
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
        reactFlowInstance.setViewport(newViewport);
        currentViewport.current = newViewport;
        hasSynced.current = true;
      } catch (error) {
        console.error('[ReactFlowCanvas] Failed to sync on mouse enter:', error);
      } finally {
        isSyncingFromFigma.current = false;
      }
    };

    const handleMouseLeave = () => {
      isCursorInsideRef.current = false;

      // Start periodic sync when cursor leaves the window
      if (!syncIntervalRef.current && reactFlowInstance) {
        syncIntervalRef.current = setInterval(async () => {
          try {
            // Set flag to prevent onMove from updating Figma during sync
            isSyncingFromFigma.current = true;
            const newViewport = await syncCanvasWithFigma()
            reactFlowInstance.setViewport(newViewport);
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
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow<DesignNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMove={handleMove}
        fitView={false}
        minZoom={0.02}
        maxZoom={256}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="#d1d5db"
        />
        <Controls
          position="bottom-left"
          className="rounded-lg border border-gray-200 bg-white shadow-sm"
        />
        <MiniMap
          position="bottom-right"
          className="rounded-lg border border-gray-200 bg-white shadow-sm"
          nodeColor="#9ca3af"
          maskColor="rgb(0, 0, 0, 0.1)"
        />

        {/* Top-Right Panel for buttons */}
        {topRightContent && (
          <Panel position="top-right">{topRightContent}</Panel>
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
