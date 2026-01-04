import React, { useState, useMemo } from 'react';
import { Badge } from '@/plugin-ui/components/ui/badge';
import { Input } from '@/plugin-ui/components/ui/input';
import { ChevronDown, ChevronRight, X, Search } from 'lucide-react';
import { DesignNode } from "@shared-types/types.ts";

interface NodeDebugPanelProps {
  nodes: DesignNode[];
  isOpen: boolean;
  onClose: () => void;
}

/**
 * NodeDebugPanel Component
 * 
 * A right-side panel displaying all nodes information in a table format.
 * Only shown when VITE_ENABLE_BUILD_DEBUG environment variable is set to 'true'.
 * 
 * Features:
 * - Table view of all nodes with W, H, X, Y, Name, Type
 * - Expandable rows to view full node data in JSON format
 * - Search/filter functionality
 * - Collapsible panel
 * - Scrollable for projects with many nodes
 */
export const NodeDebugPanel: React.FC<NodeDebugPanelProps> = ({ nodes, isOpen, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  // Filter nodes based on search query
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return nodes;

    const query = searchQuery.toLowerCase();
    return nodes.filter(node => {
      const name = (node.data?.name || node.data?.label || node.id).toString().toLowerCase();
      const type = node.type?.toLowerCase() || '';
      return name.includes(query) || type.includes(query);
    });
  }, [nodes, searchQuery]);

  // Format numbers to 2 decimal places
  const formatNum = (num?: number) => {
    return num !== undefined ? num.toFixed(0) : 'N/A';
  };

  // Get node type label
  const getNodeTypeLabel = (node: DesignNode) => {
    if (node.type === 'figmaNode') return 'Frame';
    if (node.type === 'textNode') return 'Text';
    if (node.type === 'svgNode') return 'SVG';
    return 'Unknown';
  };

  // Toggle node expansion
  const toggleExpand = (nodeId: string) => {
    setExpandedNodeId(expandedNodeId === nodeId ? null : nodeId);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed top-0 right-0 h-full w-96 bg-gray-900/95 backdrop-blur-sm text-white shadow-2xl z-50 flex flex-col border-l border-gray-700">
      {/* Header */}
      <div className="p-4 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Node Debug Panel</h3>
          <p className="text-xs text-gray-400">{filteredNodes.length} of {nodes.length} nodes</p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white transition-colors p-1"
          title="Close Panel"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Search Bar */}
      <div className="p-4 border-b border-gray-700">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-gray-800 border-gray-700 text-white placeholder-gray-500 focus:border-gray-600"
          />
        </div>
      </div>

      {/* Nodes List */}
      <div className="flex-1 overflow-y-auto">
        {filteredNodes.length === 0 ? (
          <div className="p-4 text-center text-gray-400">
            {searchQuery ? 'No nodes match your search' : 'No nodes found'}
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {filteredNodes.map((node) => {
              const isExpanded = expandedNodeId === node.id;
              const nodeWidth = node.width;
              const nodeHeight = node.height;
              const nodeName = node.data?.name || node.data?.label || node.id;

              return (
                <div key={node.id} className="border-b border-gray-800">
                  {/* Node Row */}
                  <button
                    onClick={() => toggleExpand(node.id)}
                    className="w-full p-3 hover:bg-gray-800/50 transition-colors text-left"
                  >
                    <div className="flex items-start gap-2">
                      <div className="pt-0.5">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-gray-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="secondary" className="text-xs">
                            {getNodeTypeLabel(node)}
                          </Badge>
                          <span className="text-sm font-medium truncate text-gray-100">
                            {nodeName}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-xs font-mono bg-gray-800 border-gray-600">
                            W: {formatNum(nodeWidth)}
                          </Badge>
                          <Badge variant="outline" className="text-xs font-mono bg-gray-800 border-gray-600">
                            H: {formatNum(nodeHeight)}
                          </Badge>
                          <Badge variant="outline" className="text-xs font-mono bg-gray-800 border-gray-600">
                            X: {formatNum(node.position?.x)}
                          </Badge>
                          <Badge variant="outline" className="text-xs font-mono bg-gray-800 border-gray-600">
                            Y: {formatNum(node.position?.y)}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </button>

                  {/* Expanded Data View */}
                  {isExpanded && (
                    <div className="p-3 bg-gray-950/50 border-t border-gray-800">
                      <div className="mb-2">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                          Node Data
                        </span>
                      </div>
                      <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words overflow-x-auto max-h-96 overflow-y-auto bg-black/30 p-3 rounded border border-gray-800">
                        {JSON.stringify(
                          {
                            id: node.id,
                            type: node.type,
                            position: node.position,
                            width: nodeWidth,
                            height: nodeHeight,
                            data: node.data,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-700 text-xs text-gray-400 text-center">
        Debug Mode: VITE_ENABLE_BUILD_DEBUG
      </div>
    </div>
  );
};
