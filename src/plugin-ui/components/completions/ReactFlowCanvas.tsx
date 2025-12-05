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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import { MessageCategory, SystemMessageType, ExtractResultType, UpdateViewportResponse, GetViewportBoundsResponse } from '@shared-types/messageTypes';
import { Button } from '@/plugin-ui/components/ui/button';

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
  const [nodes, ,onNodesChange] = useNodesState([]);
  const [edges, ,onEdgesChange] = useEdgesState([]);
  const reactFlowInstance = useReactFlow();
  const hasSynced = useRef(false);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);

  // Handle viewport changes in ReactFlow - sync to Figma
  const handleMove = useCallback<OnMove>((_, viewport) => {
    if (!reactFlowInstance) return;
    
    // Skip sending updates to Figma if we're currently syncing FROM Figma
    // This prevents an infinite loop where periodic sync triggers onMove which triggers Figma update
    if (isSyncingFromFigma.current) {
      console.log('[ReactFlowCanvas] Skipping Figma update - syncing from Figma');
      return;
    }
    
    const { x, y, zoom } = viewport;
    
    // Use async IIFE to handle the async operations
    (async () => {
      try {
        const centerX = -x / zoom;
        const centerY = -y / zoom;
        
        console.log('[ReactFlowCanvas] Viewport moved:', { x, y, zoom });
        console.log('[ReactFlowCanvas] Calculated Figma center:', { centerX, centerY });
        
        // Send update to Figma
        await uiMessageDispatcher.sendRequest<
          Omit<any, 'id' | 'timestamp' | 'source'>,
          ExtractResultType<UpdateViewportResponse>
        >({
          category: MessageCategory.SYSTEM,
          type: SystemMessageType.UPDATE_VIEWPORT,
          payload: {
            center: { x: centerX, y: centerY },
            zoom: zoom
          }
        });
        
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

  // Sync canvas position on mount
  useEffect(() => {
    const performSync = async () => {
      if (!hasSynced.current && reactFlowInstance) {
        try {
          await syncCanvasWithFigma(reactFlowInstance);
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

  // Set up cursor enter/leave event listeners
  useEffect(() => {
    const handleMouseEnter = () => {
      console.log('[ReactFlowCanvas] Cursor entered window - stopping periodic sync');
      isCursorInsideRef.current = true;
      
      // Clear the interval when cursor enters the window
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
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
            await syncCanvasWithFigma(reactFlowInstance);
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
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMove={handleMove}
        fitView={false}
        minZoom={0.2}
        maxZoom={2}
        className="bg-gray-50"
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
        
        {/* Viewport Bounds Button */}
        <Panel position="top-center">
          <Button 
            onClick={handlePrintBounds}
            variant="outline"
            size="sm"
            className="bg-white shadow-sm"
          >
            Print Viewport Bounds
          </Button>
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
