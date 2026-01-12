/**
 * NodeManager - Central authority for all node queries and operations
 *
 * Features:
 * - Caches nodes and SVGs
 * - Tracks node changes (property, create, delete)
 * - Tracks selection changes
 * - Provides query API for nodes
 * - Subscription-based reactive updates
 * - Worker-ready design (no DOM access, serializable data)
 */

import { DesignNode } from "@shared-types/types";
import { uiMessageDispatcher } from "@/plugin-ui/UIMessageDispatcher";
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  ExportNodeSVGsResponse,
  NodeChangedRequest,
  SelectionChangedRequest,
} from "@shared-types/messageTypes";
import { loadAllNodes } from "@/plugin-ui/utils/loadNodes";
import {
  computeAbsolutePositions,
  type AbsoluteNode,
} from "@/plugin-ui/utils/nodeRendererUtils";

export type NodeChangeType = "property" | "create" | "delete";

export interface NodeManagerEvent {
  type: "nodes_changed" | "selection_changed" | "svg_loaded";
  nodeIds?: string[];
  selectedNodeIds?: string[];
}

export class NodeManager {
  // Node cache: Map<nodeId, DesignNode>
  private nodes: Map<string, DesignNode> = new Map();

  // SVG cache: Map<nodeId, svgString> (only for nodes with renderMode === 'svg')
  private svgCache: Map<string, string> = new Map();

  // Selection state: Set of selected node IDs
  private selectedNodeIds: Set<string> = new Set();

  // Subscribers: Set of callback functions
  private subscribers: Set<(event: NodeManagerEvent) => void> = new Set();

  // Initialization flag
  private initialized: boolean = false;

  /**
   * Get a single node by ID
   */
  getNode(id: string): DesignNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get all nodes
   */
  getAllNodes(): DesignNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get nodes filtered by type
   */
  getNodesByType(type: "figmaNode" | "textNode" | "svgNode"): DesignNode[] {
    return Array.from(this.nodes.values()).filter((node) => node.type === type);
  }

  /**
   * Get SVG for a node (only available if renderMode === 'svg')
   */
  getSVG(nodeId: string): string | undefined {
    return this.svgCache.get(nodeId);
  }

  /**
   * Get all selected nodes
   */
  getSelectedNodes(): DesignNode[] {
    return Array.from(this.selectedNodeIds)
      .map((id) => this.nodes.get(id))
      .filter((node): node is DesignNode => node !== undefined);
  }

  /**
   * Get selected node IDs
   */
  getSelectedNodeIds(): string[] {
    return Array.from(this.selectedNodeIds);
  }

  /**
   * Check if a node is selected
   */
  isSelected(nodeId: string): boolean {
    return this.selectedNodeIds.has(nodeId);
  }

