import React from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface ReactFlowCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
}

export const ReactFlowCanvas: React.FC<ReactFlowCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
}) => {
  const [nodes, ,onNodesChange] = useNodesState([]);
  const [edges, ,onEdgesChange] = useEdgesState([]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
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
