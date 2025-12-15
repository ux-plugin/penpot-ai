import React, { useState } from 'react';
import { Badge } from '@/plugin-ui/components/ui/badge';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface NodeInfoOverlayProps {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  data: Record<string, unknown>;
  nodeType: 'frame' | 'text';
}

/**
 * NodeInfoOverlay Component
 * 
 * Displays node dimensions, position, and an expandable data viewer.
 * Only shown when VITE_ENABLE_BUILD_DEBUG environment variable is set to 'true'.
 * 
 * Features:
 * - Always visible dimension/position badges (W, H, X, Y)
 * - Click to expand/collapse full node data
 * - Positioned in top-right corner of the node
 * - Semi-transparent to avoid obscuring content
 */
export const NodeInfoOverlay: React.FC<NodeInfoOverlayProps> = ({
  width,
  height,
  x,
  y,
  data,
  nodeType,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Prevent clicks from propagating to the node
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  // Format numbers to 2 decimal places
  const formatNum = (num?: number) => {
    return num !== undefined ? num.toFixed(2) : 'N/A';
  };

  return (
    <div
      className="absolute top-0 right-0 z-50 pointer-events-auto"
      onClick={handleClick}
      style={{
        cursor: 'pointer',
      }}
    >
      {/* Always visible info badges */}
      <div className="flex flex-col gap-1 p-2 bg-white/90 backdrop-blur-sm rounded-bl-lg shadow-lg border border-gray-200">
        <div className="flex gap-1 flex-wrap">
          <Badge variant="secondary" className="text-xs font-mono">
            W: {formatNum(width)}
          </Badge>
          <Badge variant="secondary" className="text-xs font-mono">
            H: {formatNum(height)}
          </Badge>
        </div>
        <div className="flex gap-1 flex-wrap">
          <Badge variant="outline" className="text-xs font-mono">
            X: {formatNum(x)}
          </Badge>
          <Badge variant="outline" className="text-xs font-mono">
            Y: {formatNum(y)}
          </Badge>
        </div>
        
        {/* Expand/Collapse indicator */}
        <div className="flex items-center justify-center pt-1 border-t border-gray-200">
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-500" />
          )}
        </div>
      </div>

      {/* Expandable data panel */}
      {isExpanded && (
        <div className="mt-2 p-3 bg-white/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-300 max-w-md max-h-96 overflow-auto">
          <div className="mb-2 pb-2 border-b border-gray-200">
            <h4 className="text-sm font-semibold text-gray-700">
              {nodeType === 'frame' ? 'Frame Node' : 'Text Node'} Data
            </h4>
            <p className="text-xs text-gray-500">
              {data.name as string || data.label as string || 'Unnamed Node'}
            </p>
          </div>
          
          {/* Node data viewer */}
          <pre className="text-xs font-mono text-gray-800 whitespace-pre-wrap break-words">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};
