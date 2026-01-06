/**
 * PixiViewport Component
 *
 * A declarative React wrapper around pixi-viewport for use with @pixi/react.
 * Provides pan/zoom functionality with React children support.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useCallback,
} from 'react';
import { Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { useApplication } from '@pixi/react';

export interface PixiViewportProps {
  /** Width of the viewport screen */
  screenWidth?: number;
  /** Height of the viewport screen */
  screenHeight?: number;
  /** Initial world width */
  worldWidth?: number;
  /** Initial world height */
  worldHeight?: number;
  /** Minimum zoom scale */
  minScale?: number;
  /** Maximum zoom scale */
  maxScale?: number;
  /** Enable drag interaction */
  drag?: boolean;
  /** Enable pinch-to-zoom */
  pinch?: boolean;
  /** Enable mouse wheel zoom */
  wheel?: boolean;
  /** Wheel smooth factor */
  wheelSmooth?: number;
  /** Enable deceleration after dragging */
  decelerate?: boolean;
  /** Deceleration friction (0-1) */
  decelerateFriction?: number;
  /** Called when viewport is moved (pan) */
  onMoved?: (viewport: Viewport) => void;
  /** Called when viewport is zoomed */
  onZoomed?: (viewport: Viewport) => void;
  /** Called when viewport is ready */
  onViewportReady?: (viewport: Viewport) => void;
  /** React children to render inside the viewport */
  children?: React.ReactNode;
}

export interface PixiViewportRef {
  /** The pixi-viewport instance */
  viewport: Viewport | null;
  /** The container for nodes inside the viewport */
  nodesContainer: Container | null;
  /** Set viewport position and zoom */
  setViewport: (x: number, y: number, zoom: number) => void;
  /** Get current viewport state */
  getViewport: () => { x: number; y: number; zoom: number };
}

/**
 * Internal component that has access to the PixiJS application context
 */
const ViewportInner = forwardRef<
  PixiViewportRef,
  PixiViewportProps & { containerElement: HTMLElement | null }
