/**
 * SkiaViewport Component
 *
 * A React component that provides pan/zoom functionality for CanvasKit canvas.
 * Mirrors the behavior of PixiViewport for consistent Figma coordinate system.
 */

import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useCallback,
} from 'react';
import type { CanvasKit, Surface, Canvas } from 'canvaskit-wasm';

export interface ViewportState {
    /** Translation X (screen space) */
    x: number;
    /** Translation Y (screen space) */
    y: number;
    /** Zoom scale factor */
    scale: number;
}

export interface SkiaViewportProps {
    /** CanvasKit instance */
    canvasKit: CanvasKit;
    /** Width of the viewport screen */
    screenWidth: number;
    /** Height of the viewport screen */
    screenHeight: number;
    /** Minimum zoom scale */
    minScale?: number;
    /** Maximum zoom scale */
    maxScale?: number;
    /** Enable drag interaction */
    drag?: boolean;
    /** Enable mouse wheel zoom */
    wheel?: boolean;
    /** Called when viewport is moved (pan) */
    onMoved?: (state: ViewportState) => void;
    /** Called when viewport is zoomed */
    onZoomed?: (state: ViewportState) => void;
    /** Called when viewport is ready */
    onViewportReady?: (ref: SkiaViewportRef) => void;
    /** Render callback - called each frame with the canvas */
    onRender?: (canvas: Canvas, viewportState: ViewportState) => void;
}

export interface SkiaViewportRef {
    /** Get current viewport state */
    getViewport: () => ViewportState;
    /** Set viewport position and zoom */
    setViewport: (x: number, y: number, scale: number) => void;
    /** Request a redraw */
    requestDraw: () => void;
    /** Get the canvas element */
    getCanvasElement: () => HTMLCanvasElement | null;
    /** Get the CanvasKit surface */
    getSurface: () => Surface | null;
}

/**
 * SkiaViewport - Pan/zoom viewport for CanvasKit canvas
 */
