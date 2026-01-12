/**
 * CanvasOverlay Component
 *
 * A transparent DOM overlay layer that sits on top of the Skia canvas
 * to enable DOM-based interactions (hover, click) on rendered nodes.
 * Uses DOM divs positioned based on viewport state with viewport culling.
 */

import React, { useCallback, useRef, useState, useMemo } from 'react';
import type { ViewportState } from './SkiaViewport';
import { nodeManager } from '@/plugin-ui/stores/NodeManager';
import type { DesignNode } from '@shared-types/types';
import type { AbsoluteNode } from '@/plugin-ui/utils/nodeRendererUtils';

interface CanvasOverlayProps {
    /** Current viewport state (pan/zoom) */
    viewport: ViewportState;
    /** Width of the overlay in pixels */
    width: number;
    /** Height of the overlay in pixels */
    height: number;
    /** Callback when a node is clicked */
    onNodeClick?: (node: DesignNode) => void;
    /** Callback when a node is hovered (null when hover leaves) */
    onNodeHover?: (node: DesignNode | null) => void;
}

export const CanvasOverlay: React.FC<CanvasOverlayProps> = ({
    viewport,
    width,
    height,
    onNodeClick,
    onNodeHover,
}) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const isDraggingRef = useRef(false);
    const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

    // Calculate viewport bounds in canvas coordinates
    const viewportBounds = useMemo(() => {
        const viewportLeft = -viewport.x / viewport.scale;
        const viewportTop = -viewport.y / viewport.scale;
        const viewportRight = viewportLeft + width / viewport.scale;
        const viewportBottom = viewportTop + height / viewport.scale;
        return { viewportLeft, viewportTop, viewportRight, viewportBottom };
    }, [viewport, width, height]);

    // Get visible nodes using NodeManager
    const visibleNodes = useMemo(() => {
        return nodeManager.getNodesInViewport(
            viewportBounds.viewportLeft,
            viewportBounds.viewportTop,
            viewportBounds.viewportRight,
            viewportBounds.viewportBottom
        );
    }, [viewportBounds]);

    // Get absolute positions for visible nodes
    const visibleAbsoluteNodes = useMemo(() => {
        return visibleNodes
            .map((node) => nodeManager.getAbsoluteNode(node.id))
            .filter((node): node is AbsoluteNode => node !== undefined);
    }, [visibleNodes]);

    // Handle mouse down - detect if this is a drag start
    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!overlayRef.current) return;
        const rect = overlayRef.current.getBoundingClientRect();
        mouseDownPosRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
        isDraggingRef.current = false;
    }, []);

    // Handle mouse move - check if this is a drag
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!overlayRef.current || !mouseDownPosRef.current) return;

        const rect = overlayRef.current.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;
        const deltaX = Math.abs(currentX - mouseDownPosRef.current.x);
        const deltaY = Math.abs(currentY - mouseDownPosRef.current.y);

        // If mouse moved more than 5px, consider it a drag
        if (deltaX > 5 || deltaY > 5) {
            isDraggingRef.current = true;
        }
    }, []);

    // Handle mouse enter - update hover state
    const handleMouseEnter = useCallback(
        (nodeId: string) => {
            if (!isDraggingRef.current && hoveredNodeId !== nodeId) {
                setHoveredNodeId(nodeId);
                const node = nodeManager.getNode(nodeId);
                if (node && onNodeHover) {
                    onNodeHover(node);
                }
            }
        },
        [hoveredNodeId, onNodeHover]
    );

    // Handle mouse leave - clear hover state
    const handleMouseLeave = useCallback(() => {
        if (hoveredNodeId !== null) {
            setHoveredNodeId(null);
            if (onNodeHover) {
                onNodeHover(null);
            }
        }
    }, [hoveredNodeId, onNodeHover]);

    // Handle click - fire callback if not dragging
    const handleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>, nodeId: string) => {
            if (!onNodeClick || isDraggingRef.current) {
                e.stopPropagation();
                return;
            }
            e.stopPropagation();
            const node = nodeManager.getNode(nodeId);
            if (node) {
                onNodeClick(node);
            }
        },
        [onNodeClick]
    );

    // Handle mouse up - reset drag state
    const handleMouseUp = useCallback(() => {
        mouseDownPosRef.current = null;
        isDraggingRef.current = false;
    }, []);

    // Handle overlay mouse leave - clear hover
    const handleOverlayMouseLeave = useCallback(() => {
        mouseDownPosRef.current = null;
        isDraggingRef.current = false;
        handleMouseLeave();
    }, [handleMouseLeave]);


    // Calculate screen position for a node
    const getNodeScreenPosition = useCallback(
        (absoluteNode: AbsoluteNode) => {
            const screenX = absoluteNode.absoluteX * viewport.scale + viewport.x;
            const screenY = absoluteNode.absoluteY * viewport.scale + viewport.y;
            const screenWidth = absoluteNode.width * viewport.scale;
            const screenHeight = absoluteNode.height * viewport.scale;
            return { screenX, screenY, screenWidth, screenHeight };
        },
        [viewport]
    );

    return (
        <div
            ref={overlayRef}
            className="absolute inset-0"
            style={{
                width: `${width}px`,
                height: `${height}px`,
                pointerEvents: 'none', // Don't capture events by default - let them pass through to canvas
            }}
            onMouseLeave={handleOverlayMouseLeave}
            onMouseUp={handleMouseUp}
        >
            {/* Render divs for each visible node */}
            {visibleAbsoluteNodes.map((absoluteNode) => {
                const { screenX, screenY, screenWidth, screenHeight } =
                    getNodeScreenPosition(absoluteNode);
                const isHovered = hoveredNodeId === absoluteNode.id;

                return (
                    <div
                        key={absoluteNode.id}
                        style={{
                            position: 'absolute',
                            left: `${screenX}px`,
                            top: `${screenY}px`,
                            width: `${screenWidth}px`,
                            height: `${screenHeight}px`,
                            pointerEvents: 'auto',
                            cursor: 'pointer',
                            border: isHovered
                                ? `2px solid #0096FF`
                                : '2px solid transparent',
                            boxSizing: 'border-box',
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseEnter={() => handleMouseEnter(absoluteNode.id)}
                        onMouseLeave={handleMouseLeave}
                        onClick={(e) => handleClick(e, absoluteNode.id)}
                    />
                );
            })}
        </div>
    );
};

export default CanvasOverlay;