>(
  (
    {
      screenWidth,
      screenHeight,
      worldWidth = 10000,
      worldHeight = 10000,
      minScale = 0.02,
      maxScale = 256,
      drag = true,
      pinch = true,
      wheel = true,
      wheelSmooth = 3,
      decelerate = true,
      decelerateFriction = 0.95,
      onMoved,
      onZoomed,
      onViewportReady,
      // children - not used directly, nodes are added imperatively via ref
      containerElement,
    },
    ref
  ) => {
    const { app } = useApplication();
    const viewportRef = useRef<Viewport | null>(null);
    const nodesContainerRef = useRef<Container | null>(null);

    // Stable callback refs to avoid re-creating viewport on callback changes
    const onMovedRef = useRef(onMoved);
    const onZoomedRef = useRef(onZoomed);
    const onViewportReadyRef = useRef(onViewportReady);

    useEffect(() => {
      onMovedRef.current = onMoved;
    }, [onMoved]);

    useEffect(() => {
      onZoomedRef.current = onZoomed;
    }, [onZoomed]);

    useEffect(() => {
      onViewportReadyRef.current = onViewportReady;
    }, [onViewportReady]);

    // Expose viewport methods via ref
    // Using getters to ensure we always get the current value, not captured null
    useImperativeHandle(
      ref,
      () => ({
        get viewport() {
          return viewportRef.current;
        },
        get nodesContainer() {
          return nodesContainerRef.current;
        },
        setViewport: (x: number, y: number, zoom: number) => {
          if (viewportRef.current) {
            viewportRef.current.position.set(x, y);
            viewportRef.current.scale.set(zoom, zoom);
          }
        },
        getViewport: () => {
          if (viewportRef.current) {
            return {
              x: viewportRef.current.x,
              y: viewportRef.current.y,
              zoom: viewportRef.current.scale.x,
            };
          }
          return { x: 0, y: 0, zoom: 1 };
        },
      }),
      []
    );

    // Handle viewport events
    const handleMoved = useCallback(() => {
      if (viewportRef.current && onMovedRef.current) {
        onMovedRef.current(viewportRef.current);
      }
    }, []);

    const handleZoomed = useCallback(() => {
      if (viewportRef.current && onZoomedRef.current) {
        onZoomedRef.current(viewportRef.current);
      }
    }, []);

    // Initialize viewport
    useEffect(() => {
      if (!app) return;

      const width = screenWidth || containerElement?.clientWidth || 800;
      const height = screenHeight || containerElement?.clientHeight || 600;

      // Create viewport
      const viewport = new Viewport({
        screenWidth: width,
        screenHeight: height,
        worldWidth,
        worldHeight,
        events: app.renderer.events,
      });

      // Enable interactions based on props
      if (drag) viewport.drag();
      if (pinch) viewport.pinch();
      if (wheel) viewport.wheel({ smooth: wheelSmooth });
      if (decelerate) viewport.decelerate({ friction: decelerateFriction });

      // Set zoom limits
      viewport.clampZoom({
        minScale,
        maxScale,
      });

      // Create a container for nodes (this is where React children will be rendered)
      const nodesContainer = new Container();
      nodesContainer.label = 'nodes-container';
      viewport.addChild(nodesContainer);

      // Add viewport to stage
      app.stage.addChild(viewport);

      // Store references
      viewportRef.current = viewport;
      nodesContainerRef.current = nodesContainer;

      // Listen to viewport events
      viewport.on('moved', handleMoved);
      viewport.on('zoomed', handleZoomed);

      // Notify parent that viewport is ready
      if (onViewportReadyRef.current) {
        onViewportReadyRef.current(viewport);
      }

      // Handle resize
      const handleResize = () => {
        if (containerElement && viewport) {
          const { clientWidth, clientHeight } = containerElement;
          app.renderer.resize(clientWidth, clientHeight);
          viewport.resize(clientWidth, clientHeight);
        }
      };

      window.addEventListener('resize', handleResize);

      // Cleanup
      return () => {
        viewport.off('moved', handleMoved);
        viewport.off('zoomed', handleZoomed);
        window.removeEventListener('resize', handleResize);

        if (viewport.parent) {
          viewport.parent.removeChild(viewport);
        }
        viewport.destroy({ children: true });

        viewportRef.current = null;
        nodesContainerRef.current = null;
      };
    }, [
      app,
      worldWidth,
      worldHeight,
      minScale,
      maxScale,
      drag,
      pinch,
      wheel,
      wheelSmooth,
      decelerate,
      decelerateFriction,
      containerElement,
      handleMoved,
      handleZoomed,
    ]);

    // Update viewport size when screenWidth/screenHeight props change
    // This prevents recreating the entire viewport on resize
    useEffect(() => {
      if (!viewportRef.current || !app) return;

      const width = screenWidth || containerElement?.clientWidth || 800;
      const height = screenHeight || containerElement?.clientHeight || 600;

      // Only resize if dimensions have actually changed
      const currentWidth = viewportRef.current.screenWidth;
      const currentHeight = viewportRef.current.screenHeight;

      if (currentWidth !== width || currentHeight !== height) {
        app.renderer.resize(width, height);
        viewportRef.current.resize(width, height);
      }
    }, [screenWidth, screenHeight, containerElement, app]);

    // We don't render React children directly here since pixi-viewport
    // doesn't integrate with @pixi/react's reconciler.
    // Children are handled by the parent PixiCanvas component.
    return null;
  }
);

ViewportInner.displayName = 'ViewportInner';

/**
 * PixiViewport - A declarative viewport component for @pixi/react
 *
 * This component creates a pixi-viewport instance and provides it via ref.
 * Use the ref to access the viewport and nodesContainer for adding children.
 *
 * @example
 * ```tsx
 * const viewportRef = useRef<PixiViewportRef>(null);
 *
 * <PixiApplication>
 *   <PixiViewport
 *     ref={viewportRef}
 *     onMoved={handleMoved}
 *     onZoomed={handleZoomed}
 *   />
 * </PixiApplication>
 * ```
 */
export const PixiViewport = forwardRef<
  PixiViewportRef,
  PixiViewportProps & { containerElement?: HTMLElement | null }
>((props, ref) => {
  return <ViewportInner {...props} containerElement={props.containerElement || null} ref={ref} />;
});

PixiViewport.displayName = 'PixiViewport';

export default PixiViewport;

