/**
 * SkiaCanvas Component
 *
 * GPU-accelerated canvas for rendering Figma nodes using CanvasKit (Skia + WASM).
 * Supports pan/zoom and syncs with Figma canvas position.
 * Renders true vector SVGs unlike bitmap-based approaches.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import type { Canvas } from 'canvaskit-wasm';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import { nodeManager } from '@/plugin-ui/stores/NodeManager';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportResponse,
  UpdateViewportRequest,
} from '@shared-types/messageTypes';
import { DesignNode } from '@shared-types/types';
import { computeAbsolutePositions, type AbsoluteNode } from '@/plugin-ui/utils/nodeRendererUtils';
import {
  useCanvasKit,
  SkiaViewport,
  SkiaViewportRef,
  ViewportState,
  renderAbsoluteNodes,
  renderSVGNode,
} from './skia';
import { CanvasOverlay } from './skia/CanvasOverlay';

interface SkiaCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
  /** Callback when a node is clicked on the overlay */
  onNodeClick?: (node: DesignNode) => void;
  /** Callback when a node is hovered on the overlay (null when hover leaves) */
  onNodeHover?: (node: DesignNode | null) => void;
}

export const SkiaCanvas: React.FC<SkiaCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
  onNodeClick,
  onNodeHover,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<SkiaViewportRef>(null);
  const currentViewport = useRef<ViewportState>({ x: 0, y: 0, scale: 1 });
  const hasSynced = useRef(false);
  const firstSyncRef = useRef(true);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);
  const lastMousePosition = useRef<{ x: number; y: number } | null>(null);
  const isViewportUpdateInProgress = useRef<boolean>(false);
  const nodesRef = useRef<DesignNode[]>([]);
  const absoluteNodesRef = useRef<AbsoluteNode[]>([]);
  const isLoadingNodes = useRef<boolean>(false);

  const { canvasKit, isLoading, error } = useCanvasKit();

  // State for container dimensions
  const [containerDimensions, setContainerDimensions] = useState({ width: 800, height: 600 });

  // State for overlay viewport (needed for re-rendering overlay on viewport changes)
  const [overlayViewport, setOverlayViewport] = useState<ViewportState>({ x: 0, y: 0, scale: 1 });

  // Update container dimensions on mount and resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setContainerDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // Apply viewport state to SkiaViewport
  const setSkiaViewport = useCallback((vp: ViewportState) => {
    if (!viewportRef.current) return;
    viewportRef.current.setViewport(vp.x, vp.y, vp.scale);
    currentViewport.current = vp;
    setOverlayViewport(vp); // Update overlay viewport state
  }, []);

  // Send viewport update to Figma
  const sendViewportUpdate = useCallback(async (viewport: ViewportState, isZoomOperation: boolean) => {
    if (isViewportUpdateInProgress.current && !isZoomOperation) {
      return;
    }

    isViewportUpdateInProgress.current = true;
    const { x, y, scale } = viewport;
    const oldZoom = currentViewport.current.scale;

    // Calculate canvas positions from viewports
    const oldCanvasPos = {
      x: -currentViewport.current.x / currentViewport.current.scale,
      y: -currentViewport.current.y / currentViewport.current.scale,
    };

    const newCanvasPos = {
      x: -x / scale,
      y: -y / scale,
    };

    // Calculate delta in canvas space (zoom-independent)
    const canvasDelta = {
      x: newCanvasPos.x - oldCanvasPos.x,
      y: newCanvasPos.y - oldCanvasPos.y,
    };

    try {
      let zoomFocalPoint: { x: number; y: number } | undefined;

      if (isZoomOperation && lastMousePosition.current && containerRef.current) {
        try {
          const containerRect = containerRef.current.getBoundingClientRect();
          const relativeX = lastMousePosition.current.x - containerRect.left;
          const relativeY = lastMousePosition.current.y - containerRect.top;
          const mouseFocalPointX = relativeX / oldZoom + oldCanvasPos.x;
          const mouseFocalPointY = relativeY / oldZoom + oldCanvasPos.y;
          zoomFocalPoint = { x: mouseFocalPointX, y: mouseFocalPointY };
        } catch (error) {
          console.error('[SkiaCanvas] Error calculating zoom focal point:', error);
        }
      }

      await uiMessageDispatcher.sendRequest<
        Omit<UpdateViewportRequest, 'id' | 'timestamp' | 'source'>,
        ExtractResultType<UpdateViewportResponse>
      >({
        category: MessageCategory.SYSTEM,
        type: SystemMessageType.UPDATE_VIEWPORT,
        payload: {
          transform: canvasDelta,
          zoom: scale,
          zoomFocalPoint: zoomFocalPoint,
        },
      });
      currentViewport.current = viewport;
    } catch (error) {
      console.error('[SkiaCanvas] Failed to update Figma viewport:', error);
    } finally {
      isViewportUpdateInProgress.current = false;
    }
  }, []);

  // Handle viewport changes from SkiaViewport
  const handleViewportChanged = useCallback((viewport: ViewportState) => {
    // Update overlay viewport state immediately for responsive hover/click
    setOverlayViewport(viewport);

    if (!hasSynced.current) return;
    if (isSyncingFromFigma.current) return;
    if (!isCursorInsideRef.current) return;

    if (firstSyncRef.current) {
      firstSyncRef.current = false;
      return;
    }

    const oldZoom = currentViewport.current.scale;
    const isZoomOperation = Math.abs(viewport.scale - oldZoom) > 0.0001;

    sendViewportUpdate(viewport, isZoomOperation);
  }, [sendViewportUpdate]);

  // Sync viewport from Figma
  const syncFromFigma = useCallback(async () => {
    try {
      isSyncingFromFigma.current = true;
      const figmaViewport = await syncCanvasWithFigma();
      setSkiaViewport({
        x: figmaViewport.x,
        y: figmaViewport.y,
        scale: figmaViewport.zoom,
      });
      hasSynced.current = true;
    } catch (error) {
      console.error('[SkiaCanvas] Failed to sync from Figma:', error);
    } finally {
      isSyncingFromFigma.current = false;
    }
  }, [setSkiaViewport]);

  // Render callback for SkiaViewport
  const handleRender = useCallback((canvas: Canvas, _viewportState: ViewportState) => {
    if (!canvasKit || absoluteNodesRef.current.length === 0) return;

    // Render all nodes with hierarchy
    renderAbsoluteNodes(canvasKit, canvas, absoluteNodesRef.current);

    // Render SVG nodes on top (for nodes with SVG data)
    for (const node of absoluteNodesRef.current) {
      if (node.data.renderMode === 'svg' && node.data.svg) {
        renderSVGNode(canvasKit, canvas, node);
      }
    }
  }, [canvasKit]);

  // Load SVGs lazily and update nodes
  const loadAndRenderSVGs = useCallback(async (svgNodeIds: string[]) => {
    if (!canvasKit) return;

    try {
      console.log(`[SkiaCanvas] Loading SVGs for ${svgNodeIds.length} nodes...`);

      // Request SVGs from NodeManager (it will handle caching and re-export)
      await nodeManager.requestSVGs(svgNodeIds);

      // Update local refs with SVGs from cache
      for (const nodeId of svgNodeIds) {
        const svg = nodeManager.getSVG(nodeId);
        if (svg) {
          const nodeIndex = absoluteNodesRef.current.findIndex(n => n.id === nodeId);
          if (nodeIndex !== -1) {
            absoluteNodesRef.current[nodeIndex].data.svg = svg;
          }
        }
      }

      // Request redraw
      viewportRef.current?.requestDraw();

      console.log(`[SkiaCanvas] Completed lazy SVG loading for ${svgNodeIds.length} nodes`);
    } catch (error) {
      console.error('[SkiaCanvas] Failed to load SVGs:', error);
    }
  }, [canvasKit]);

  // Update nodes from NodeManager cache
  const updateNodesFromCache = useCallback(() => {
    if (!canvasKit || !viewportRef.current) return;

    const allNodes = nodeManager.getAllNodes();
    nodesRef.current = allNodes;

    // Compute absolute positions
    absoluteNodesRef.current = computeAbsolutePositions(allNodes);

    // Track SVG nodes for lazy loading
    const svgNodeIds: string[] = [];
    for (const node of absoluteNodesRef.current) {
      if (node.data.renderMode === 'svg' && !node.data.svg) {
        svgNodeIds.push(node.id);
      }
    }

    console.log(`[SkiaCanvas] Updated ${allNodes.length} nodes from cache`);

    // Request redraw
    viewportRef.current.requestDraw();

    // Load SVGs lazily for nodes that need them
    if (svgNodeIds.length > 0) {
      loadAndRenderSVGs(svgNodeIds);
    }
  }, [canvasKit, loadAndRenderSVGs]);

  // Load and render nodes (initial load)
  const loadNodes = useCallback(async () => {
    if (!canvasKit || !viewportRef.current) return;
    if (isLoadingNodes.current) return;

    isLoadingNodes.current = true;
    try {
      console.log('[SkiaCanvas] Initializing NodeManager...');

      // Initialize NodeManager (loads all nodes)
      await nodeManager.initialize();

      // Update from cache
      updateNodesFromCache();

      // Sync viewport after loading
      const allNodes = nodeManager.getAllNodes();
      if (allNodes.length > 0) {
        setTimeout(() => {
          syncFromFigma();
        }, 100);
      }
    } catch (error) {
      console.error('[SkiaCanvas] Failed to initialize NodeManager:', error);
    } finally {
      isLoadingNodes.current = false;
    }
  }, [canvasKit, syncFromFigma, updateNodesFromCache]);

  // Handle viewport ready callback
  const handleViewportReady = useCallback((_ref: SkiaViewportRef) => {
    console.log('[SkiaCanvas] Viewport ready');

    // Load nodes after viewport is ready
    requestAnimationFrame(() => {
      setTimeout(() => {
        loadNodes();
      }, 100);
    });
  }, [loadNodes]);

  // Subscribe to NodeManager changes
  useEffect(() => {
    const unsubscribe = nodeManager.subscribe((event) => {
      if (event.type === 'nodes_changed') {
        console.log('[SkiaCanvas] Nodes changed, updating...');
        updateNodesFromCache();
      } else if (event.type === 'svg_loaded' && event.nodeIds) {
        // Update SVG data for nodes that just got their SVGs loaded
        for (const nodeId of event.nodeIds) {
          const svg = nodeManager.getSVG(nodeId);
          if (svg) {
            const nodeIndex = absoluteNodesRef.current.findIndex(n => n.id === nodeId);
            if (nodeIndex !== -1) {
              absoluteNodesRef.current[nodeIndex].data.svg = svg;
            }
          }
        }
        viewportRef.current?.requestDraw();
      }
    });

    return unsubscribe;
  }, [updateNodesFromCache]);

  // Track mouse position for zoom focal point
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      lastMousePosition.current = { x: event.clientX, y: event.clientY };
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  // Handle cursor enter/leave for sync behavior
  useEffect(() => {
    const handleMouseEnter = async () => {
      isCursorInsideRef.current = true;

      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }

      await syncFromFigma();
    };

    const handleMouseLeave = () => {
      isCursorInsideRef.current = false;

      if (!syncIntervalRef.current && viewportRef.current) {
        syncIntervalRef.current = window.setInterval(async () => {
          await syncFromFigma();
        }, 1000);
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('mouseenter', handleMouseEnter);
      container.addEventListener('mouseleave', handleMouseLeave);
    }

    return () => {
      if (container) {
        container.removeEventListener('mouseenter', handleMouseEnter);
        container.removeEventListener('mouseleave', handleMouseLeave);
      }

      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [syncFromFigma]);

  // Zoom button handlers
  const handleZoomIn = useCallback(() => {
    if (viewportRef.current) {
      const state = viewportRef.current.getViewport();
      const newScale = Math.min(state.scale * 1.5, 256);

      // Zoom towards center
      const centerX = containerDimensions.width / 2;
      const centerY = containerDimensions.height / 2;
      const scaleRatio = newScale / state.scale;
      const newX = centerX - (centerX - state.x) * scaleRatio;
      const newY = centerY - (centerY - state.y) * scaleRatio;

      viewportRef.current.setViewport(newX, newY, newScale);
      handleViewportChanged({ x: newX, y: newY, scale: newScale });
    }
  }, [containerDimensions, handleViewportChanged]);

  const handleZoomOut = useCallback(() => {
    if (viewportRef.current) {
      const state = viewportRef.current.getViewport();
      const newScale = Math.max(state.scale / 1.5, 0.02);

      // Zoom towards center
      const centerX = containerDimensions.width / 2;
      const centerY = containerDimensions.height / 2;
      const scaleRatio = newScale / state.scale;
      const newX = centerX - (centerX - state.x) * scaleRatio;
      const newY = centerY - (centerY - state.y) * scaleRatio;

      viewportRef.current.setViewport(newX, newY, newScale);
      handleViewportChanged({ x: newX, y: newY, scale: newScale });
    }
  }, [containerDimensions, handleViewportChanged]);

  // Loading state
  if (isLoading) {
    return (
      <div ref={containerRef} className="relative h-full w-full flex items-center justify-center bg-black">
        <div className="text-white">Loading Skia...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div ref={containerRef} className="relative h-full w-full flex items-center justify-center bg-black">
        <div className="text-red-400">Failed to load Skia: {error.message}</div>
      </div>
    );
  }

  // Waiting for CanvasKit
  if (!canvasKit) {
    return (
      <div ref={containerRef} className="relative h-full w-full flex items-center justify-center bg-black">
        <div className="text-white">Initializing...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <SkiaViewport
        ref={viewportRef}
        canvasKit={canvasKit}
        screenWidth={containerDimensions.width}
        screenHeight={containerDimensions.height}
        minScale={0.02}
        maxScale={256}
        drag={true}
        wheel={true}
        onMoved={handleViewportChanged}
        onZoomed={handleViewportChanged}
        onViewportReady={handleViewportReady}
        onRender={handleRender}
      />

      {/* DOM Overlay for node interactions */}
      <CanvasOverlay
        viewport={overlayViewport}
        width={containerDimensions.width}
        height={containerDimensions.height}
        onNodeClick={onNodeClick}
        onNodeHover={onNodeHover}
      />

      {/* Overlay panels */}
      {topRightContent && (
        <div className="absolute top-2 right-2 z-10">{topRightContent}</div>
      )}
      {topLeftContent && (
        <div className="absolute top-2 left-2 z-10 h-[70%] w-[30%]">{topLeftContent}</div>
      )}
      {bottomRightContent && (
        <div className="absolute bottom-2 right-2 z-10">{bottomRightContent}</div>
      )}
      {centerRightContent && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10">
          {centerRightContent}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-lg border border-gray-200 bg-white shadow-sm">
        <button
          className="p-2 hover:bg-gray-100 rounded-t-lg"
          onClick={handleZoomIn}
          title="Zoom In"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <button
          className="p-2 hover:bg-gray-100 rounded-b-lg"
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      </div>

      {/* Skia badge */}
      <div className="absolute bottom-4 left-16 z-10 px-2 py-1 rounded bg-purple-600 text-white text-xs font-medium">
        Skia
      </div>
    </div>
  );
};

export default SkiaCanvas;