  /**
   * Subscribe to node manager events
   * @returns Unsubscribe function
   */
  subscribe(callback: (event: NodeManagerEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of an event
   */
  private notifySubscribers(event: NodeManagerEvent): void {
    this.subscribers.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error("[NodeManager] Error in subscriber callback:", error);
      }
    });
  }

  /**
   * Initialize the node manager by loading all nodes
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn("[NodeManager] Already initialized");
      return;
    }

    try {
      console.log("[NodeManager] Initializing...");
      const result = await loadAllNodes(false);

      // Populate node cache
      for (const node of result.nodes) {
        this.nodes.set(node.id, node);
      }

      this.initialized = true;
      console.log(
        `[NodeManager] Initialized with ${result.nodes.length} nodes`,
      );

      // Notify subscribers of initial load
      this.notifySubscribers({
        type: "nodes_changed",
        nodeIds: result.nodes.map((n) => n.id),
      });
    } catch (error) {
      console.error("[NodeManager] Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * Handle node changes from code.ts
   */
  async handleNodeChange(
    payload: NodeChangedRequest["payload"],
  ): Promise<void> {
    const { changeType, nodeIds, nodes } = payload;

    console.log(`[NodeManager] Handling node change: ${changeType}`, {
      nodeIds,
      nodeCount: nodes?.length,
    });

    switch (changeType) {
      case "create":
        // Add new nodes to cache
        if (nodes) {
          for (const node of nodes) {
            this.nodes.set(node.id, node);
          }
        }
        break;

      case "delete":
        // Remove nodes from cache
        for (const nodeId of nodeIds) {
          this.nodes.delete(nodeId);
          this.svgCache.delete(nodeId);
          this.selectedNodeIds.delete(nodeId);
        }
        break;

      case "property":
        // Update existing nodes
        if (nodes) {
          for (const node of nodes) {
            this.nodes.set(node.id, node);
            // Invalidate SVG cache for updated nodes
            this.svgCache.delete(node.id);
          }
        } else {
          // If nodes not provided, we need to fetch them
          // For now, just invalidate cache - UI can request full reload if needed
          for (const nodeId of nodeIds) {
            this.svgCache.delete(nodeId);
          }
        }
        break;
    }

    // Re-export SVGs for nodes with renderMode === 'svg' that were changed
    const nodesToReExport: string[] = [];
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node && node.data.renderMode === "svg") {
        nodesToReExport.push(nodeId);
      }
    }

    if (nodesToReExport.length > 0) {
      await this.loadSVGsForNodes(nodesToReExport);
    }

    // Notify subscribers
    this.notifySubscribers({
      type: "nodes_changed",
      nodeIds,
    });
  }

  /**
   * Handle selection changes from code.ts
   */
  handleSelectionChange(payload: SelectionChangedRequest["payload"]): void {
    const { selectedNodeIds } = payload;

    console.log("[NodeManager] Handling selection change", {
      selectedNodeIds,
    });

    // Update selection state
    this.selectedNodeIds.clear();
    for (const nodeId of selectedNodeIds) {
      this.selectedNodeIds.add(nodeId);
    }

    // Notify subscribers
    this.notifySubscribers({
      type: "selection_changed",
      selectedNodeIds,
    });
  }

  /**
   * Load SVGs for specific nodes (only for nodes with renderMode === 'svg')
   */
  private async loadSVGsForNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    try {
      console.log(`[NodeManager] Loading SVGs for ${nodeIds.length} nodes...`);

      const result = await uiMessageDispatcher.sendRequest<
        Omit<any, "id" | "timestamp" | "source">,
        ExtractResultType<ExportNodeSVGsResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.EXPORT_NODE_SVGS,
        payload: {
          nodeIds,
        },
      });

      // Update SVG cache
      for (const svgResult of result.svgs) {
        if (svgResult.svg) {
          this.svgCache.set(svgResult.nodeId, svgResult.svg);
        } else {
          // Remove from cache if export failed
          this.svgCache.delete(svgResult.nodeId);
        }
      }

      console.log(
        `[NodeManager] Loaded ${result.svgs.filter((s) => s.svg !== null).length} SVGs`,
      );

      // Notify subscribers
      this.notifySubscribers({
        type: "svg_loaded",
        nodeIds: result.svgs.map((s) => s.nodeId),
      });
    } catch (error) {
      console.error("[NodeManager] Failed to load SVGs:", error);
    }
  }

  /**
   * Manually request SVG loading for specific nodes
   * Useful for lazy loading scenarios
   */
  async requestSVGs(nodeIds: string[]): Promise<void> {
    // Filter to only nodes that need SVG
    const nodesNeedingSVG = nodeIds.filter((nodeId) => {
      const node = this.nodes.get(nodeId);
      return node && node.data.renderMode === "svg";
    });

    await this.loadSVGsForNodes(nodesNeedingSVG);
  }

  /**
   * Convert screen coordinates to canvas coordinates using viewport transform
   */
  screenToCanvas(
    screenX: number,
    screenY: number,
    viewport: { x: number; y: number; scale: number },
  ): { x: number; y: number } {
    const canvasX = (screenX - viewport.x) / viewport.scale;
    const canvasY = (screenY - viewport.y) / viewport.scale;
    return { x: canvasX, y: canvasY };
  }

  /**
   * Get cached absolute positions for all nodes
   * Computes and caches absolute positions based on node hierarchy
   */
  private getAbsoluteNodes(): AbsoluteNode[] {
    const allNodes = this.getAllNodes();
    return computeAbsolutePositions(allNodes);
  }

  /**
   * Check if a point is inside a node's bounding box
   */
  private isPointInNode(
    point: { x: number; y: number },
    absoluteNode: AbsoluteNode,
  ): boolean {
    return (
      point.x >= absoluteNode.absoluteX &&
      point.x <= absoluteNode.absoluteX + absoluteNode.width &&
      point.y >= absoluteNode.absoluteY &&
      point.y <= absoluteNode.absoluteY + absoluteNode.height
    );
  }

  /**
   * Get node at a canvas point (for hit-testing)
   * Returns topmost node at the given canvas coordinates
   */
  getNodeAtPoint(canvasX: number, canvasY: number): DesignNode | undefined {
    const absoluteNodes = this.getAbsoluteNodes();
    const point = { x: canvasX, y: canvasY };

    // Iterate in reverse order to check topmost nodes first (z-ordering)
    for (let i = absoluteNodes.length - 1; i >= 0; i--) {
      const absoluteNode = absoluteNodes[i];
      if (this.isPointInNode(point, absoluteNode)) {
        return this.nodes.get(absoluteNode.id);
      }
    }

    return undefined;
  }

  /**
   * Get nodes visible in a viewport rectangle (for culling)
   */
  getNodesInViewport(
    viewportLeft: number,
    viewportTop: number,
    viewportRight: number,
    viewportBottom: number,
  ): DesignNode[] {
    const absoluteNodes = this.getAbsoluteNodes();
    const visibleNodes: DesignNode[] = [];

    for (const absoluteNode of absoluteNodes) {
      const nodeRight = absoluteNode.absoluteX + absoluteNode.width;
      const nodeBottom = absoluteNode.absoluteY + absoluteNode.height;

      // Check if node intersects viewport
      const isVisible =
        absoluteNode.absoluteX < viewportRight &&
        nodeRight > viewportLeft &&
        absoluteNode.absoluteY < viewportBottom &&
        nodeBottom > viewportTop;

      if (isVisible) {
        const node = this.nodes.get(absoluteNode.id);
        if (node) {
          visibleNodes.push(node);
        }
      }
    }

    return visibleNodes;
  }

  /**
   * Get absolute node data for a specific node
   */
  getAbsoluteNode(nodeId: string): AbsoluteNode | undefined {
    const absoluteNodes = this.getAbsoluteNodes();
    return absoluteNodes.find((n) => n.id === nodeId);
  }

  /**
   * Get absolute node data for all nodes
   */
  getAllAbsoluteNodes(): AbsoluteNode[] {
    return this.getAbsoluteNodes();
  }

  /**
   * Clear all caches (useful for cleanup or reset)
   */
  clear(): void {
    this.nodes.clear();
    this.svgCache.clear();
    this.selectedNodeIds.clear();
    this.initialized = false;
  }

  /**
   * Get cache statistics (useful for debugging)
   */
  getStats(): {
    nodeCount: number;
    svgCacheCount: number;
    selectedCount: number;
    subscriberCount: number;
  } {
    return {
      nodeCount: this.nodes.size,
      svgCacheCount: this.svgCache.size,
      selectedCount: this.selectedNodeIds.size,
      subscriberCount: this.subscribers.size,
    };
  }
}

// Export singleton instance
export const nodeManager = new NodeManager();
