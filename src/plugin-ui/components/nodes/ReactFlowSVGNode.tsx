import { memo, useMemo, useRef, useEffect } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle as HandleComponent, Position as PositionEnum } from '@xyflow/react';
import type { SVGNodeType } from "./node.types";
import {
    parseSVGToElement,
    convertSVGToString,
} from "@utils/figmaStyleConversions.tsx";
import { useLazySVG } from "@/plugin-ui/hooks/useLazySVG";
import { SpinnerOverlay } from "@ui/spinner";

/**
 * React Flow SVG Node Component
 * 
 * A memoized React component that renders a Figma vector/geometry node 
 * (BooleanOperationNode, LineNode, PolygonNode, RectangleNode, VectorNode) as a React Flow node.
 * SVG nodes are always rendered as SVG for accurate vector graphics display.
 * 
 * @param props - NodeProps containing node data and dimensions
 * @returns A node component with handles for connections
 */
export const ReactFlowSVGNode = memo((props: NodeProps<SVGNodeType>) => {
    const { id, data, width, height, positionAbsoluteX, positionAbsoluteY, parentId } = props;
    const svgContainerRef = useRef<HTMLDivElement>(null);

    // Parse SVG element if available
    const svgElement = useMemo(() => {
        if (data?.svgElement) {
            return data.svgElement;
        }
        if (data?.svg) {
            return parseSVGToElement(data.svg);
        }
        return null;
    }, [data?.svg, data?.svgElement]);

    // Convert SVG to string for rendering
    const svgString = useMemo(() => {
        if (data?.svg) {
            return convertSVGToString(data.svg);
        }
        return null;
    }, [data?.svg]);

    // Render SVG element into container
    useEffect(() => {
        if (!svgContainerRef.current) return;

        // Clear existing content first
        svgContainerRef.current.innerHTML = '';

        // Handle SVG rendering: prefer svgElement, fallback to parsing svgString
        let elementToRender: SVGElement | null = null;

        if (svgElement) {
            // Use the already parsed SVG element
            elementToRender = svgElement;
        } else if (svgString) {
            // Parse the SVG string to an element (svgString is already converted from data.svg)
            const parsed = parseSVGToElement(svgString);
            if (parsed) {
                elementToRender = parsed;
            }
        }

        if (elementToRender) {
            // Clone and append SVG element
            const clonedSvg = elementToRender.cloneNode(true) as SVGElement;
            // Ensure SVG scales to container
            clonedSvg.setAttribute('width', '100%');
            clonedSvg.setAttribute('height', '100%');
            clonedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            svgContainerRef.current.appendChild(clonedSvg);
        }
    }, [svgElement, svgString]);

    // Basic properties
    const rotation = data?.rotation ?? 0;
    const label = data?.label ?? '';
    const name = data?.name ?? label;
    const nodeType = data?.nodeType ?? 'VECTOR';

    console.log(`[ReactFlowSVGNode] Rendering ${nodeType} node "${label}" at position:`, {
        x: positionAbsoluteX,
        y: positionAbsoluteY,
        label,
        name,
        nodeType,
        rotation,
        width: width,
        height: height,
        hasSvg: !!svgElement || !!svgString,
        parentId,
    });

    // Determine rendering mode
    // SVG nodes always use 'svg' mode (set by FigmaImplementation during tree traversal)
    // Children of SVG nodes will have 'bounding-box' mode
    const renderMode = data?.renderMode || 'svg';

    // Check if node has SVG
    const hasSVG = !!(svgElement || svgString);

    // Lazy load SVG if needed
    const { isLoading: isLoadingSVG } = useLazySVG(id, renderMode, hasSVG);

    // Handle bounding-box mode (children of SVG nodes)
    if (renderMode === 'bounding-box') {
        return (
            <div
                className="border border-transparent transition-colors duration-200 hover:border-blue-500"
                style={{
                    width: width,
                    height: height,
                    transform: `rotate(${rotation}deg)`,
                }}
                data-fill-style-id={typeof data?.fillStyleId === 'string' ? data.fillStyleId : undefined}
                data-stroke-style-id={data?.strokeStyleId}
                data-effect-style-id={data?.effectStyleId}
                data-render-mode="bounding-box"
            >
                <HandleComponent
                    type="target"
                    position={PositionEnum.Top}
                    style={{ opacity: 0 }}
                />
                <HandleComponent
                    type="source"
                    position={PositionEnum.Bottom}
                    style={{ opacity: 0 }}
                />
            </div>
        );
    }

    // SVG rendering mode (only mode for SVG nodes themselves)
    // SVG nodes are always rendered as SVG - no CSS fallback
    return (
        <div
            style={{
                width: width,
                height: height,
                transform: `rotate(${rotation}deg)`,
                position: 'relative',
            }}
            data-fill-style-id={typeof data?.fillStyleId === 'string' ? data.fillStyleId : undefined}
            data-stroke-style-id={data?.strokeStyleId}
            data-effect-style-id={data?.effectStyleId}
            data-render-mode="svg"
        >
            {(svgElement || svgString) && (
                <div
                    ref={svgContainerRef}
                    style={{
                        width: '100%',
                        height: '100%',
                    }}
                />
            )}
            {isLoadingSVG && <SpinnerOverlay />}
            <HandleComponent
                type="target"
                position={PositionEnum.Top}
                style={{ opacity: 0 }}
            />
            <HandleComponent
                type="source"
                position={PositionEnum.Bottom}
                style={{ opacity: 0 }}
            />
        </div>
    );
});

ReactFlowSVGNode.displayName = 'ReactFlowSVGNode';

