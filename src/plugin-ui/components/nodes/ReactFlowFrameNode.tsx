import { memo, useMemo, useRef, useEffect } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle as HandleComponent, Position as PositionEnum } from '@xyflow/react';
import type { ReactFlowFrameNodeType } from "./node.types";
import {
  parseSVGToElement,
  convertSVGToString,
  convertFrameNodeToCSS,
} from "@utils/figmaStyleConversions.tsx";

/**
 * React Flow Frame Node Component
 * 
 * A memoized React component that renders a Figma frame, component, or component set as a React Flow node.
 * Only applies width, height, and rotation styling since SVGs contain all necessary visual styles.
 * 
 * @param props - NodeProps containing node data and dimensions
 * @returns A minimal node component with handles for connections
 */
export const ReactFlowFrameNode = memo((props: NodeProps<ReactFlowFrameNodeType>) => {
  const { data, width = 150, positionAbsoluteX, positionAbsoluteY, parentId } = props;
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
  const nodeType = data?.nodeType ?? 'FRAME';

  // Dimensions
  const nodeWidth = data?.width ?? width;
  const nodeHeight = data?.height;

  console.log(`[ReactFlowFrameNode] Rendering ${nodeType} node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
    name,
    nodeType,
    rotation,
    width: nodeWidth,
    height: nodeHeight,
    hasSvg: !!svgElement || !!svgString,
    parentId,
  });

  // Determine rendering mode
  // Use explicit renderMode if set (set by FigmaImplementation during tree traversal)
  // Default to 'css' if not set (shouldn't happen after tree traversal)
  const renderMode = data?.renderMode || 'css';

  // Handle bounding-box mode (descendants of SVG nodes)
  if (renderMode === 'bounding-box') {
    return (
      <div
        className="border border-transparent transition-colors duration-200 hover:border-blue-500"
        style={{
          width: nodeWidth,
          height: nodeHeight,
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

  // Handle SVG rendering mode
  if (renderMode === 'svg' && (svgElement || svgString)) {
    return (
      <div
        style={{
          width: nodeWidth,
          height: nodeHeight,
          transform: `rotate(${rotation}deg)`,
        }}
        data-render-mode="svg"
      >
        <div
          ref={svgContainerRef}
          style={{
            width: '100%',
            height: '100%',
          }}
        />
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

  // Handle CSS rendering mode
  if (renderMode === 'css') {
    const cssStyles = convertFrameNodeToCSS(data);
    return (
      <div
        style={cssStyles}
        data-fill-style-id={typeof data?.fillStyleId === 'string' ? data.fillStyleId : undefined}
        data-stroke-style-id={data?.strokeStyleId}
        data-effect-style-id={data?.effectStyleId}
        data-render-mode="css"
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


});

ReactFlowFrameNode.displayName = 'ReactFlowFrameNode';