export const SkiaViewport = forwardRef<SkiaViewportRef, SkiaViewportProps>(
    (
        {
            canvasKit,
            screenWidth,
            screenHeight,
            minScale = 0.02,
            maxScale = 256,
            drag = true,
            wheel = true,
            onMoved,
            onZoomed,
            onViewportReady,
            onRender,
        },
        ref
    ) => {
        const canvasRef = useRef<HTMLCanvasElement>(null);
        const surfaceRef = useRef<Surface | null>(null);
        const viewportStateRef = useRef<ViewportState>({ x: 0, y: 0, scale: 1 });
        const isDraggingRef = useRef(false);
        const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
        const animationFrameRef = useRef<number | null>(null);
        const needsRedrawRef = useRef(true);

        // Stable callback refs
        const onMovedRef = useRef(onMoved);
        const onZoomedRef = useRef(onZoomed);
        const onRenderRef = useRef(onRender);

        useEffect(() => {
            onMovedRef.current = onMoved;
        }, [onMoved]);

        useEffect(() => {
            onZoomedRef.current = onZoomed;
        }, [onZoomed]);

        useEffect(() => {
            onRenderRef.current = onRender;
        }, [onRender]);

        // Request a redraw
        const requestDraw = useCallback(() => {
            needsRedrawRef.current = true;
        }, []);

        // Draw function
        const draw = useCallback(() => {
            if (!surfaceRef.current || !needsRedrawRef.current) return;

            const surface = surfaceRef.current;
            const canvas = surface.getCanvas();
            const state = viewportStateRef.current;

            // Clear canvas
            canvas.clear(canvasKit.BLACK);

            // Save state before applying viewport transform
            canvas.save();

            // Apply viewport transformation (pan + zoom)
            // This matches Figma's coordinate system: origin top-left, Y-axis down
            canvas.translate(state.x, state.y);
            canvas.scale(state.scale, state.scale);

            // Call render callback
            if (onRenderRef.current) {
                onRenderRef.current(canvas, state);
            }

            // Restore state
            canvas.restore();

            // Flush to screen
            surface.flush();
            needsRedrawRef.current = false;
        }, [canvasKit]);

        // Animation loop
        useEffect(() => {
            const animate = () => {
                draw();
                animationFrameRef.current = requestAnimationFrame(animate);
            };

            animationFrameRef.current = requestAnimationFrame(animate);

            return () => {
                if (animationFrameRef.current) {
                    cancelAnimationFrame(animationFrameRef.current);
                }
            };
        }, [draw]);

        // Initialize surface
        useEffect(() => {
            if (!canvasRef.current || !canvasKit) return;

            const canvas = canvasRef.current;

            // Set canvas size with device pixel ratio for crisp rendering
            const dpr = window.devicePixelRatio || 1;
            canvas.width = screenWidth * dpr;
            canvas.height = screenHeight * dpr;
            canvas.style.width = `${screenWidth}px`;
            canvas.style.height = `${screenHeight}px`;

            // Create CanvasKit surface
            const surface = canvasKit.MakeWebGLCanvasSurface(canvas);
            if (!surface) {
                console.error('[SkiaViewport] Failed to create WebGL surface');
                return;
            }

            surfaceRef.current = surface;
            needsRedrawRef.current = true;

            return () => {
                surface.delete();
                surfaceRef.current = null;
            };
        }, [canvasKit, screenWidth, screenHeight]);

        // Expose ref methods
        useImperativeHandle(
            ref,
            () => ({
                getViewport: () => ({ ...viewportStateRef.current }),
                setViewport: (x: number, y: number, scale: number) => {
                    viewportStateRef.current = { x, y, scale };
                    needsRedrawRef.current = true;
                },
                requestDraw,
                getCanvasElement: () => canvasRef.current,
                getSurface: () => surfaceRef.current,
            }),
            [requestDraw]
        );

        // Notify when ready
        useEffect(() => {
            if (surfaceRef.current && onViewportReady) {
                const refObj: SkiaViewportRef = {
                    getViewport: () => ({ ...viewportStateRef.current }),
                    setViewport: (x: number, y: number, scale: number) => {
                        viewportStateRef.current = { x, y, scale };
                        needsRedrawRef.current = true;
                    },
                    requestDraw,
                    getCanvasElement: () => canvasRef.current,
                    getSurface: () => surfaceRef.current,
                };
                onViewportReady(refObj);
            }
        }, [surfaceRef.current, onViewportReady, requestDraw]);

        // Mouse wheel zoom handler
        const handleWheel = useCallback(
            (e: WheelEvent) => {
                if (!wheel) return;
                e.preventDefault();

                const state = viewportStateRef.current;
                const rect = canvasRef.current?.getBoundingClientRect();
                if (!rect) return;

                // Mouse position relative to canvas
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                // Calculate zoom factor
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                let newScale = state.scale * zoomFactor;

                // Clamp scale
                newScale = Math.max(minScale, Math.min(maxScale, newScale));

                // Calculate new position to zoom towards mouse position
                // Formula: newPos = mousePos - (mousePos - oldPos) * (newScale / oldScale)
                const scaleRatio = newScale / state.scale;
                const newX = mouseX - (mouseX - state.x) * scaleRatio;
                const newY = mouseY - (mouseY - state.y) * scaleRatio;

                viewportStateRef.current = { x: newX, y: newY, scale: newScale };
                needsRedrawRef.current = true;

                if (onZoomedRef.current) {
                    onZoomedRef.current(viewportStateRef.current);
                }
            },
            [wheel, minScale, maxScale]
        );

        // Mouse drag handlers
        const handleMouseDown = useCallback(
            (e: React.MouseEvent) => {
                if (!drag) return;
                isDraggingRef.current = true;
                lastMousePosRef.current = { x: e.clientX, y: e.clientY };
            },
            [drag]
        );

        const handleMouseMove = useCallback(
            (e: React.MouseEvent) => {
                if (!drag || !isDraggingRef.current || !lastMousePosRef.current) return;

                const deltaX = e.clientX - lastMousePosRef.current.x;
                const deltaY = e.clientY - lastMousePosRef.current.y;

                const state = viewportStateRef.current;
                viewportStateRef.current = {
                    x: state.x + deltaX,
                    y: state.y + deltaY,
                    scale: state.scale,
                };

                lastMousePosRef.current = { x: e.clientX, y: e.clientY };
                needsRedrawRef.current = true;

                if (onMovedRef.current) {
                    onMovedRef.current(viewportStateRef.current);
                }
            },
            [drag]
        );

        const handleMouseUp = useCallback(() => {
            isDraggingRef.current = false;
            lastMousePosRef.current = null;
        }, []);

        const handleMouseLeave = useCallback(() => {
            isDraggingRef.current = false;
            lastMousePosRef.current = null;
        }, []);

        // Attach wheel listener (needs passive: false for preventDefault)
        useEffect(() => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            canvas.addEventListener('wheel', handleWheel, { passive: false });

            return () => {
                canvas.removeEventListener('wheel', handleWheel);
            };
        }, [handleWheel]);

        return (
            <canvas
                ref={canvasRef}
                style={{
                    width: screenWidth,
                    height: screenHeight,
                    display: 'block',
                    cursor: isDraggingRef.current ? 'grabbing' : 'grab',
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            />
        );
    }
);

SkiaViewport.displayName = 'SkiaViewport';

export default SkiaViewport;

