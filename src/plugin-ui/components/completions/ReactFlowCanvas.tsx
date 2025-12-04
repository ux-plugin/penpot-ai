import React, { useEffect, useRef } from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';

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
            await syncCanvasWithFigma(reactFlowInstance);
          } catch (error) {
            console.error('[ReactFlowCanvas] Periodic sync failed:', error);
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
        fitView={false}
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
