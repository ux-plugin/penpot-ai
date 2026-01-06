/**
 * PixiJS Canvas Component
 *
 * GPU-accelerated canvas for rendering Figma nodes using PixiJS.
 * Supports pan/zoom via pixi-viewport and syncs with Figma canvas position.
 * Uses @pixi/react for React integration with declarative viewport component.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Container, Graphics, Sprite } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { Application as PixiApplication, extend } from '@pixi/react';
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
  PixiViewport,
  PixiViewportRef,
  createNodeGraphics,
  createNodeSprite,
} from './pixi';

// Extend @pixi/react with Graphics, Sprite, Container components
extend({ Graphics, Sprite, Container });

interface PixiCanvasProps {
  topRightContent?: React.ReactNode;
  bottomRightContent?: React.ReactNode;
  centerRightContent?: React.ReactNode;
  topLeftContent?: React.ReactNode;
}

interface PixiViewportState {
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
  const viewportRef = useRef<PixiViewportRef>(null);
  const currentViewport = useRef<PixiViewportState>({ x: 0, y: 0, zoom: 1 });
  const hasSynced = useRef(false);
  const firstSyncRef = useRef(true);
  const syncIntervalRef = useRef<number | null>(null);
  const isCursorInsideRef = useRef(true);
  const isSyncingFromFigma = useRef(false);
  const lastMousePosition = useRef<{ x: number; y: number } | null>(null);
  const isViewportUpdateInProgress = useRef<boolean>(false);
  const nodesRef = useRef<DesignNode[]>([]);
  const isLoadingNodes = useRef<boolean>(false);
  const graphicsMapRef = useRef<Map<string, Graphics>>(new Map());

  // State for container dimensions (triggers re-render when container size changes)
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

  // Apply viewport state to PixiViewport
  const setPixiViewport = useCallback((vp: PixiViewportState) => {
    if (!viewportRef.current) return;
    viewportRef.current.setViewport(vp.x, vp.y, vp.zoom);
    currentViewport.current = vp;
  }, []);

  // Send viewport update to Figma
  const sendViewportUpdate = useCallback(async (viewport: PixiViewportState, isZoomOperation: boolean) => {
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
  const handleViewportChanged = useCallback((viewport: Viewport) => {
    if (!hasSynced.current) return;
    if (isSyncingFromFigma.current) return;
    if (!isCursorInsideRef.current) return;

    if (firstSyncRef.current) {
      firstSyncRef.current = false;
      return;
    }

    const viewportState: PixiViewportState = {
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.scale.x,
    };
    const oldZoom = currentViewport.current.zoom;
    const isZoomOperation = Math.abs(viewportState.zoom - oldZoom) > 0.0001;

    sendViewportUpdate(viewportState, isZoomOperation);
  }, [sendViewportUpdate]);

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

  // Load SVGs lazily and replace Graphics with Sprites
  const loadAndRenderSVGs = useCallback(async (
    svgNodeIds: string[],
    absoluteNodes: AbsoluteNode[],
    handleNodeClick: (nodeId: string) => void,
    nodesContainer: Container
  ) => {
    try {
      console.log(`[PixiCanvas] Loading SVGs for ${svgNodeIds.length} nodes...`);

      // Request SVGs in batches
      const batchSize = 50;
      for (let i = 0; i < svgNodeIds.length; i += batchSize) {
        const batch = svgNodeIds.slice(i, i + batchSize);
        const svgResults = await loadNodeSVGs(batch);

        // Process each SVG result
        for (const svgResult of svgResults) {
          if (!svgResult.svg) {
            console.warn(`[PixiCanvas] No SVG data for node ${svgResult.nodeId}`);
            continue;
          }

          // Find the corresponding node
          const node = absoluteNodes.find(n => n.id === svgResult.nodeId);
          if (!node) {
            console.warn(`[PixiCanvas] Node ${svgResult.nodeId} not found`);
            continue;
          }

          // Update node data with SVG
          node.data.svg = svgResult.svg;

          // Find and remove the existing Graphics object
          const graphics = graphicsMapRef.current.get(svgResult.nodeId);
          if (graphics && nodesContainer.children.includes(graphics)) {
            nodesContainer.removeChild(graphics);
            graphics.destroy({ children: true });
            graphicsMapRef.current.delete(svgResult.nodeId);
          }

          // Create and add the Sprite
          const sprite = await createNodeSprite(node, handleNodeClick);
          if (sprite) {
            nodesContainer.addChild(sprite);
            console.log(`[PixiCanvas] Replaced Graphics with Sprite for node ${svgResult.nodeId}`);
          } else {
            console.warn(`[PixiCanvas] Failed to create sprite for node ${svgResult.nodeId}`);
            // Fallback: recreate graphics if sprite creation failed
            const fallbackGraphics = createNodeGraphics(node, handleNodeClick);
            nodesContainer.addChild(fallbackGraphics);
            graphicsMapRef.current.set(svgResult.nodeId, fallbackGraphics);
          }
        }

        // Yield control after each batch to prevent blocking
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      console.log(`[PixiCanvas] Completed lazy SVG loading for ${svgNodeIds.length} nodes`);
    } catch (error) {
      console.error('[PixiCanvas] Failed to load SVGs:', error);
    }
  }, []);

  // Load and render nodes
  const loadNodes = useCallback(async () => {
    if (!viewportRef.current || !viewportRef.current.nodesContainer) return;
    if (isLoadingNodes.current) return;

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
        result = { nodes: [], totalCount: 0 };
      }
      nodesRef.current = result.nodes;

      // Get the nodes container from the viewport
      const nodesContainer = viewportRef.current.nodesContainer;
      if (!nodesContainer) {
        console.error('[PixiCanvas] Nodes container not available');
        return;
      }

      // Clear existing children from nodes container
      while (nodesContainer.children.length > 0) {
        const child = nodesContainer.children[0];
        child.destroy({ children: true });
        nodesContainer.removeChildAt(0);
      }
      graphicsMapRef.current.clear();

      // Compute absolute positions
      const absoluteNodes = computeAbsolutePositions(result.nodes);

      // Handle click on node
      const handleNodeClick = (nodeId: string) => {
        console.log('[PixiCanvas] Node clicked:', nodeId);
      };

      // Render all nodes as rectangles immediately (in batches)
      const batchSize = 50;
      const totalNodes = absoluteNodes.length;
      const svgNodeIds: string[] = [];

      for (let i = 0; i < totalNodes; i += batchSize) {
        const batch = absoluteNodes.slice(i, i + batchSize);

        for (const node of batch) {
          const { data } = node;
          const renderMode = data.renderMode || 'css';

          // Track SVG nodes for lazy loading
          if (renderMode === 'svg') {
            svgNodeIds.push(node.id);
          }

          // Render all nodes as graphics (rectangles) immediately
          const graphics = createNodeGraphics(node, handleNodeClick);
          nodesContainer.addChild(graphics);
          graphicsMapRef.current.set(node.id, graphics);
        }

        // Yield control after each batch to prevent blocking
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      console.log(`[PixiCanvas] ${result.nodes.length} nodes rendered as rectangles`);

      // Load SVGs lazily for SVG nodes
      if (svgNodeIds.length > 0) {
        loadAndRenderSVGs(svgNodeIds, absoluteNodes, handleNodeClick, nodesContainer);
      }

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

  // Handle viewport ready callback
  const handleViewportReady = useCallback((_viewport: Viewport) => {
    console.log('[PixiCanvas] Viewport ready');

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
    if (viewportRef.current?.viewport) {
      const viewport = viewportRef.current.viewport;
      const newZoom = Math.min(viewport.scale.x * 1.5, 256);
      viewport.setZoom(newZoom, true);
      handleViewportChanged(viewport);
    }
  }, [handleViewportChanged]);

  const handleZoomOut = useCallback(() => {
    if (viewportRef.current?.viewport) {
      const viewport = viewportRef.current.viewport;
      const newZoom = Math.max(viewport.scale.x / 1.5, 0.02);
      viewport.setZoom(newZoom, true);
      handleViewportChanged(viewport);
    }
  }, [handleViewportChanged]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PixiApplication
        width={containerDimensions.width}
        height={containerDimensions.height}
        backgroundColor={0x000000}
        antialias={true}
        resolution={window.devicePixelRatio || 1}
        autoDensity={true}
      >
        <PixiViewport
          ref={viewportRef}
          screenWidth={containerDimensions.width}
          screenHeight={containerDimensions.height}
          minScale={0.02}
          maxScale={256}
          drag={true}
          pinch={true}
          wheel={true}
          wheelSmooth={3}
          decelerate={true}
          decelerateFriction={0.95}
          onMoved={handleViewportChanged}
          onZoomed={handleViewportChanged}
          onViewportReady={handleViewportReady}
          containerElement={containerRef.current}
        />
      </PixiApplication>

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
    </div>
  );
};
