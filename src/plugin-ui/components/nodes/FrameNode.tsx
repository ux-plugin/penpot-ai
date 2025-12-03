import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import type { ReactFlowFrameNode } from '@utils/createReactFlowNode';

/**
 * Custom React component for rendering a Figma Frame in React Flow.
 * This component displays frame information and handles connections.
 */
export const FrameNode: React.FC<NodeProps<ReactFlowFrameNode>> = memo(
  ({ data, isConnectable, selected }) => {
    return (
      <div
        className={`
          px-4 py-3 shadow-lg rounded-lg border-2 bg-white min-w-[150px]
          ${selected ? 'border-blue-500' : 'border-gray-300'}
          ${data.locked ? 'opacity-50 cursor-not-allowed' : ''}
        `}
        style={{
          opacity: data.opacity,
          transform: `rotate(${data.rotation}deg)`,
        }}
      >
        {/* Connection handles */}
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={isConnectable}
          className="w-3 h-3"
        />

        {/* Frame label */}
        <div className="flex flex-col gap-1">
          <div className="font-semibold text-sm text-gray-900 truncate">
            {data.label}
          </div>
          
          {/* Frame type badge */}
          <div className="text-xs text-gray-500 flex items-center gap-2">
            <span className="bg-gray-100 px-2 py-0.5 rounded">
              {data.frameType}
            </span>
            
            {/* Layout mode indicator */}
            {data.layoutMode && data.layoutMode !== 'NONE' && (
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                {data.layoutMode}
              </span>
            )}
          </div>

          {/* Status indicators */}
          <div className="flex gap-1 text-xs mt-1">
            {data.locked && (
              <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded" aria-label="Locked">
                Locked
              </span>
            )}
            {!data.visible && (
              <span className="bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded" aria-label="Hidden">
                Hidden
              </span>
            )}
          </div>
        </div>

        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={isConnectable}
          className="w-3 h-3"
        />
      </div>
    );
  }
);

FrameNode.displayName = 'FrameNode';
