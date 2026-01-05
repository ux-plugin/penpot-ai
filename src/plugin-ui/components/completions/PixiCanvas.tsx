/**
 * PixiJS Canvas Component
 *
 * GPU-accelerated canvas for rendering Figma nodes using PixiJS.
 * Supports pan/zoom via pixi-viewport and syncs with Figma canvas position.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Application, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { syncCanvasWithFigma } from '@/plugin-ui/utils/syncCanvas';
import { loadAllNodes } from '@/plugin-ui/utils/loadNodes';
import { uiMessageDispatcher } from '@/plugin-ui/UIMessageDispatcher';
import {
  MessageCategory,
  SystemMessageType,
  ExtractResultType,
  UpdateViewportResponse,
  UpdateViewportRequest,
} from '@shared-types/messageTypes';
import { DesignNode } from '@shared-types/types';
import { renderAllNodes } from '@/plugin-ui/utils/pixiNodeRenderer';

interface PixiCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
}

interface PixiViewport {
  x: number;
  y: number;
  zoom: number;
}

export const PixiCanvas: React.FC<PixiCanvasProps> = ({
  topRightContent,
  bottomRightContent,
  centerRightContent,
  topLeftContent,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const currentViewport = useRef<PixiViewport>({ x: 0, y: 0, zoom: 1 });
  const hasSynced = useRef(false);
  const firstSyncRef = useRef(true);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);
  const lastMousePosition = useRef<{ x: number; y: number } | null>(null);
  const isViewportUpdateInProgress = useRef<boolean>(false);
  const nodesRef = useRef<DesignNode[]>([]);
  const isLoadingNodes = useRef<boolean>(false);

  // Convert PixiJS viewport to viewport format
  const getViewportFromPixi = useCallback((): PixiViewport => {
    if (!viewportRef.current) {
      return { x: 0, y: 0, zoom: 1 };
    }
    const viewport = viewportRef.current;
    return {
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.scale.x,
    };
  }, []);

  // Apply viewport to PixiJS
  const setPixiViewport = useCallback((vp: PixiViewport) => {
    if (!viewportRef.current) return;
    const viewport = viewportRef.current;

    // Set position and scale separately
    viewport.position.set(vp.x, vp.y);
    viewport.scale.set(vp.zoom, vp.zoom);
    currentViewport.current = vp;
  }, []);

  // Send viewport update to Figma
  const sendViewportUpdate = useCallback(async (viewport: PixiViewport, isZoomOperation: boolean) => {
    if (isViewportUpdateInProgress.current && !isZoomOperation) {
      return;
    }

    isViewportUpdateInProgress.current = true;
    const { x, y, zoom } = viewport;
    const oldZoom = currentViewport.current.zoom;

    // Calculate canvas positions from viewports
    const oldCanvasPos = {
      x: -currentViewport.current.x / currentViewport.current.zoom,
      y: -currentViewport.current.y / currentViewport.current.zoom,
    };

    const newCanvasPos = {
      x: -x / zoom,
      y: -y / zoom,
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
          console.error('[PixiCanvas] Error calculating zoom focal point:', error);
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
          zoom: zoom,
          zoomFocalPoint: zoomFocalPoint,
        },
      });
      currentViewport.current = viewport;
    } catch (error) {
      console.error('[PixiCanvas] Failed to update Figma viewport:', error);
    } finally {
      isViewportUpdateInProgress.current = false;
    }
  }, []);

  // Handle viewport changes from pixi-viewport
  const handleViewportChanged = useCallback(() => {
    if (!hasSynced.current) return;
    if (isSyncingFromFigma.current) return;
    if (!isCursorInsideRef.current) return;

    if (firstSyncRef.current) {
      firstSyncRef.current = false;
      return;
    }

    const viewport = getViewportFromPixi();
    const oldZoom = currentViewport.current.zoom;
    const isZoomOperation = Math.abs(viewport.zoom - oldZoom) > 0.0001;

    sendViewportUpdate(viewport, isZoomOperation);
  }, [getViewportFromPixi, sendViewportUpdate]);

  // Sync viewport from Figma
  const syncFromFigma = useCallback(async () => {
    try {
      isSyncingFromFigma.current = true;
      const figmaViewport = await syncCanvasWithFigma();
      setPixiViewport({
        x: figmaViewport.x,
        y: figmaViewport.y,
        zoom: figmaViewport.zoom,
      });
      hasSynced.current = true;
    } catch (error) {
      console.error('[PixiCanvas] Failed to sync from Figma:', error);
    } finally {
      isSyncingFromFigma.current = false;
    }
  }, [setPixiViewport]);

  // Load and render nodes
  const loadNodes = useCallback(async () => {
    if (!viewportRef.current) return;
    if (isLoadingNodes.current) {
      return;
    }

    isLoadingNodes.current = true;
    try {
      console.log('[PixiCanvas] Loading nodes...');
      // Add a timeout wrapper to detect if loadAllNodes hangs
      const loadNodesPromise = loadAllNodes(false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('loadAllNodes timeout after 10 seconds - possible freeze'));
        }, 10000);
      });

      let result;
      try {
        result = await Promise.race([loadNodesPromise, timeoutPromise]);
      } catch (error) {
        console.error('[PixiCanvas] loadAllNodes failed or timed out:', error);
        // Return empty result to prevent crash
        result = { nodes: [], totalCount: 0 };
      }
      nodesRef.current = result.nodes;

      // Clear existing children
      const viewport = viewportRef.current;
      while (viewport.children.length > 0) {
        const child = viewport.children[0] as Container;
        // Properly destroy container to free GPU resources, event listeners, and memory
        child.destroy({ children: true });
        viewport.removeChildAt(0);
      }

      // Render nodes in batches and add to viewport incrementally to prevent freeze
      const batchSize = 50; // Render 50 nodes at a time
      const totalNodes = result.nodes.length;
      let renderedCount = 0;

      for (let i = 0; i < totalNodes; i += batchSize) {
        const batch = result.nodes.slice(i, i + batchSize);
        const containers = await renderAllNodes(batch, (nodeId) => {
          console.log('[PixiCanvas] Node clicked:', nodeId);
        });

        // Add containers to viewport immediately
        for (const container of containers) {
          viewport.addChild(container);
          renderedCount++;
        }

        // Yield control after each batch to prevent blocking
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      console.log(`[PixiCanvas] ${result.nodes.length} nodes rendered`);

      // Fit view to show all nodes
      if (result.nodes.length > 0) {
        setTimeout(() => {
          syncFromFigma();
        }, 100);
      }
    } catch (error) {
      console.error('[PixiCanvas] Failed to load nodes:', error);
    } finally {
      isLoadingNodes.current = false;
    }
  }, [syncFromFigma]);

  // Initialize PixiJS application
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const app = new Application();

    const init = async () => {
      await app.init({
        resizeTo: container,
        backgroundColor: 0xffffff,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      container.appendChild(app.canvas);
      appRef.current = app;

      // Create viewport for pan/zoom
      const viewport = new Viewport({
        screenWidth: container.clientWidth,
        screenHeight: container.clientHeight,
        events: app.renderer.events,
      });

      // Enable interactions
      viewport
        .drag()
        .pinch()
        .wheel({ smooth: 3 })
        .decelerate({ friction: 0.95 });

      // Set zoom limits
      viewport.clampZoom({
        minScale: 0.02,
        maxScale: 256,
      });

      app.stage.addChild(viewport);
      viewportRef.current = viewport;

      // Listen to viewport changes
      viewport.on('moved', handleViewportChanged);
      viewport.on('zoomed', handleViewportChanged);

      // Load nodes after viewport is ready - delay to ensure everything is initialized
      requestAnimationFrame(() => {
        setTimeout(() => {
          loadNodes();
        }, 100);
      });
    };

    init();

    return () => {
      if (viewportRef.current) {
        viewportRef.current.off('moved', handleViewportChanged);
        viewportRef.current.off('zoomed', handleViewportChanged);
      }
      app.destroy(true, { children: true });
      appRef.current = null;
      viewportRef.current = null;
    };
  }, [handleViewportChanged]); // Removed loadNodes from deps to prevent re-initialization

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

    document.addEventListener('mouseenter', handleMouseEnter);
    document.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      document.removeEventListener('mouseenter', handleMouseEnter);
      document.removeEventListener('mouseleave', handleMouseLeave);

      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [syncFromFigma]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (appRef.current && containerRef.current && viewportRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        appRef.current.renderer.resize(clientWidth, clientHeight);
        viewportRef.current.resize(clientWidth, clientHeight);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full">
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
          onClick={() => {
            if (viewportRef.current) {
              const newZoom = Math.min(viewportRef.current.scale.x * 1.5, 256);
              viewportRef.current.setZoom(newZoom, true);
              handleViewportChanged();
            }
          }}
          title="Zoom In"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <button
          className="p-2 hover:bg-gray-100 rounded-b-lg"
          onClick={() => {
            if (viewportRef.current) {
              const newZoom = Math.max(viewportRef.current.scale.x / 1.5, 0.02);
              viewportRef.current.setZoom(newZoom, true);
              handleViewportChanged();
            }
          }}
          title="Zoom Out"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      </div>

      {/* Minimap placeholder - simplified for PixiJS */}
      <div className="absolute bottom-4 right-4 z-10 w-32 h-24 rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="w-full h-full bg-gray-50 flex items-center justify-center text-xs text-gray-400">
          Minimap
        </div>
      </div>
    </div>
  );
};

