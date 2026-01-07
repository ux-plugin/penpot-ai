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
import { loadAllNodes, loadNodeSVGs } from '@/plugin-ui/utils/loadNodes';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportResponse,
  UpdateViewportRequest,
} from '@shared-types/messageTypes';
import { DesignNode } from '@shared-types/types';
import { computeAbsolutePositions, type AbsoluteNode } from '@/plugin-ui/utils/pixiNodeRenderer';
import {
  useCanvasKit,
  SkiaViewport,
  SkiaViewportRef,
  ViewportState,
  renderAbsoluteNodes,
  renderSVGNode,
} from './skia';

interface SkiaCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
}

export const SkiaCanvas: React.FC<SkiaCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
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

      // Request SVGs in batches
      const batchSize = 50;
      for (let i = 0; i < svgNodeIds.length; i += batchSize) {
        const batch = svgNodeIds.slice(i, i + batchSize);
        const svgResults = await loadNodeSVGs(batch);

        // Process each SVG result
        for (const svgResult of svgResults) {
          if (!svgResult.svg) continue;

          // Find the corresponding node and update its SVG data
          const nodeIndex = absoluteNodesRef.current.findIndex(n => n.id === svgResult.nodeId);
          if (nodeIndex !== -1) {
            absoluteNodesRef.current[nodeIndex].data.svg = svgResult.svg;
          }
        }

        // Request redraw after each batch
        viewportRef.current?.requestDraw();

        // Yield control after each batch
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      console.log(`[SkiaCanvas] Completed lazy SVG loading for ${svgNodeIds.length} nodes`);
    } catch (error) {
      console.error('[SkiaCanvas] Failed to load SVGs:', error);
    }
  }, [canvasKit]);

  // Load and render nodes
  const loadNodes = useCallback(async () => {
    if (!canvasKit || !viewportRef.current) return;
    if (isLoadingNodes.current) return;

    isLoadingNodes.current = true;
    try {
      console.log('[SkiaCanvas] Loading nodes...');

      // Add a timeout wrapper
      const loadNodesPromise = loadAllNodes(false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('loadAllNodes timeout after 10 seconds'));
        }, 10000);
      });

      let result;
      try {
        result = await Promise.race([loadNodesPromise, timeoutPromise]);
      } catch (error) {
        console.error('[SkiaCanvas] loadAllNodes failed or timed out:', error);
        result = { nodes: [], totalCount: 0 };
      }

      nodesRef.current = result.nodes;

      // Compute absolute positions
      absoluteNodesRef.current = computeAbsolutePositions(result.nodes);

      // Track SVG nodes for lazy loading
      const svgNodeIds: string[] = [];
      for (const node of absoluteNodesRef.current) {
        if (node.data.renderMode === 'svg') {
          svgNodeIds.push(node.id);
        }
      }

      console.log(`[SkiaCanvas] ${result.nodes.length} nodes loaded`);

      // Request initial render
      viewportRef.current.requestDraw();

      // Load SVGs lazily
      if (svgNodeIds.length > 0) {
        loadAndRenderSVGs(svgNodeIds);
      }

      // Sync viewport after loading
      if (result.nodes.length > 0) {
        setTimeout(() => {
          syncFromFigma();
        }, 100);
      }
    } catch (error) {
      console.error('[SkiaCanvas] Failed to load nodes:', error);
    } finally {
      isLoadingNodes.current = false;
    }
  }, [canvasKit, syncFromFigma, loadAndRenderSVGs]);

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

